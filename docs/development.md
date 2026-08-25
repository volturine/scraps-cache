# Development

Contributor-oriented notes for working on Scraps Cache. Also read
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Prerequisites

- Node.js **24** (`.nvmrc`, `package.json` `engines`)
- npm
- Optional: Docker for Compose workflows

## Scripts

| Script                 | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `npm run dev`          | Vite dev server (SvelteKit)                           |
| `npm run build`        | Production build (`adapter-node` → `build/`)          |
| `npm start`            | Run the built server (`node build`)                   |
| `npm run preview`      | Vite preview of the production build                  |
| `npm run check`        | `svelte-check` with native TypeScript                 |
| `npm run format`       | Prettier write                                        |
| `npm run format:check` | Prettier check (also runs in CI / `validate`)         |
| `npm test`             | Vitest once (includes SQLite backup/restore coverage) |
| `npm run test:watch`   | Vitest watch mode                                     |
| `npm run validate`     | check + format + test + build                         |

## Local sync data

By default the Node process stores the relay database under `sync-data/`
(gitignored). Override with `SCRAPSCACHE_SYNC_DATA_DIR`.

When developing sync features, use two browser profiles (or a normal window +
a private window) against the same origin and exercise pairing in the Sync UI.

## Testing layout

- Co-located unit tests: `src/lib/**/*.test.ts`, some component tests
- Shared setup: `src/tests/setup.ts` (e.g. fake IndexedDB)
- Server backup/restore: `syncStore.test.ts` (online backup → reopen) and
  `backupManager.test.ts` (verified snapshots, retention, concurrency, failures)
- Operator monitoring / inactive-account retention: `operatorMonitor.test.ts`,
  `retentionManager.test.ts`, `operatorConfig.test.ts`

Prefer tests for:

- Crypto and backup format edge cases
- Server online backup / restore into a fresh `SyncStore`
- Sync merge / tombstones / quota
- Rate limiting and request validation
- Image optimization invariants

## CI

GitHub Actions workflow: `.github/workflows/ci-cd.yaml`.

- **validate** job: typecheck + Prettier + Vitest + production build (required PR check)
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
