import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.migrate_sqlite_to_cloudflare import (
    Envelope,
    MigrationError,
    VAPID_META_KEY,
    ensure_destination_safe,
    load_snapshot,
    migration_sql,
)


LEGACY_SCHEMA = """
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, next_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, envelope_count INTEGER NOT NULL, ciphertext_bytes INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, wake_revision INTEGER NOT NULL
);
CREATE TABLE envelopes (
  account_id TEXT NOT NULL, slot TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
  ciphertext TEXT NOT NULL, PRIMARY KEY(account_id, slot)
);
CREATE TABLE deleted_envelopes (
  account_id TEXT NOT NULL, slot TEXT NOT NULL, id TEXT NOT NULL, ciphertext TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, PRIMARY KEY(account_id, slot)
);
CREATE TABLE account_quotas (account_id TEXT PRIMARY KEY, max_bytes INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE reminder_push_devices (
  account_id TEXT NOT NULL, device_id TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL,
  auth TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(account_id, device_id)
);
CREATE TABLE reminder_wakes_v2 (
  account_id TEXT NOT NULL, wake_id TEXT NOT NULL, fire_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, wake_id)
);
CREATE TABLE reminder_wake_deliveries (
  account_id TEXT NOT NULL, device_id TEXT NOT NULL, wake_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL, delivered_at INTEGER,
  PRIMARY KEY(account_id, device_id, wake_id)
);
"""


D1_SCHEMA = """
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, next_seq INTEGER NOT NULL,
  envelope_count INTEGER NOT NULL, ciphertext_bytes INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE envelopes (
  account_id TEXT NOT NULL, slot TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
  r2_key TEXT NOT NULL, ciphertext_bytes INTEGER NOT NULL, PRIMARY KEY(account_id, slot)
);
CREATE TABLE deleted_envelopes (
  account_id TEXT NOT NULL, slot TEXT NOT NULL, id TEXT NOT NULL, r2_key TEXT NOT NULL,
  ciphertext_bytes INTEGER NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(account_id, slot)
);
CREATE TABLE pending_envelopes (account_id TEXT, id TEXT, r2_key TEXT, created_at INTEGER);
CREATE TABLE account_quotas (account_id TEXT PRIMARY KEY, max_bytes INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE reminder_push_devices (
  account_id TEXT, device_id TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, updated_at INTEGER,
  PRIMARY KEY(account_id, device_id)
);
CREATE TABLE reminder_wakes (
  account_id TEXT, wake_id TEXT, fire_at INTEGER, PRIMARY KEY(account_id, wake_id)
);
CREATE TABLE reminder_wake_revisions (account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE reminder_wake_deliveries (
  account_id TEXT, device_id TEXT, wake_id TEXT, claimed_at INTEGER, delivered_at INTEGER,
  PRIMARY KEY(account_id, device_id, wake_id)
);
"""


def source_database(path: Path, *, counter: int = 1) -> None:
    db = sqlite3.connect(path)
    db.executescript(LEGACY_SCHEMA)
    db.execute(
        "INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)",
        ("account", "credential", 3, 100, counter, 4, 101, 7),
    )
    db.execute("INSERT INTO envelopes VALUES(?,?,?,?,?)", ("account", "slot", 3, "id", "YWJj"))
    db.execute(
        "INSERT INTO deleted_envelopes VALUES(?,?,?,?,?)",
        ("account", "old-slot", "old-id", "ZA", 99),
    )
    db.execute("INSERT INTO account_quotas VALUES(?,?)", ("account", 1000))
    db.executemany(
        "INSERT INTO meta VALUES(?,?)",
        (
            ("vapid-public-v1", "public"),
            ("vapid-private-v1", "private"),
            ("legacy-users-json-v1", "must-not-migrate"),
        ),
    )
    db.execute(
        "INSERT INTO reminder_push_devices VALUES(?,?,?,?,?,?)",
        ("account", "device", "https://push.invalid", "p256dh", "auth", 102),
    )
    db.execute("INSERT INTO reminder_wakes_v2 VALUES(?,?,?)", ("account", "wake", 103))
    db.execute(
        "INSERT INTO reminder_wake_deliveries VALUES(?,?,?,?,?)",
        ("account", "device", "wake", 104, None),
    )
    db.commit()
    db.close()


