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
| `npm start`                | Run the built server (`node build`)                              |
| `npm run preview`          | Vite preview of the production build                             |
| `npm run check`            | `svelte-check` with native TypeScript                            |
| `npm run format`           | Prettier write                                                   |
| `npm run format:check`     | Prettier check (also runs in CI / `validate`)                    |
| `npm test`                 | Run the Vitest suite                                             |
| `npm run test:watch`       | Vitest watch mode                                                |
| `npm run validate`         | check + format + test + build                                    |

## Local development

By default the app connects to a local sqld instance. Start one with:

```sh
docker run --rm -p 8080:8080 ghcr.io/tursodatabase/libsql-server:latest
```

The dev server reads `http://127.0.0.1:8080/relay` and
`http://127.0.0.1:8080/ops` by default (env vars
`SCRAPSCACHE_RELAY_DB_URL` and `SCRAPSCACHE_OPS_DB_URL`).

Tests use `@libsql/client/node` with `file:` URLs (no sqld required).

When developing sync features, use two browser profiles (or a normal window +
a private window) against the same origin and exercise pairing in the Sync UI.

For Cloudflare Workers local development:

```sh
npm run cf:dev
```

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
