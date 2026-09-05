#!/usr/bin/env python3
"""Replace the shared Cloudflare development Workers and D1 schema.

Durable Object and D1 migrations are append-only. Each development deploy must
start from an empty Worker and an empty database so one pull request cannot
block the next.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence


DATABASE = "SCRAPSCACHE_DB"
DEV_ENV = "dev"
D1_RETRY_ATTEMPTS = 3
LIST_OBJECTS = (
    "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') "
    "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
)


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def parse_d1_rows(payload: object) -> list[dict[str, object]]:
    blocks = payload if isinstance(payload, list) else [payload]
    rows: list[dict[str, object]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        result_block = block.get("results") or block.get("result") or []
        if isinstance(result_block, list):
            rows.extend(item for item in result_block if isinstance(item, dict))
    return rows


def drop_sql(objects: Sequence[Mapping[str, object]]) -> str | None:
    views: list[str] = []
    tables: list[str] = []
    for obj in objects:
        name = obj.get("name")
        kind = obj.get("type")
        if not isinstance(name, str) or not name:
            raise ValueError("D1 sqlite_master row is missing a name")
        ident = quote_ident(name)
        if kind == "view":
            views.append(f"DROP VIEW IF EXISTS {ident}")
        elif kind == "table":
            tables.append(f"DROP TABLE IF EXISTS {ident}")
    statements = views + tables
    if not statements:
        return None
    return "; ".join(["PRAGMA defer_foreign_keys = ON", *statements])


def is_missing_worker(output: str) -> bool:
    lowered = output.lower()
    return (
        "cannot find" in lowered
        or "could not find" in lowered
        or "does not exist" in lowered
        or "code: 10007" in lowered
        or "code: 10090" in lowered
    )


def is_transient_d1_failure(output: str) -> bool:
    return "code: 7429" in output.lower()


def wrangler(args: Sequence[str], env: Mapping[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["npx", "wrangler", *args],
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {}), "CI": "true"},
    )


def echo(result: subprocess.CompletedProcess[str]) -> None:
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)


def run_d1(args: Sequence[str], env: Mapping[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    for attempt in range(D1_RETRY_ATTEMPTS):
        result = wrangler(args, env)
        echo(result)
        if result.returncode == 0 or not is_transient_d1_failure(result.stdout + result.stderr):
            return result
        if attempt + 1 < D1_RETRY_ATTEMPTS:
            time.sleep(2**attempt)
    return result


def delete_worker(args: Sequence[str], env: Mapping[str, str] | None = None) -> None:
    result = wrangler(["delete", *args], env)
    echo(result)
    if result.returncode == 0 or is_missing_worker(result.stdout + result.stderr):
        return
    raise SystemExit(result.returncode)


def wipe_d1(env: Mapping[str, str] | None = None) -> None:
    listed = run_d1(
        [
            "d1",
            "execute",
            DATABASE,
            "--remote",
            "--env",
            DEV_ENV,
            "--json",
            "--yes",
            "--command",
            LIST_OBJECTS,
        ],
        env,
    )
    echo(listed)
    if listed.returncode != 0:
        raise SystemExit(listed.returncode)
    try:
        payload = json.loads(listed.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit("Cloudflare D1 returned invalid JSON") from error
    sql = drop_sql(parse_d1_rows(payload))
    if sql is None:
        return
    dropped = run_d1(
        [
            "d1",
            "execute",
            DATABASE,
            "--remote",
            "--env",
            DEV_ENV,
            "--yes",
            "--command",
            sql,
        ],
        env,
    )
    echo(dropped)
    if dropped.returncode != 0:
        raise SystemExit(dropped.returncode)


def main() -> int:
    delete_worker(["--config", "cf/wrangler.cron.jsonc", "--env", DEV_ENV, "--force"])
    delete_worker(["--env", DEV_ENV, "--force"])
    wipe_d1()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
