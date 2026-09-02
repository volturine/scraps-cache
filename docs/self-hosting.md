# Self-hosting

Run Scraps Cache as a Node service with sqld (libSQL) for the encrypted sync
relay and operational state. This guide covers Docker production deployment and
configuration.

## Requirements

- Docker Engine with Compose v2
- For public deployments: a reverse proxy or tunnel that terminates TLS

## Production (recommended)

Pull the multi-architecture image from GitHub Container Registry:

```sh
cp docker/.env.example docker/.env
```

Edit `docker/.env` at minimum:

| Variable                  | Guidance                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| `SCRAPSCACHE_IMAGE`       | Pin a release, e.g. `ghcr.io/volturine/scrapscache:1.2.3`, or an immutable digest |
| `SCRAPSCACHE_ORIGIN`      | Exact public origin, e.g. `https://scrapscache.com`                               |
| `SCRAPSCACHE_PORT`        | Host port (default `3000`)                                                        |
| `SCRAPSCACHE_TICK_SECRET` | Generate with `openssl rand -hex 32`; used to protect the cron endpoint           |

Optionally set `SCRAPSCACHE_ADMIN_TOKEN` (long random secret, e.g.
`openssl rand -hex 32`) to enable `/metrics` and the admin API; leaving it unset
disables them entirely.

```sh
docker compose --project-directory . -f docker/compose.yaml --env-file docker/.env pull
docker compose --project-directory . -f docker/compose.yaml --env-file docker/.env up -d
docker compose --project-directory . -f docker/compose.yaml --env-file docker/.env ps
```

Scraps Cache listens on container port **3000**, published on `127.0.0.1` by
default (`SCRAPSCACHE_BIND` to override). The production template:

- Runs with a read-only application filesystem
- Runs physically separate sqld services and named volumes for relay and ops state

### Build locally instead of pulling

```sh
docker build -f docker/Dockerfile -t scrapscache:local .
```

Set `SCRAPSCACHE_IMAGE=scrapscache:local` in `docker/.env`, then use the same
Compose commands as above. Prefer a pinned GHCR image for real deployments.

## Preview a pull-request image

CI publishes each same-repo PR as `dev-<n>` / `dev-sha-<commit>` (amd64 only).
Run that image beside production with a separate Compose project and port:

```sh
cp docker/.env.dev.example docker/.env.dev
# Set SCRAPSCACHE_IMAGE=ghcr.io/volturine/scrapscache:dev-<pr>
docker compose --project-directory . -f docker/compose.dev.yaml --env-file docker/.env.dev pull
docker compose --project-directory . -f docker/compose.dev.yaml --env-file docker/.env.dev up -d
```

Defaults: host port **3000**, project name `scrapscache-dev`, isolated volumes.
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

Set in `docker/.env`:

```sh
TS_HOSTNAME=scrapscache
TS_AUTHKEY=tskey-auth-…   # or tskey-client-…?ephemeral=false
SCRAPSCACHE_ORIGIN=https://scrapscache.your-tailnet.ts.net
```

```sh
docker compose --project-directory . \
  -f docker/compose.yaml -f docker/compose.tailscale.yaml --env-file docker/.env \
  up -d
docker compose --project-directory . \
  -f docker/compose.yaml -f docker/compose.tailscale.yaml --env-file docker/.env \
  exec tailscale tailscale serve status
```

The app is then `https://scrapscache.your-tailnet.ts.net` from any device on the
tailnet. The first HTTPS request can take a few seconds while the certificate is
issued. The host port stays published on loopback for local health checks; use
the `*.ts.net` origin in the browser.

The sidecar uses userspace networking (works on Docker Desktop / macOS) and
persists identity in the `tailscale-state` volume. Serve config lives in
`docker/tailscale/serve.json` (`${TS_CERT_DOMAIN}` is substituted at runtime).
Mount that path as a **directory**, not a single file.

Same overlay works with `docker/compose.dev.yaml` for PR previews. Give that
stack its own hostname (`dev-scrapscache` in `docker/.env.dev.example`) and auth key so it
cannot collide with production.

## Reverse proxy and TLS

Terminate HTTPS at your proxy (Caddy, nginx, Traefik, etc.) and proxy to
`http://127.0.0.1:${SCRAPSCACHE_PORT}`.

1. Set `SCRAPSCACHE_ORIGIN` to the **exact** external HTTPS origin (scheme + host,
   no trailing path).
