#!/usr/bin/env python3
"""Migrate the live SQLite relay state to Cloudflare D1 and R2.

The source remains opaque: ciphertext is streamed directly to R2 and is never
written to logs or SQL files. Run ``stage`` while the old service is live, then
run ``finalize`` after stopping it and before routing traffic to Workers.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


MIGRATION_META_KEY = "cloudflare-sqlite-migration-v1"
VAPID_META_KEY = "vapid-key-pair-v1"
BASE64URL = re.compile(r"^[A-Za-z0-9_-]+$")
MIGRATED_R2_KEY = re.compile(r"^v1/[a-f0-9]{64}/[a-f0-9]{64}$")
MARKER_COUNT_KEYS = {
    "accounts",
    "active",
    "activeBytes",
    "deleted",
    "deletedBytes",
    "quotas",
    "pushDevices",
    "wakes",
    "wakeRevisions",
    "deliveries",
}


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Envelope:
    account_id: str
    slot: str
    envelope_id: str
    ciphertext: str
    seq: int | None
    deleted_at: int | None

    @property
    def kind(self) -> str:
        return "deleted" if self.deleted_at is not None else "active"

    @property
    def r2_key(self) -> str:
        account = hashlib.sha256(self.account_id.encode()).hexdigest()
        identity = "\0".join(("sqlite-migration-v1", self.kind, self.slot, self.envelope_id))
        object_id = hashlib.sha256(identity.encode()).hexdigest()
        return f"v1/{account}/{object_id}"

    @property
    def ciphertext_bytes(self) -> int:
        return len(self.ciphertext)


@dataclass(frozen=True)
class Snapshot:
    accounts: list[sqlite3.Row]
    envelopes: list[Envelope]
    quotas: list[sqlite3.Row]
    push_devices: list[sqlite3.Row]
    wakes: list[sqlite3.Row]
    wake_revisions: list[tuple[str, int]]
    deliveries: list[sqlite3.Row]
    vapid_pair: str | None
    digest: str


def fail(message: str) -> None:
    raise MigrationError(message)


def require_columns(db: sqlite3.Connection, table: str, expected: set[str]) -> None:
    actual = {str(row[1]) for row in db.execute(f"PRAGMA table_info({table})")}
    missing = expected - actual
    if missing:
        fail(f"Source table {table} is missing required columns: {', '.join(sorted(missing))}")


def snapshot_database(source: Path, destination: Path) -> None:
    if not source.is_file():
        fail(f"Source database does not exist: {source}")
    source_db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    destination_db = sqlite3.connect(destination)
    try:
        source_db.backup(destination_db)
    finally:
        destination_db.close()
        source_db.close()


def stable_digest(rows: Iterable[Sequence[object]]) -> str:
    digest = hashlib.sha256()
    for row in rows:
        encoded = json.dumps(list(row), ensure_ascii=False, separators=(",", ":")).encode()
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def load_snapshot(path: Path) -> Snapshot:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            fail("Source SQLite integrity check failed")

        required = {
            "accounts": {
                "account_id", "credential_hash", "next_seq", "updated_at", "envelope_count",
                "ciphertext_bytes", "last_seen_at", "wake_revision",
            },
            "envelopes": {"account_id", "slot", "seq", "id", "ciphertext"},
            "deleted_envelopes": {"account_id", "slot", "id", "ciphertext", "deleted_at"},
            "account_quotas": {"account_id", "max_bytes"},
            "meta": {"key", "value"},
            "reminder_push_devices": {
                "account_id", "device_id", "endpoint", "p256dh", "auth", "updated_at",
            },
            "reminder_wakes_v2": {"account_id", "wake_id", "fire_at"},
            "reminder_wake_deliveries": {
                "account_id", "device_id", "wake_id", "claimed_at", "delivered_at",
            },
        }
        for table, columns in required.items():
            require_columns(db, table, columns)

        accounts = list(db.execute("SELECT * FROM accounts ORDER BY account_id"))
        active = [
            Envelope(row["account_id"], row["slot"], row["id"], row["ciphertext"], row["seq"], None)
            for row in db.execute("SELECT * FROM envelopes ORDER BY account_id, slot")
        ]
        deleted = [
            Envelope(
                row["account_id"], row["slot"], row["id"], row["ciphertext"], None,
                row["deleted_at"],
            )
            for row in db.execute("SELECT * FROM deleted_envelopes ORDER BY account_id, slot")
        ]
        envelopes = active + deleted
        quotas = list(db.execute("SELECT * FROM account_quotas ORDER BY account_id"))
        push_devices = list(
            db.execute("SELECT * FROM reminder_push_devices ORDER BY account_id, device_id")
        )
        wakes = list(db.execute("SELECT * FROM reminder_wakes_v2 ORDER BY account_id, wake_id"))
        deliveries = list(
            db.execute(
                "SELECT * FROM reminder_wake_deliveries ORDER BY account_id, device_id, wake_id"
            )
        )
        wake_revisions = [
            (row["account_id"], int(row["wake_revision"]))
            for row in accounts
            if int(row["wake_revision"]) != 0
        ]

        account_ids = {str(row["account_id"]) for row in accounts}
        for envelope in envelopes:
            if envelope.account_id not in account_ids:
                fail("Source contains an envelope without an account")
            if not envelope.ciphertext or not BASE64URL.fullmatch(envelope.ciphertext):
                fail("Source contains invalid envelope ciphertext")
        for rows, label in (
            (quotas, "quota"), (push_devices, "push device"), (wakes, "reminder wake"),
            (deliveries, "wake delivery"),
        ):
            if any(str(row["account_id"]) not in account_ids for row in rows):
                fail(f"Source contains a {label} without an account")

        by_account: dict[str, tuple[int, int]] = {}
        for envelope in active:
            count, size = by_account.get(envelope.account_id, (0, 0))
            by_account[envelope.account_id] = count + 1, size + envelope.ciphertext_bytes
        for account in accounts:
            expected_count, expected_size = by_account.get(str(account["account_id"]), (0, 0))
            if int(account["envelope_count"]) != expected_count:
                fail("Source account envelope counters are inconsistent")
            if int(account["ciphertext_bytes"]) != expected_size:
                fail("Source account byte counters are inconsistent")

        meta = {str(row["key"]): str(row["value"]) for row in db.execute("SELECT key,value FROM meta")}
        public_key = meta.get("vapid-public-v1")
        private_key = meta.get("vapid-private-v1")
        if bool(public_key) != bool(private_key):
            fail("Source has only one of the two VAPID keys")
        vapid_pair = (
            json.dumps({"publicKey": public_key, "privateKey": private_key}, separators=(",", ":"))
            if public_key and private_key
            else None
        )
        if push_devices and vapid_pair is None:
            fail("Source has registered push devices but no VAPID key pair")

        digest_rows: list[Sequence[object]] = []
        for table_rows in (accounts, quotas, push_devices, wakes, deliveries):
            digest_rows.extend(tuple(row) for row in table_rows)
        digest_rows.extend(
            (item.kind, item.account_id, item.slot, item.envelope_id, item.seq, item.deleted_at,
             item.ciphertext)
            for item in envelopes
        )
        digest_rows.extend(wake_revisions)
        if vapid_pair is not None:
            digest_rows.append((VAPID_META_KEY, vapid_pair))

        return Snapshot(
            accounts, envelopes, quotas, push_devices, wakes, wake_revisions, deliveries,
            vapid_pair, stable_digest(digest_rows),
        )
    finally:
        db.close()


def sql_text(value: str) -> str:
    if "\0" in value:
        fail("Source contains a NUL character that cannot be represented in D1 SQL")
    return "'" + value.replace("'", "''") + "'"


def sql_value(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return sql_text(value)
    fail(f"Unsupported SQL value type: {type(value).__name__}")
    raise AssertionError


def insert(table: str, columns: Sequence[str], values: Sequence[object]) -> str:
    encoded = ",".join(sql_value(value) for value in values)
    return f"INSERT INTO {table}({','.join(columns)}) VALUES({encoded});"


def migration_sql(snapshot: Snapshot, state: str) -> str:
    statements = [
        "PRAGMA defer_foreign_keys=TRUE;",
        "DELETE FROM reminder_wake_deliveries;",
        "DELETE FROM reminder_wakes;",
        "DELETE FROM reminder_wake_revisions;",
        "DELETE FROM reminder_push_devices;",
        "DELETE FROM pending_envelopes;",
        "DELETE FROM deleted_envelopes;",
        "DELETE FROM envelopes;",
        "DELETE FROM account_quotas;",
        "DELETE FROM accounts;",
        f"DELETE FROM meta WHERE key IN ({sql_text(MIGRATION_META_KEY)},{sql_text(VAPID_META_KEY)});",
    ]
    for row in snapshot.accounts:
        statements.append(
            insert(
                "accounts",
                ("account_id", "credential_hash", "next_seq", "envelope_count",
                 "ciphertext_bytes", "updated_at", "last_seen_at"),
                (row["account_id"], row["credential_hash"], row["next_seq"],
                 row["envelope_count"], row["ciphertext_bytes"], row["updated_at"],
                 row["last_seen_at"]),
            )
        )
    for envelope in snapshot.envelopes:
        if envelope.deleted_at is None:
            statements.append(
                insert(
                    "envelopes",
                    ("account_id", "slot", "seq", "id", "r2_key", "ciphertext_bytes"),
                    (envelope.account_id, envelope.slot, envelope.seq, envelope.envelope_id,
                     envelope.r2_key, envelope.ciphertext_bytes),
                )
            )
        else:
            statements.append(
                insert(
                    "deleted_envelopes",
                    ("account_id", "slot", "id", "r2_key", "ciphertext_bytes", "deleted_at"),
                    (envelope.account_id, envelope.slot, envelope.envelope_id, envelope.r2_key,
                     envelope.ciphertext_bytes, envelope.deleted_at),
                )
            )
    for row in snapshot.quotas:
        statements.append(insert("account_quotas", ("account_id", "max_bytes"), tuple(row)))
    for row in snapshot.push_devices:
        statements.append(
            insert(
                "reminder_push_devices",
                ("account_id", "device_id", "endpoint", "p256dh", "auth", "updated_at"),
                tuple(row),
            )
        )
    for row in snapshot.wakes:
        statements.append(
            insert("reminder_wakes", ("account_id", "wake_id", "fire_at"), tuple(row))
        )
    for row in snapshot.wake_revisions:
        statements.append(
            insert("reminder_wake_revisions", ("account_id", "revision"), row)
        )
    for row in snapshot.deliveries:
        statements.append(
            insert(
                "reminder_wake_deliveries",
                ("account_id", "device_id", "wake_id", "claimed_at", "delivered_at"),
                tuple(row),
            )
        )
    if snapshot.vapid_pair is not None:
        statements.append(insert("meta", ("key", "value"), (VAPID_META_KEY, snapshot.vapid_pair)))
    active = [item for item in snapshot.envelopes if item.deleted_at is None]
    deleted = [item for item in snapshot.envelopes if item.deleted_at is not None]
    marker = json.dumps(
        {
            "version": 1,
            "state": state,
            "sourceDigest": snapshot.digest,
            "writtenAt": int(time.time()),
            "counts": {
                "accounts": len(snapshot.accounts),
                "active": len(active),
                "activeBytes": sum(item.ciphertext_bytes for item in active),
                "deleted": len(deleted),
                "deletedBytes": sum(item.ciphertext_bytes for item in deleted),
                "quotas": len(snapshot.quotas),
                "pushDevices": len(snapshot.push_devices),
                "wakes": len(snapshot.wakes),
                "wakeRevisions": len(snapshot.wake_revisions),
                "deliveries": len(snapshot.deliveries),
            },
        },
        separators=(",", ":"),
    )
    statements.append(insert("meta", ("key", "value"), (MIGRATION_META_KEY, marker)))
    return "\n".join(statements) + "\n"


def wrangler_args(args: argparse.Namespace) -> list[str]:
    return ["--env", args.env] if args.env else []


def run_quiet(command: Sequence[str], *, stdin: bytes | None = None) -> None:
    result = subprocess.run(
        command,
        input=stdin,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        env={**os.environ, "CI": "true"},
    )
    if result.returncode != 0:
        fail("A Cloudflare command failed; rerun with Wrangler directly for diagnostic output")


def d1_json(args: argparse.Namespace, command: str) -> list[dict[str, object]]:
    invocation = [
        "npx", "wrangler", "d1", "execute", args.database, "--remote", "--json",
        "--command", command, *wrangler_args(args),
    ]
    result = subprocess.run(invocation, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail("Cloudflare D1 query failed")
    try:
        payload = json.loads(result.stdout)
        blocks = payload if isinstance(payload, list) else [payload]
        rows: list[dict[str, object]] = []
        for block in blocks:
            if isinstance(block, dict):
                result_block = block.get("results") or block.get("result") or []
                if isinstance(result_block, list):
                    rows.extend(item for item in result_block if isinstance(item, dict))
        return rows
    except json.JSONDecodeError as error:
        raise MigrationError("Cloudflare D1 returned invalid JSON") from error


def apply_schema(args: argparse.Namespace) -> None:
    command = [
        "npx", "wrangler", "d1", "migrations", "apply", args.database, "--remote",
        *wrangler_args(args),
    ]
    run_quiet(command)


def current_r2_keys(args: argparse.Namespace) -> set[str]:
    rows = d1_json(
        args,
        "SELECT r2_key FROM envelopes UNION SELECT r2_key FROM deleted_envelopes "
        "UNION SELECT r2_key FROM pending_envelopes",
    )
    return {str(row["r2_key"]) for row in rows if row.get("r2_key") is not None}


def ensure_destination_safe(
    args: argparse.Namespace, requested_state: str, r2_keys: set[str]
) -> None:
    rows = d1_json(
        args,
        "SELECT (SELECT COUNT(*) FROM accounts) accounts,"
        "(SELECT COUNT(*) FROM envelopes) active,"
        "(SELECT COALESCE(SUM(ciphertext_bytes),0) FROM envelopes) activeBytes,"
        "(SELECT COUNT(*) FROM deleted_envelopes) deleted,"
        "(SELECT COALESCE(SUM(ciphertext_bytes),0) FROM deleted_envelopes) deletedBytes,"
        "(SELECT COUNT(*) FROM account_quotas) quotas,"
        "(SELECT COUNT(*) FROM reminder_push_devices) pushDevices,"
        "(SELECT COUNT(*) FROM reminder_wakes) wakes,"
        "(SELECT COUNT(*) FROM reminder_wake_revisions) wakeRevisions,"
        "(SELECT COUNT(*) FROM reminder_wake_deliveries) deliveries,"
        "(SELECT COUNT(*) FROM pending_envelopes) pending,"
        "((SELECT COUNT(*) FROM rate_buckets)+(SELECT COUNT(*) FROM auth_challenges)+"
        "(SELECT COUNT(*) FROM auth_sessions)+(SELECT COUNT(*) FROM pairing_sessions)) operational,"
        f"(SELECT value FROM meta WHERE key={sql_text(MIGRATION_META_KEY)}) marker",
    )
    if len(rows) != 1:
        fail("Cloudflare D1 safety query returned an unexpected result")
    row = rows[0]
    actual = {key: int(row.get(key, -1)) for key in MARKER_COUNT_KEYS}
    if int(row.get("pending", -1)) != 0 or int(row.get("operational", -1)) != 0:
        fail("Cloudflare D1 contains activity created outside the staged migration")

    marker_value = row.get("marker")
    if marker_value is None:
        if any(actual.values()) or r2_keys:
            fail("Cloudflare D1 contains data but has no trusted migration marker")
        return
    try:
        marker = json.loads(str(marker_value))
    except json.JSONDecodeError as error:
        raise MigrationError("Cloudflare D1 migration marker is invalid") from error
    if marker.get("version") != 1 or marker.get("state") not in {"staged", "complete"}:
        fail("Cloudflare D1 migration marker is invalid")
    expected = marker.get("counts")
    if not isinstance(expected, dict) or set(expected) != MARKER_COUNT_KEYS:
        fail("Cloudflare D1 migration marker has incomplete expected counts")
    if any(not isinstance(expected[key], int) or expected[key] < 0 for key in MARKER_COUNT_KEYS):
        fail("Cloudflare D1 migration marker has invalid expected counts")
    if actual != {key: expected[key] for key in MARKER_COUNT_KEYS}:
        fail("Cloudflare D1 changed after the last migration pass")
    if marker["state"] == "complete" and requested_state == "staged":
        fail("A completed migration cannot be replaced by a staged snapshot")
    if any(not MIGRATED_R2_KEY.fullmatch(key) for key in r2_keys):
        fail("Cloudflare D1 references R2 objects created outside the staged migration")


def upload_object(args: argparse.Namespace, envelope: Envelope) -> None:
    command = [
        "npx", "wrangler", "r2", "object", "put", f"{args.bucket}/{envelope.r2_key}",
        "--remote", "--pipe", "--content-type", "text/plain;charset=utf-8", "--force",
        *wrangler_args(args),
    ]
    run_quiet(command, stdin=envelope.ciphertext.encode())


def download_object(args: argparse.Namespace, envelope: Envelope) -> bytes:
    command = [
        "npx", "wrangler", "r2", "object", "get", f"{args.bucket}/{envelope.r2_key}",
        "--remote", "--pipe", *wrangler_args(args),
    ]
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode != 0:
        fail("Cloudflare R2 verification failed because an object could not be read")
    return result.stdout


def parallel(items: Sequence[Envelope], workers: int, operation) -> None:
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(operation, item) for item in items]
        for future in concurrent.futures.as_completed(futures):
            future.result()


def execute_sql_file(args: argparse.Namespace, sql: str) -> None:
    handle, name = tempfile.mkstemp(prefix="scrapscache-d1-", suffix=".sql", text=True)
    try:
        os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w") as stream:
            stream.write(sql)
        run_quiet(
            [
                "npx", "wrangler", "d1", "execute", args.database, "--remote", "--yes",
                "--file", name, *wrangler_args(args),
            ]
        )
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def verify_destination(args: argparse.Namespace, snapshot: Snapshot) -> None:
    rows = d1_json(
        args,
        "SELECT (SELECT COUNT(*) FROM accounts) accounts,"
        "(SELECT COUNT(*) FROM envelopes) active,"
        "(SELECT COALESCE(SUM(ciphertext_bytes),0) FROM envelopes) active_bytes,"
        "(SELECT COUNT(*) FROM deleted_envelopes) deleted,"
        "(SELECT COALESCE(SUM(ciphertext_bytes),0) FROM deleted_envelopes) deleted_bytes,"
        "(SELECT COUNT(*) FROM reminder_push_devices) push_devices,"
        f"(SELECT value FROM meta WHERE key={sql_text(MIGRATION_META_KEY)}) marker",
    )
    if len(rows) != 1:
        fail("Cloudflare D1 verification query returned an unexpected result")
    active = [item for item in snapshot.envelopes if item.deleted_at is None]
    deleted = [item for item in snapshot.envelopes if item.deleted_at is not None]
    expected = {
        "accounts": len(snapshot.accounts),
        "active": len(active),
        "active_bytes": sum(item.ciphertext_bytes for item in active),
        "deleted": len(deleted),
        "deleted_bytes": sum(item.ciphertext_bytes for item in deleted),
        "push_devices": len(snapshot.push_devices),
    }
    actual = {key: int(rows[0].get(key, -1)) for key in expected}
    if actual != expected:
        fail("Cloudflare D1 row counts or byte totals do not match the source snapshot")
    try:
        marker = json.loads(str(rows[0]["marker"]))
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise MigrationError("Cloudflare D1 migration marker is invalid") from error
    if marker.get("sourceDigest") != snapshot.digest:
        fail("Cloudflare D1 migration marker does not match the source snapshot")

    def verify_object(envelope: Envelope) -> None:
        remote = download_object(args, envelope)
        local = envelope.ciphertext.encode()
        if len(remote) != len(local) or (
            hashlib.sha256(remote).digest() != hashlib.sha256(local).digest()
        ):
            fail("An R2 ciphertext object does not match the source snapshot")

    parallel(snapshot.envelopes, args.workers, verify_object)


def delete_object(args: argparse.Namespace, key: str) -> None:
    run_quiet(
        [
            "npx", "wrangler", "r2", "object", "delete", f"{args.bucket}/{key}",
            "--remote", "--force", *wrangler_args(args),
        ]
    )


def summary(snapshot: Snapshot) -> str:
    active = [item for item in snapshot.envelopes if item.deleted_at is None]
    deleted = [item for item in snapshot.envelopes if item.deleted_at is not None]
    return (
        f"{len(snapshot.accounts)} accounts, {len(active)} active envelopes "
        f"({sum(item.ciphertext_bytes for item in active)} bytes), "
        f"{len(deleted)} retained envelopes, {len(snapshot.push_devices)} push devices"
    )


def load_consistent_source(source: Path, temp: Path) -> Snapshot:
    snapshot_database(source, temp)
    return load_snapshot(temp)


def migrate(args: argparse.Namespace, state: str) -> None:
    if state == "complete" and not args.source_stopped:
        fail("Finalize requires --source-stopped after the old service has been stopped")
    with tempfile.TemporaryDirectory(prefix="scrapscache-migration-") as directory:
        snapshot = load_consistent_source(args.source, Path(directory) / "snapshot.sqlite")
        print(f"Validated source snapshot: {summary(snapshot)}")
        apply_schema(args)
        previous_keys = current_r2_keys(args)
        ensure_destination_safe(args, state, previous_keys)
        parallel(snapshot.envelopes, args.workers, lambda item: upload_object(args, item))
        execute_sql_file(args, migration_sql(snapshot, state))
        verify_destination(args, snapshot)
        current_keys = {item.r2_key for item in snapshot.envelopes}
        obsolete = sorted(previous_keys - current_keys)
        for key in obsolete:
            delete_object(args, key)
        print(
            f"Cloudflare migration {state}: D1 metadata and all {len(snapshot.envelopes)} "
            "R2 ciphertext objects verified"
        )


def plan(args: argparse.Namespace) -> None:
    with tempfile.TemporaryDirectory(prefix="scrapscache-migration-") as directory:
        snapshot = load_consistent_source(args.source, Path(directory) / "snapshot.sqlite")
        print(f"Validated source snapshot: {summary(snapshot)}")
        print("Backups, historical JSON, and raw-original files are excluded")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "stage", "finalize"))
    parser.add_argument("source", type=Path, help="Path to the live sync.sqlite database")
    parser.add_argument("--database", default="SCRAPSCACHE_DB", help="Wrangler D1 binding")
    parser.add_argument("--bucket", default="scrapscache-envelopes", help="R2 bucket name")
    parser.add_argument("--env", default="", help="Wrangler environment (empty is production)")
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 9))
    parser.add_argument("--source-stopped", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.action == "plan":
            plan(args)
        elif args.action == "stage":
            migrate(args, "staged")
        else:
            migrate(args, "complete")
        return 0
    except (MigrationError, sqlite3.Error) as error:
        print(f"Migration failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
