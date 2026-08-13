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

| Variable            | Guidance                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `SHARD_IMAGE`       | Pin a release, e.g. `ghcr.io/volturine/shard-notes:1.2.3`, or an immutable digest |
| `SHARD_ADMIN_TOKEN` | Long random secret (metrics + manual backup)                                      |
| `SHARD_ORIGIN`      | Exact public origin, e.g. `https://notes.example.com`                             |
| `SHARD_PORT`        | Host port (default `3000`)                                                        |

```sh
docker compose --project-directory . -f docker/compose.production.yaml pull
docker compose --project-directory . -f docker/compose.production.yaml up -d
docker compose --project-directory . -f docker/compose.production.yaml ps
```

Shard listens on container port **3000**. The production template:

- Runs with a read-only application filesystem
- Stores SQLite under the `shard-sync-data` volume
- Writes verified online snapshots to `shard-backup-snapshots`

### Build locally instead of pulling

```sh
docker compose --project-directory . -f docker/compose.yaml up -d --build
```

Uses `docker/compose.yaml` (development-oriented defaults). Prefer
`docker/compose.production.yaml` + a pinned GHCR image for real deployments.

## Preview a pull-request image

CI publishes each same-repo PR as `dev-<n>` / `dev-sha-<commit>` (amd64 only).
Run that image beside production with a separate Compose project and port:

```sh
cp .env.dev.example .env.dev
# Set SHARD_IMAGE=ghcr.io/volturine/shard-notes:dev-<pr>
docker compose --project-directory . -f docker/compose.dev.yaml --env-file .env.dev pull
docker compose --project-directory . -f docker/compose.dev.yaml --env-file .env.dev up -d
```

Defaults: host port **3000**, project name `shard-notes-dev`, isolated volumes.
Change the tag in `.env.dev` and run `pull` + `up -d` again to switch PRs.
Do not point this stack at the production volumes or admin token.

## Tailscale Serve