class MigrationTest(unittest.TestCase):
    def test_generates_d1_metadata_without_ciphertext_or_legacy_meta(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.sqlite"
            source_database(path)
            snapshot = load_snapshot(path)
            sql = migration_sql(snapshot, "staged")

        self.assertNotIn("YWJj", sql)
        self.assertNotIn("must-not-migrate", sql)
        self.assertIn(VAPID_META_KEY, sql)
        self.assertIn('"publicKey":"public"', sql)
        self.assertIn('"privateKey":"private"', sql)

        destination = sqlite3.connect(":memory:")
        destination.executescript(D1_SCHEMA)
        destination.executescript(sql)
        destination.executescript(sql)
        self.assertEqual(destination.execute("SELECT COUNT(*) FROM accounts").fetchone()[0], 1)
        self.assertEqual(destination.execute("SELECT ciphertext_bytes FROM envelopes").fetchone()[0], 4)
        self.assertEqual(
            destination.execute("SELECT revision FROM reminder_wake_revisions").fetchone()[0], 7
        )

    def test_rejects_inconsistent_account_counters(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.sqlite"
            source_database(path, counter=2)
            with self.assertRaisesRegex(MigrationError, "counters are inconsistent"):
                load_snapshot(path)

    def test_rejects_push_devices_without_both_vapid_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.sqlite"
            source_database(path)
            db = sqlite3.connect(path)
            db.execute("DELETE FROM meta WHERE key='vapid-private-v1'")
            db.commit()
            db.close()
            with self.assertRaisesRegex(MigrationError, "only one of the two VAPID keys"):
                load_snapshot(path)

    def test_r2_key_is_deterministic_and_hides_identifiers(self) -> None:
        envelope = Envelope("private-account", "private-slot", "private-id", "YWJj", 1, None)
        same = Envelope("private-account", "private-slot", "private-id", "different", 1, None)
        self.assertEqual(envelope.r2_key, same.r2_key)
        self.assertNotIn("private", envelope.r2_key)
        self.assertRegex(envelope.r2_key, r"^v1/[a-f0-9]{64}/[a-f0-9]{64}$")

    def test_refuses_to_stage_over_a_completed_migration(self) -> None:
        counts = {
            "accounts": 1,
            "active": 0,
            "activeBytes": 0,
            "deleted": 0,
            "deletedBytes": 0,
            "quotas": 0,
            "pushDevices": 0,
            "wakes": 0,
            "wakeRevisions": 0,
            "deliveries": 0,
        }
        row = {
            **counts,
            "pending": 0,
            "operational": 0,
            "marker": json.dumps({"version": 1, "state": "complete", "counts": counts}),
        }
        with patch("scripts.migrate_sqlite_to_cloudflare.d1_json", return_value=[row]):
            with self.assertRaisesRegex(MigrationError, "completed migration"):
                ensure_destination_safe(SimpleNamespace(), "staged", set())

    def test_refuses_destination_changes_after_staging(self) -> None:
        counts = {
            "accounts": 1,
            "active": 0,
            "activeBytes": 0,
            "deleted": 0,
            "deletedBytes": 0,
            "quotas": 0,
            "pushDevices": 0,
            "wakes": 0,
            "wakeRevisions": 0,
            "deliveries": 0,
        }
        row = {
            **counts,
            "accounts": 2,
            "pending": 0,
            "operational": 0,
            "marker": json.dumps({"version": 1, "state": "staged", "counts": counts}),
        }
        with patch("scripts.migrate_sqlite_to_cloudflare.d1_json", return_value=[row]):
            with self.assertRaisesRegex(MigrationError, "changed after"):
                ensure_destination_safe(SimpleNamespace(), "complete", set())


if __name__ == "__main__":
    unittest.main()
