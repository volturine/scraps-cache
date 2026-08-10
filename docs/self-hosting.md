# Self-hosting

Run Shard as a single Node service with SQLite for the optional encrypted sync
relay. This guide covers Docker production deployment, configuration, backups,
and recovery.

## Requirements

- Docker Engine with Compose v2
- For public deployments: a reverse proxy that terminates TLS
- Persistent volumes for sync data and online snapshots

## Production (recommended)

Pull the multi-architecture image from GitHub Container Registry:

```sh
cp .env.example .env
```

Edit `.env` at minimum:

| Variable | Guidance |
| --- | --- |
| `SHARD_IMAGE` | Pin a release, e.g. `ghcr.io/volturine/shard-notes:1.2.3`, or an immutable digest |
| `SHARD_ADMIN_TOKEN` | Long random secret (metrics + manual backup) |
| `SHARD_ORIGIN` | Exact public origin, e.g. `https://notes.example.com` |
| `SHARD_PORT` | Host port (default `3000`) |

```sh
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml up -d
docker compose -f compose.production.yaml ps
```

Shard listens on container port **3000**. The production template:

- Runs with a read-only application filesystem
- Stores SQLite under the `shard-sync-data` volume
- Writes verified online snapshots to `shard-backup-snapshots`

### Build locally instead of pulling

```sh
docker compose up -d --build
```

Uses `compose.yaml` (development-oriented defaults). Prefer
`compose.production.yaml` + a pinned GHCR image for real deployments.

## Reverse proxy and TLS

Terminate HTTPS at your proxy (Caddy, nginx, Traefik, etc.) and proxy to
`http://127.0.0.1:${SHARD_PORT}`.

1. Set `SHARD_ORIGIN` to the **exact** external HTTPS origin (scheme + host,
   no trailing path).
2. Set HSTS on the proxy only after HTTPS works end-to-end.
3. Client address for rate limits:
   - **Direct** exposure (no proxy): leave `SHARD_ADDRESS_HEADER` empty.
   - **One trusted proxy**: set
     `SHARD_ADDRESS_HEADER=x-forwarded-for` and `SHARD_XFF_DEPTH=1`, and
     configure the proxy to **replace** (not append untrusted) `X-Forwarded-For`.
   - Increase depth only for a known multi-proxy chain.

## Environment reference

### Application / Node

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SHARD_SYNC_DATA_DIR` | `sync-data` | Persistent sync-data directory (`/data` in Compose) |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES` | `1000000000` | Ciphertext quota per account |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES` | `50000` | Record quota per account |
| `SHARD_SYNC_MAX_CONCURRENT_REQUESTS` | `8` | Max sync requests in flight |
| `SHARD_BACKUP_DIR` | disabled | Directory for consistent online SQLite snapshots |
| `SHARD_BACKUP_INTERVAL_HOURS` | `24` | Snapshot interval |
| `SHARD_BACKUP_RETAIN` | `2` | Raw verified staging snapshots retained locally |
| `SHARD_ADMIN_TOKEN` | — | Protects metrics and manual backup (required in prod Compose) |
| `ADDRESS_HEADER` / `XFF_DEPTH` | direct / `1` | Trusted proxy client-address configuration |

Compose maps `SHARD_ADDRESS_HEADER` → `ADDRESS_HEADER` and
`SHARD_XFF_DEPTH` → `XFF_DEPTH`.

### Docker Compose helpers

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SHARD_PORT` | `3000` | Host port published by Compose |
| `SHARD_IMAGE` | required (prod) | Pinned image tag or digest |
| `SHARD_ORIGIN` | `http://localhost:3000` | Exact public origin used by SvelteKit |
| `SHARD_BODY_SIZE_LIMIT` | `110M` | Node adapter request limit; must exceed the 101 MB sync cap |

Inside Compose, `HOST`, `PORT`, and `SHARD_SYNC_DATA_DIR` are fixed to
`0.0.0.0`, `3000`, and `/data`. Direct `docker run` may override them.

An existing `users.json` under the data directory is imported once into SQLite
and left in place as a recovery copy.

## Health, metrics, and admin backup

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health/live` | none | Process liveness |
| `GET /health/ready` | none | SQLite + migrations + volume readiness |
| `GET /metrics` | `Authorization: Bearer $SHARD_ADMIN_TOKEN` | Prometheus-style metrics |
| `POST /api/admin/backup` | same bearer token | Trigger an online snapshot now |

Trigger a snapshot before upgrades:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $SHARD_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/backup
```

**Do not** copy `sync.sqlite`, `sync.sqlite-wal`, and `sync.sqlite-shm`
independently while the app is running. Use the online snapshot as the
supported backup source.

## Encrypted backups with Restic

Optional overlay: `compose.backup.yaml`.

### Local encrypted repository

```sh
export SHARD_RESTIC_PASSWORD_FILE=/secure/path/shard-restic-password
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup up -d
```

### S3-compatible repository

```sh
export SHARD_RESTIC_S3_REPOSITORY=s3:https://storage.example.com/shard-backups
export SHARD_S3_ACCESS_KEY_FILE=/secure/path/s3-access-key
export SHARD_S3_SECRET_KEY_FILE=/secure/path/s3-secret-key
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup-s3 up -d
```

List and verify:

```sh
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup exec backup-local restic snapshots
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup exec backup-local restic check --read-data
```

## Restore drill (monthly)

Default server RPO is up to one backup interval (24h). Linked devices may hold
newer local edits and repopulate a restored relay.

1. Trigger a fresh online snapshot; confirm `/metrics` shows a newer
   `shard_backup_last_success_timestamp_seconds`.
2. Run `restic check --read-data`, then restore `latest` into a **new** temporary
   volume or directory — never over the live volume.
3. Locate restored `shard-sync-*.sqlite` and run:
   `sqlite3 restored.sqlite 'PRAGMA integrity_check;'`
   (expect only `ok`).
4. Stop Shard, copy that file into an empty sync-data volume as `sync.sqlite`,
   start Shard against the new volume.
5. Check `/health/ready`, link an existing device, complete a delta sync, then
   retire the old volume.

CI runs `npm run test:restore` for a smaller automated variant of this path.

## Images and CI

[`.github/workflows/ci-cd.yaml`](../.github/workflows/ci-cd.yaml):

- Every PR: full `npm run validate` + `amd64` image build
- Push to `main`: multi-arch (`amd64`/`arm64`) publish to GHCR with SBOM and
  provenance
- Tags `v*`: semantic version tags (e.g. `v1.2.3` → `1.2.3`, `1.2`)

Registry auth uses the repository-scoped `GITHUB_TOKEN`; no custom registry
password is required for GitHub Actions.

## Security notes for operators

See [security.md](security.md). Short version: the database holds **encrypted
envelopes**, not readable notes — but you still protect availability, auth
tokens, TLS, and backup encryption keys carefully.