Optional overlay: `docker/compose.tailscale.yaml`. A sidecar joins your tailnet
as `TS_HOSTNAME` and [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
terminates HTTPS with a MagicDNS certificate, proxying to the `app` container.
No public ports or extra reverse proxy.

In the Tailscale admin console:

1. Enable **MagicDNS** and **HTTPS Certificates** (DNS page).
2. Create an [auth key](https://login.tailscale.com/admin/settings/keys) or
   [OAuth client](https://login.tailscale.com/admin/settings/oauth) (`auth_keys`
   write). OAuth nodes need a tag in ACLs and
   `TS_EXTRA_ARGS=--advertise-tags=tag:container`. Append `?ephemeral=false` to
   an OAuth secret so the machine survives restarts.
3. Do **not** enable Funnel. Serve is tailnet-only.

Set in `.env`:

```sh
TS_HOSTNAME=shard
TS_AUTHKEY=tskey-auth-…   # or tskey-client-…?ephemeral=false
SHARD_ORIGIN=https://shard.your-tailnet.ts.net
```

```sh
docker compose --project-directory . \
  -f docker/compose.production.yaml -f docker/compose.tailscale.yaml \
  up -d
docker compose --project-directory . \
  -f docker/compose.production.yaml -f docker/compose.tailscale.yaml \
  exec tailscale tailscale serve status
```

The app is then `https://shard.your-tailnet.ts.net` from any device on the
tailnet. The first HTTPS request can take a few seconds while the certificate is
issued. Host ports stay published for local health checks; use the `*.ts.net`
origin in the browser.

The sidecar uses userspace networking (works on Docker Desktop / macOS) and
persists identity in the `tailscale-state` volume. Serve config lives in
`docker/tailscale/serve.json` (`${TS_CERT_DOMAIN}` is substituted at runtime).
Mount that path as a **directory**, not a single file.

Same overlay works with `docker/compose.dev.yaml` for PR previews. Give that
stack its own hostname (`dev-shard` in `.env.dev.example`) and auth key so it
cannot collide with production.

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

| Variable                             |                  Default | Purpose                                                       |
| ------------------------------------ | -----------------------: | ------------------------------------------------------------- |
| `SHARD_SYNC_DATA_DIR`                |              `sync-data` | Persistent sync-data directory (`/data` in Compose)           |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES`       |             `1000000000` | Ciphertext quota per account                                  |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES`   |                  `50000` | Record quota per account                                      |
| `SHARD_SYNC_MAX_CONCURRENT_REQUESTS` |                      `8` | Max sync requests in flight                                   |
| `SHARD_BACKUP_DIR`                   |                 disabled | Directory for consistent online SQLite snapshots              |
| `SHARD_BACKUP_INTERVAL_HOURS`        |                     `24` | Snapshot interval                                             |
| `SHARD_BACKUP_RETAIN`                |                      `2` | Raw verified staging snapshots retained locally               |
| `SHARD_ADMIN_TOKEN`                  |                        — | Protects metrics and manual backup (required in prod Compose) |
| `SHARD_VAPID_PUBLIC_KEY`             |           auto-generated | Optional stable Web Push VAPID public key                     |
| `SHARD_VAPID_PRIVATE_KEY`            |           auto-generated | Optional stable Web Push VAPID private key                    |
| `SHARD_VAPID_SUBJECT`                | `mailto:shard@localhost` | Contact URI for VAPID (`mailto:` or `https:`)                 |
| `ADDRESS_HEADER` / `XFF_DEPTH`       |             direct / `1` | Trusted proxy client-address configuration                    |

Compose maps `SHARD_ADDRESS_HEADER` → `ADDRESS_HEADER` and
`SHARD_XFF_DEPTH` → `XFF_DEPTH`.

### Docker Compose helpers

| Variable                |                 Default | Purpose                                                       |
| ----------------------- | ----------------------: | ------------------------------------------------------------- |
| `SHARD_PORT`            |                  `3000` | Host port published by Compose                                |
| `SHARD_IMAGE`           |         required (prod) | Pinned image tag or digest                                    |
| `SHARD_ORIGIN`          | `http://localhost:3000` | Exact public origin used by SvelteKit                         |
| `SHARD_BODY_SIZE_LIMIT` |                  `110M` | Node adapter request limit; must exceed the 101 MB sync cap   |
| `TS_HOSTNAME`           |                 `shard` | Tailnet machine name (`https://<name>.<tailnet>.ts.net`)      |
| `TS_AUTHKEY`            |                       — | Auth key or OAuth secret; required with the Tailscale overlay |
| `TS_EXTRA_ARGS`         |                       — | Extra `tailscale up` flags (OAuth tag advertisement)          |

Inside Compose, `HOST`, `PORT`, and `SHARD_SYNC_DATA_DIR` are fixed to
`0.0.0.0`, `3000`, and `/data`. Direct `docker run` may override them.

An existing `users.json` under the data directory is imported once into SQLite
and left in place as a recovery copy.

## Health, metrics, and admin backup

| Endpoint                 | Auth                                       | Purpose                                |
| ------------------------ | ------------------------------------------ | -------------------------------------- |
| `GET /health/live`       | none                                       | Process liveness                       |
| `GET /health/ready`      | none                                       | SQLite + migrations + volume readiness |
| `GET /metrics`           | `Authorization: Bearer $SHARD_ADMIN_TOKEN` | Prometheus-style metrics               |
| `POST /api/admin/backup` | same bearer token                          | Trigger an online snapshot now         |

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

Optional overlay: `docker/compose.backup.yaml`.

### Local encrypted repository

```sh
export SHARD_RESTIC_PASSWORD_FILE=/secure/path/shard-restic-password
docker compose --project-directory . \
  -f docker/compose.production.yaml -f docker/compose.backup.yaml \
  --profile backup up -d
```

### S3-compatible repository

```sh
export SHARD_RESTIC_S3_REPOSITORY=s3:https://storage.example.com/shard-backups
export SHARD_S3_ACCESS_KEY_FILE=/secure/path/s3-access-key
export SHARD_S3_SECRET_KEY_FILE=/secure/path/s3-secret-key
docker compose --project-directory . \
  -f docker/compose.production.yaml -f docker/compose.backup.yaml \
  --profile backup-s3 up -d
```

List and verify:

```sh
docker compose --project-directory . \
  -f docker/compose.production.yaml -f docker/compose.backup.yaml \
  --profile backup exec backup-local restic snapshots
docker compose --project-directory . \
  -f docker/compose.production.yaml -f docker/compose.backup.yaml \
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

CI Vitest coverage exercises the same online-backup API and restore-into-fresh-store
path used here (`SyncStore.backup` + `BackupManager` verified snapshots).

## Images and CI

[`.github/workflows/ci-cd.yaml`](../.github/workflows/ci-cd.yaml):

- Every PR: typecheck + Vitest + production build, then an `amd64` image build
  published as **`dev-<n>`** / **`dev-sha-<commit>`** (never `latest`)
- Push/merge to `master`: multi-arch (`amd64`/`arm64`) publish with **`latest`**,
  **`master`**, and **`sha-<commit>`**, plus SBOM and provenance
- Tags `v*`: semantic version tags (e.g. `v1.2.3` → `1.2.3`, `1.2`)

`latest` is only moved by successful publishes from `master`. Pull request
images use a `dev-` prefix so they cannot overwrite production tags.

Registry auth uses the repository-scoped `GITHUB_TOKEN`; no custom registry
password is required for GitHub Actions.

## Security notes for operators

See [security.md](security.md). Short version: the database holds **encrypted
envelopes**, not readable notes — but you still protect availability, auth
tokens, TLS, and backup encryption keys carefully.