2. Set HSTS on the proxy only after HTTPS works end-to-end.
3. Client address for rate limits:
   - **Direct** exposure (no proxy): leave `SCRAPSCACHE_ADDRESS_HEADER` empty.
   - **One trusted proxy**: set
     `SCRAPSCACHE_ADDRESS_HEADER=x-forwarded-for` and `SCRAPSCACHE_XFF_DEPTH=1`, and
     configure the proxy to **replace** (not append untrusted) `X-Forwarded-For`.
   - Increase depth only for a known multi-proxy chain.

### Cloudflare Tunnel

Run `cloudflared` on the host with the tunnel service pointing at
`http://localhost:3000`. The Compose port binds to loopback by default, so the
origin is reachable only through the tunnel — do not change `SCRAPSCACHE_BIND`
without another trusted path in front. Set `SCRAPSCACHE_ORIGIN` to the exact
`https://<tunnel-hostname>` origin and apply the one-trusted-proxy
client-address settings above so rate limits see real client IPs.

## Environment reference

### Application / Node

| Variable                                   |                        Default | Purpose                                                                         |
| ------------------------------------------ | -----------------------------: | ------------------------------------------------------------------------------- |
| `SCRAPSCACHE_RELAY_DB_URL`                 |        `http://127.0.0.1:8080` | libSQL URL for relay (accounts, envelopes, deleted_envelopes, quotas)           |
| `SCRAPSCACHE_OPS_DB_URL`                   |        `http://127.0.0.1:8081` | libSQL URL for operational state (rate limits, auth, pairing, push, VAPID)      |
| `SCRAPSCACHE_TICK_SECRET`                  |                       required | Shared secret protecting the `/api/cron/tick` endpoint                          |
| `SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES`       |                   `1000000000` | Relay storage quota per account (1000 MB)                                       |
| `SCRAPSCACHE_SYNC_MAX_CONCURRENT_REQUESTS` |                            `8` | Max sync requests in flight                                                     |
| `SCRAPSCACHE_ADMIN_TOKEN`                  |                          unset | Enables and protects metrics, JSON status, and retention; unset disables them   |
| `SCRAPSCACHE_RETENTION_INACTIVE_DAYS`      |                            `0` | Delete accounts with no authenticated activity for this many days; `0` disables |
| `SCRAPSCACHE_VAPID_PUBLIC_KEY`             |                 auto-generated | Optional stable Web Push VAPID public key                                       |
| `SCRAPSCACHE_VAPID_PRIVATE_KEY`            |                 auto-generated | Optional stable Web Push VAPID private key                                      |
| `SCRAPSCACHE_VAPID_SUBJECT`                | `mailto:scrapscache@localhost` | Contact URI for VAPID (`mailto:` or `https:`)                                   |
| `ADDRESS_HEADER` / `XFF_DEPTH`             |                   direct / `1` | Trusted proxy client-address configuration                                      |

Compose maps `SCRAPSCACHE_ADDRESS_HEADER` → `ADDRESS_HEADER` and
`SCRAPSCACHE_XFF_DEPTH` → `XFF_DEPTH`.

Provide both VAPID key variables or neither. When omitted, Scraps Cache generates a
pair once and persists it in the ops database. Changing the pair causes
browsers to replace their subscription the next time Scraps Cache opens.

If you lose the ops database without setting `SCRAPSCACHE_VAPID_PRIVATE_KEY`,
a new key is generated and existing push subscriptions are rejected by the Web
Push spec — devices must re-register (the server logs a warning when this
happens). To keep subscriptions working across restores, set both VAPID env
variables explicitly.

### Docker Compose helpers

| Variable                      |                 Default | Purpose                                                       |
| ----------------------------- | ----------------------: | ------------------------------------------------------------- |
| `SCRAPSCACHE_BIND`            |             `127.0.0.1` | Host interface the port publishes to                          |
| `SCRAPSCACHE_PORT`            |                  `3000` | Host port published by Compose (loopback by default)          |
| `SCRAPSCACHE_IMAGE`           |         required (prod) | Pinned image tag or digest                                    |
| `SCRAPSCACHE_ORIGIN`          | `http://localhost:3000` | Exact public origin used by SvelteKit                         |
| `SCRAPSCACHE_BODY_SIZE_LIMIT` |                  `110M` | Node adapter request limit; must exceed the 101 MB sync cap   |
| `SCRAPSCACHE_RELAY_SQLD_PORT` |                  `8080` | Host port for the relay sqld HTTP interface                   |
| `SCRAPSCACHE_OPS_SQLD_PORT`   |                  `8081` | Host port for the ops sqld HTTP interface                     |
| `TS_HOSTNAME`                 |           `scrapscache` | Tailnet machine name (`https://<name>.<tailnet>.ts.net`)      |
| `TS_AUTHKEY`                  |                       — | Auth key or OAuth secret; required with the Tailscale overlay |
| `TS_EXTRA_ARGS`               |                       — | Extra `tailscale up` flags (OAuth tag advertisement)          |

