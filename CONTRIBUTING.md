# Contributing to Scraps Cache

Thanks for your interest in improving Scraps Cache. This guide covers how to develop
locally, what we expect in pull requests, and where design docs live.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- Fix bugs and improve reliability
- Improve documentation and self-hosting guides
- Add tests around sync, crypto, and storage edge cases
- Polish accessibility and mobile UX
- Report security issues privately (see [SECURITY.md](SECURITY.md))

Please open an issue before large architectural changes so we can align on
scope. Privacy-preserving design is a hard requirement: the sync server must
not learn note plaintext.

## Development setup

### Requirements

- **Node.js 24** (see [`.nvmrc`](.nvmrc) and `engines` in `package.json`)
- npm (comes with Node)

### Install and run

```sh
git clone https://github.com/volturine/scraps-cache.git
cd scraps-cache
npm install
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173/` (or `http://<your-lan-ip>:5173/` on Tailscale / LAN).

### Validate before you push

```sh
npm run validate
```

This runs:

1. `svelte-check` (TypeScript / Svelte diagnostics)
2. Prettier check
3. Vitest unit tests (including SQLite online-backup / restore coverage)
4. Production build

Useful partial commands:

| Command                | Purpose                               |
| ---------------------- | ------------------------------------- |
| `npm run check`        | Type / Svelte diagnostics             |
| `npm run format`       | Write Prettier formatting             |
| `npm run format:check` | Check Prettier formatting             |
| `npm test`             | Vitest suite                          |
| `npm run build`        | Production build                      |
| `npm start`            | Run the built Node adapter app        |
| `npm run preview`      | Preview the production build via Vite |

### Docker (optional)

Build and run the development Compose template:

```sh
cp .env.example .env
docker compose up -d --build
```

Production-style deployment is documented in
[docs/self-hosting.md](docs/self-hosting.md).

## Project map

| Path                    | Role                                      |
| ----------------------- | ----------------------------------------- |
| `src/lib/components/`   | UI components                             |
| `src/lib/stores/`       | Client state (notes, sync, kanban, UI)    |
| `src/lib/db/`           | IndexedDB persistence                     |
| `src/lib/server/`       | Sync relay, rate limits, backups, metrics |
| `src/routes/api/sync/`  | HTTP sync and pairing endpoints           |
| `src/routes/api/admin/` | Admin-only status, backup, and retention  |
| `docs/`                 | Architecture, security, self-hosting      |
| `docker/`               | Docker Compose templates and image        |

Deeper orientation: [docs/architecture.md](docs/architecture.md) and
[docs/development.md](docs/development.md).

## Coding guidelines

- Prefer small, focused changes with tests for non-trivial logic.
- Keep the **opaque ciphertext relay** model: never send note content, labels,
  attachment bytes, or decryptable keys to the server in plaintext.
- Do not log secrets, note content, pairing codes, full account IDs, or
  ciphertext payloads.
- Match existing TypeScript / Svelte 5 style in nearby files.
- Format with Prettier (`npm run format`). Editors should format on save;
  `pre-commit` runs lint-staged so staged files are formatted before commit.
- Avoid drive-by refactors unrelated to the change.
- Do not commit `.env`, credentials, or real user data.

## Pull requests

1. Fork and branch from `master` (or open a PR from a branch in this repo if you
   have write access).
2. Keep the PR focused; split unrelated work.
3. Ensure `npm run validate` passes locally.
4. Fill out the pull request template: what changed, why, and how you tested it.
5. Link related issues when applicable.

CI (`.github/workflows/ci-cd.yaml`) runs the full validation suite and an
`amd64` image build on every pull request (published as `dev-*` / `dev-sha-*`,
never `latest`).

### Commit messages

Prefer concise, imperative messages, optionally with a conventional prefix:

- `fix: ...`
- `feat: ...`
- `docs: ...`
- `test: ...`
- `chore: ...`

## Security and privacy reviews

Changes that touch any of the following need extra care and tests:

- `src/lib/syncPairing.ts`, `src/lib/backupCrypto.ts`, `@noble/*` usage
- Sync merge, tombstones, and conflict resolution
- Rate limiting, auth, and admin token checks
- CSP / security headers in `svelte.config.js` and `hooks.server.ts`
- Backup and restore paths

Report vulnerabilities privately per [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
