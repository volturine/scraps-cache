# Shard

Offline-first notes — pins, labels, reminders, and optional cloud sync.

## Develop

```sh
cd shard-notes
npm install
npm run dev -- --host 0.0.0.0
```

Tailscale / LAN: `http://<your-ip>:5173/`

## Build

```sh
npm run build
npm start
```

The production build uses SvelteKit's Node adapter. Sync data is stored in
`sync-data/sync.sqlite`; an existing `sync-data/users.json` is imported once and
left in place as a recovery copy.

Optional server settings:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SHARD_SYNC_DATA_DIR` | `sync-data` | Persistent sync-data directory |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES` | `1000000000` | Ciphertext quota per account |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES` | `50000` | Record quota per account |
| `SHARD_SYNC_MAX_CONCURRENT_REQUESTS` | `8` | Maximum sync requests in flight |
| `SHARD_BACKUP_DIR` | disabled | Directory for consistent online SQLite snapshots |
| `SHARD_BACKUP_INTERVAL_HOURS` | `24` | Snapshot interval |
| `SHARD_BACKUP_RETAIN` | `2` | Raw verified staging snapshots retained locally |
| `SHARD_ADMIN_TOKEN` | required in production Compose | Protects metrics and manual backup |
| `ADDRESS_HEADER` / `XFF_DEPTH` | direct socket / `1` | Trusted proxy client-address configuration |

`npm run preview` remains useful for locally previewing the built app.

## Docker

### Pull the published image

The recommended server deployment pulls the multi-architecture image published
to GitHub Container Registry:

```sh
cp .env.example .env
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml up -d
docker compose -f compose.production.yaml ps
```

Shard is then available at `http://localhost:3000`. The Compose deployment runs
as an unprivileged user with a read-only application filesystem and stores its
SQLite database in the persistent `shard-sync-data` volume.

Production Compose requires `SHARD_IMAGE`. Set it to a release tag such as
`ghcr.io/volturine/shard-notes:1.2.3`, or preferably an immutable digest.

To build from the local checkout instead, use the development template:

```sh
docker compose up -d --build
```

For a public deployment, set `SHARD_ORIGIN` to the exact externally visible
HTTPS URL. TLS should terminate at a reverse proxy in front of the container.
The container listens on port 3000; change only `SHARD_PORT` to select a
different host port.

Node uses the direct socket address by default. Behind exactly one trusted
reverse proxy, set `SHARD_ADDRESS_HEADER=x-forwarded-for` and
`SHARD_XFF_DEPTH=1`, and configure the proxy to replace—not append
untrusted—forwarded headers. Increase the depth only for a known proxy chain.
Set HSTS at the TLS-terminating proxy after HTTPS is confirmed.

Shard creates verified online SQLite snapshots daily in the
`shard-backup-snapshots` volume. Trigger one immediately before an upgrade:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $SHARD_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/backup
```

Do not copy `sync.sqlite`, `sync.sqlite-wal`, and `sync.sqlite-shm` independently
while the app is running. The online snapshot is the supported backup source.

### Encrypted local and S3 backups

The optional backup Compose file sends verified snapshots to encrypted Restic
repositories. Create a password file outside the repository, then start the
local repository:

```sh
export SHARD_RESTIC_PASSWORD_FILE=/secure/path/shard-restic-password
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup up -d
```

For an S3-compatible repository, also set:

```sh
export SHARD_RESTIC_S3_REPOSITORY=s3:https://storage.example.com/shard-backups
export SHARD_S3_ACCESS_KEY_FILE=/secure/path/s3-access-key
export SHARD_S3_SECRET_KEY_FILE=/secure/path/s3-secret-key
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup-s3 up -d
```

List and verify local encrypted snapshots:

```sh
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup exec backup-local restic snapshots
docker compose -f compose.production.yaml -f compose.backup.yaml \
  --profile backup exec backup-local restic check --read-data
```

Restore into a temporary directory first, verify `sync.sqlite` with
`PRAGMA integrity_check`, stop the app, and only then replace the data volume.
Perform this restore drill monthly.

An operator restore drill is:

1. Trigger a fresh online snapshot and confirm `/metrics` reports a newer
   `shard_backup_last_success_timestamp_seconds`.
2. Run `restic check --read-data`, then restore `latest` into a new temporary
   volume or directory—never over the live volume.
3. Locate the restored `shard-sync-*.sqlite` and run
   `sqlite3 restored.sqlite 'PRAGMA integrity_check;'`; the only output must be
   `ok`.
4. Stop Shard, copy that verified file into an empty sync-data volume as
   `sync.sqlite`, and start Shard against the new volume.
5. Check `/health/ready`, then link an existing device and complete a delta
   sync before retiring the old volume.

CI runs `npm run test:restore`, which exercises SQLite's online backup API,
restores into an empty directory, checks integrity, and verifies that existing
account credentials survive.

### Docker configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SHARD_PORT` | `3000` | Host port published by Compose |
| `SHARD_IMAGE` | required | Pinned image tag or digest pulled by the production template |
| `SHARD_ORIGIN` | `http://localhost:3000` | Exact public origin used by SvelteKit |
| `SHARD_BODY_SIZE_LIMIT` | `110M` | Node adapter request limit; must exceed the 101 MB sync cap |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES` | `1000000000` | Encrypted bytes retained per account |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES` | `50000` | Encrypted records retained per account |

`HOST`, `PORT`, and `SHARD_SYNC_DATA_DIR` are fixed inside the Compose service
to `0.0.0.0`, `3000`, and `/data`. Direct `docker run` deployments may override
them when needed.

## CI/CD

[`.github/workflows/ci-cd.yaml`](.github/workflows/ci-cd.yaml) runs the complete
application validation and an `amd64` Docker build for every pull request. After
changes reach `main`, it publishes an `amd64`/`arm64` image:

- `ghcr.io/volturine/shard-notes:latest`
- `ghcr.io/volturine/shard-notes:main`
- `ghcr.io/volturine/shard-notes:sha-<commit>`

Tags beginning with `v` additionally publish semantic-version tags. For example,
`v1.2.3` publishes `1.2.3` and `1.2`. Images include SBOM and provenance
attestations. The workflow uses the repository-scoped `GITHUB_TOKEN`; no registry
password or custom secret is required.

## Validate

```sh
npm run validate
```

This runs Svelte/TypeScript diagnostics, the Vitest suite, and a production build.