Inside Compose, `HOST`, `PORT`, `SCRAPSCACHE_RELAY_DB_URL`, and
`SCRAPSCACHE_OPS_DB_URL` are fixed to their respective sqld services. Direct `docker run`
may override them.

## Health, metrics, and administration

| Endpoint                                   | Auth                                             | Purpose                                             |
| ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `GET /health/live`                         | none                                             | Process liveness                                    |
| `GET /health/ready`                        | none                                             | Database readiness                                  |
| `GET /metrics`                             | `Authorization: Bearer $SCRAPSCACHE_ADMIN_TOKEN` | Prometheus-style metrics                            |
| `GET /api/admin/status`                    | same bearer token                                | Anonymous JSON: storage, users, activity, retention |
| `POST /api/admin/retention`                | same bearer token                                | Run the inactive-account sweeper now                |
| `POST/PUT/DELETE /api/admin/account-quota` | same bearer token                                | Inspect, set, or clear one account's byte quota     |
| `POST /api/cron/tick`                      | `Authorization: Bearer $SCRAPSCACHE_TICK_SECRET` | Run scheduled tasks (cron endpoint)                 |

With no `SCRAPSCACHE_ADMIN_TOKEN` configured, the three token-protected
endpoints return 404 — the admin API is disabled.

The cron endpoint (`/api/cron/tick`) is the scheduler entry point. The included
Cloudflare scheduler Worker calls it through a private service binding every
minute. For self-hosted deployments, add a crontab entry:

```sh
* * * * * curl -sf -X POST -H "Authorization: Bearer $SCRAPSCACHE_TICK_SECRET" http://localhost:3000/api/cron/tick || echo "cron tick failed" >&2
```

`GET /api/admin/status` is the JSON companion to `/metrics`. It reports
ciphertext bytes and decimal GB, account totals, activity in the last 1 / 7 / 30
days, process-lifetime sync counters, and the retention policy. Counts are
aggregates only — no account IDs, ciphertext, or credentials.

Inactive-account retention is **off** unless
`SCRAPSCACHE_RETENTION_INACTIVE_DAYS` is a positive integer. When enabled, a
daily sweep deletes every account with no authenticated activity for that many
days. Last-seen is updated on authenticated sync and push activity, including
pull-only deltas. Enable retention only after live traffic has refreshed
last-seen, or after a deliberate grace period. The sweeper logs deleted counts,
never account IDs.

```sh
curl -fsS -H "Authorization: Bearer $SCRAPSCACHE_ADMIN_TOKEN" \
  http://localhost:3000/api/admin/status
```

The environment value is the default for every account. An authenticated admin
can set a durable per-account override in bytes, or delete it to restore the
default:

```sh
curl -fsS -X PUT \
  -H "Authorization: Bearer $SCRAPSCACHE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"accountId\":\"$ACCOUNT_ID\",\"maxBytes\":2147483648}" \
  "http://localhost:3000/api/admin/account-quota"

curl -fsS -X DELETE \
	-H "Authorization: Bearer $SCRAPSCACHE_ADMIN_TOKEN" \
	-H "Content-Type: application/json" \
	-d "{\"accountId\":\"$ACCOUNT_ID\"}" \
	"http://localhost:3000/api/admin/account-quota"
```

## Images and CI

[`.github/workflows/ci-cd.yaml`](../.github/workflows/ci-cd.yaml):

- Every PR: typecheck + Vitest + Node/Cloudflare builds and Worker dry-runs,
  then an `amd64` image build
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
tokens and TLS configuration carefully. Relay and ops sqld each store their data
in `/var/lib/sqld` on distinct persistent volumes. Back up the relay volume for
durable encrypted sync state. Back up ops as well unless VAPID keys are pinned
in the environment and losing sessions, pairing state, and push registrations is acceptable.
