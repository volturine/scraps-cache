# Development

Contributor-oriented notes for working on Scraps Cache. Also read
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- Node.js **24** (`.nvmrc`, `package.json` `engines`)
- npm
- Optional: Docker for Compose workflows

## Scripts

| Script                     | Description                                                      |
| -------------------------- | ---------------------------------------------------------------- |
| `npm run dev`              | Vite dev server (SvelteKit)                                      |
| `npm run build`            | Production build (`adapter-node` → `build/`)                     |
| `npm run build:cloudflare` | Workers build (`adapter-cloudflare` → `.svelte-kit/cloudflare/`) |
| `npm run cf:cron:dev`      | Scheduled worker + app service binding with test triggers        |
| `npm start`                | Run the built server (`node build`)                              |
| `npm run preview`          | Vite preview of the production build                             |
| `npm run check`            | `svelte-check` with native TypeScript                            |
| `npm run format`           | Prettier write                                                   |
| `npm run format:check`     | Prettier check (also runs in CI / `validate`)                    |
| `npm test`                 | Run the Vitest suite                                             |
| `npm run test:watch`       | Vitest watch mode                                                |
| `npm run validate`         | check + format + test + build                                    |

## Local development

By default the app connects to separate local sqld processes for relay and
operational state. Start them in two terminals:

```sh
docker run --rm -p 8080:8080 ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67
docker run --rm -p 8081:8080 ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67
```

The dev server reads `http://127.0.0.1:8080` and
`http://127.0.0.1:8081` by default (env vars
`SCRAPSCACHE_RELAY_DB_URL` and `SCRAPSCACHE_OPS_DB_URL`).

Tests use `@libsql/client/node` with `file:` URLs (no sqld required).

When developing sync features, use two browser profiles (or a normal window +
a private window) against the same origin and exercise pairing in the Sync UI.

For Cloudflare Workers local development:

```sh
npm run cf:dev
```

The Workers build does not use libSQL or Turso Cloud. Wrangler provides local
D1, R2, and Durable Object persistence. Before the first remote deployment,
create separate production and development resources:

```sh
npx wrangler d1 create scrapscache
npx wrangler d1 create scrapscache-dev
npx wrangler r2 bucket create scrapscache-envelopes
npx wrangler r2 bucket create scrapscache-envelopes-dev
```

Copy the two returned D1 UUIDs into the matching `database_id` entries in
`wrangler.jsonc`. Deployment applies `cf/migrations/` before publishing the app
Worker. `SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES` in `wrangler.jsonc` `vars` must
match the self-host default (`DEFAULT_MAX_ACCOUNT_BYTES` in
`src/lib/server/operatorConfig.ts` and the Docker Compose fallback).

The app and scheduled worker are deliberately separate. Use
`npm run cf:cron:dev` to exercise the Cron Trigger through the private `APP`
service binding. For local multi-worker testing, put the app variables in
`.dev.vars` and the scheduler's matching `SCRAPSCACHE_TICK_SECRET` in
`cf/.dev.vars`; both files are ignored by Git. Configure the secret for both
production Workers before deployment; `npm run cf:deploy` deploys the app first
and then the scheduler.

```sh
npx wrangler secret put SCRAPSCACHE_TICK_SECRET
npx wrangler secret put SCRAPSCACHE_TICK_SECRET --config cf/wrangler.cron.jsonc
```

GitHub Actions reads this value from the `SCRAPSCACHE_TICK_SECRET` environment
secret in the matching `development` or `production` GitHub environment and
installs it on both Workers during every deployment.

The sole open pull request labeled `deploy-dev` deploys the development Workers
to `dev.scrapscache.com` after validation succeeds. Move the label to switch the
shared development environment to another pull request. Deployment fails if
more than one open pull request has the label. Each development deploy deletes
those Workers and wipes D1, then recreates them from the pull request, so
Durable Object and D1 migrations from another PR cannot block it. R2 object
bytes are left in place. Deleting the Workers also drops their secrets, so CI
and `npm run cf:deploy:dev` put `SCRAPSCACHE_TICK_SECRET` back after deploy.
Pushes to `master` deploy the production Workers to `scrapscache.com`. Both use
Worker routes on the existing proxied DNS records, so the records must remain
in place during the cutover.

### Migrating an existing SQLite relay to Cloudflare

The migration copies only the live `sync.sqlite` state. It does not copy the
backup directory, historical JSON exports, or `raw-originals`. Encrypted sync
envelopes—including attachment records—are streamed to R2; account and routing
metadata are written to D1. The importer also converts the legacy VAPID key
pair so existing reminder push subscriptions remain usable.

Run a staged import while the existing deployment is still serving traffic:

```sh
python3 scripts/migrate_sqlite_to_cloudflare.py stage /absolute/path/to/sync.sqlite
```

Immediately before the production cutover, stop the old application so the
database cannot receive another write. Then rerun the import against the final
snapshot:

```sh
python3 scripts/migrate_sqlite_to_cloudflare.py finalize \
  /absolute/path/to/sync.sqlite --source-stopped
```

`finalize` snapshots SQLite with its WAL, uploads deterministic R2 objects,
replaces the migrated D1 state, verifies every R2 object's length and SHA-256
digest, and removes objects made obsolete by an earlier staged import. Do not
restart the old application after finalization. If it must be restarted during
a rollback, stop it and finalize again before retrying the Workers cutover.

## Testing layout

- Co-located unit tests: `src/lib/**/*.test.ts`, some component tests
- Shared setup: `src/tests/setup.ts` (e.g. fake IndexedDB)
- Operator monitoring: `operatorMonitor.test.ts`, `operatorConfig.test.ts`
- Wake dispatch and retention sweep: `wakeDispatch.test.ts`, `retentionSweep.test.ts`

Prefer tests for:

- Crypto and backup format edge cases
- Sync merge / tombstones / quota
- Rate limiting and request validation
- Image optimization invariants

## CI

GitHub Actions workflow: `.github/workflows/ci-cd.yaml`.

- **validate** job: typecheck + Prettier + Vitest + Node and Cloudflare builds,
  including dry-run validation of both Workers (required PR check)
- **image** job: Docker build; PRs publish `dev-<n>` / `dev-sha-*` only, `master`
  publishes `latest` / `master` / `sha-*`

Dependabot (`.github/dependabot.yml`) updates npm, Docker, and GitHub Actions
weekly.

## Debugging tips

- CSP is strict in production config; if a new asset source is required, update
  `svelte.config.js` deliberately and document why.
- Admin endpoints need `SCRAPSCACHE_ADMIN_TOKEN` once you leave the dev Compose
  default.
- Structured logs on API errors include `requestId` — pass `x-request-id` from
  clients when correlating.

## Documentation

| Doc                                | Use when                             |
| ---------------------------------- | ------------------------------------ |
| [architecture.md](architecture.md) | Understanding modules and data flow  |
| [security.md](security.md)         | Touching crypto, headers, or logging |
| [self-hosting.md](self-hosting.md) | Changing env vars or Compose         |
