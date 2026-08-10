# Shard

**Offline-first notes** that stay on your device — with optional **end-to-end
encrypted** sync when you want the same notes on another phone or laptop.

Shard is a self-hostable notes app: pins, labels, reminders, checklists,
attachments, kanban boards, trash/archive, and a ciphertext-only sync relay.
The server never sees your note contents.

[![CI/CD](https://github.com/volturine/shard-notes/actions/workflows/ci-cd.yaml/badge.svg)](https://github.com/volturine/shard-notes/actions/workflows/ci-cd.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24-brightgreen.svg)](.nvmrc)

---

## Why Shard

| Principle | What it means |
| --- | --- |
| **Works offline** | Notes live in the browser (IndexedDB). No network required for day-to-day use. |
| **E2E encrypted sync** | Optional multi-device sync uploads opaque ciphertext only. |
| **Self-hosted** | Run the app and relay yourself. One Node process, one SQLite database. |
| **Private by design** | No remote link previews, no third-party trackers, restrictive CSP. |
| **Recoverable** | Encrypted client backups (`.shard-backup`) and operator-friendly server snapshots. |

## Features

- **Notes** — title, body, colors, pins, archive, trash
- **Checklists** — `[ ]` / `[x]` lines in the note body
- **Labels** — organize and filter notes
- **Reminders** — time-based reminders view
- **Attachments** — photos and files; images optimized client-side (EXIF stripped)
- **Kanban** — boards with custom backlog filters
- **Search** — local full-text style filtering on your device
- **Sync** — pair devices with a short code; server stores encrypted envelopes only
- **Backups** — passphrase-protected client exports; optional automated SQLite + Restic on the server
- **PWA** — installable shell with a service worker

## Quick start (development)

Requires **Node.js 24** (see [`.nvmrc`](.nvmrc)).

```sh
git clone https://github.com/volturine/shard-notes.git
cd shard-notes
npm install
npm run dev -- --host 0.0.0.0
```

Open `http://localhost:5173/` (or your LAN / Tailscale IP on port `5173`).

```sh
npm run validate   # check + tests + restore smoke + production build
npm run build && npm start   # production Node adapter on port 3000 by default
```

## Self-host (Docker)

The recommended production path pulls the multi-arch image from GitHub Container Registry:

```sh
cp .env.example .env
# Edit .env: set SHARD_IMAGE, SHARD_ADMIN_TOKEN, and SHARD_ORIGIN for public HTTPS
docker compose --project-directory . -f docker/compose.production.yaml pull
docker compose --project-directory . -f docker/compose.production.yaml up -d
```

App: `http://localhost:3000` (or the origin you configured).

Full operator guide — reverse proxy, backups, restore drill, env reference:

**→ [docs/self-hosting.md](docs/self-hosting.md)**

Published images:

- `ghcr.io/volturine/shard-notes:latest` (master)
- `ghcr.io/volturine/shard-notes:<version>` (tags like `v1.2.3`)
- `ghcr.io/volturine/shard-notes:sha-<commit>`

Prefer a **pinned tag or digest**, not floating `latest`, for production.

## How privacy works (short)

```text
┌─────────────┐     encrypted envelopes      ┌──────────────────┐
│  Browser    │ ───────────────────────────► │  Sync relay      │
│  IndexedDB  │ ◄─────────────────────────── │  SQLite (opaque) │
│  (plaintext │     ciphertext only          │  no note content │
│   locally)  │                              └──────────────────┘
└─────────────┘
```

1. Notes are created and stored **locally**.
2. If sync is enabled, the client encrypts payloads with a device-held sync key
   (XChaCha20-Poly1305) before upload.
3. Pairing transfers that key between devices using a short code and **CPace**
   (PAKE) so the relay never sees the key in the clear.
4. User-triggered **backups** are encrypted with Argon2id + a passphrase in the
   browser.

Details, threat model, and limits: **[docs/security.md](docs/security.md)**.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | System layout, data flow, major modules |
| [docs/security.md](docs/security.md) | Crypto, threat model, headers, logging rules |
| [docs/self-hosting.md](docs/self-hosting.md) | Docker, env vars, backups, restore, metrics |
| [docs/development.md](docs/development.md) | Local workflow, testing, CI |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards |

## Stack

- [SvelteKit](https://svelte.dev/) + Svelte 5 + TypeScript
- Tailwind CSS 4
- IndexedDB (`idb`) on the client; SQLite (`better-sqlite3`) on the server
- [@noble](https://paulmillr.com/noble/) cryptography + [CPace](https://github.com/cipherman/pake-js) for pairing
- Node adapter for self-hosting; multi-arch Docker images via GHCR

## Status

Shard is under active development. APIs and on-disk formats may evolve; releases
aim to keep backup import and sync recoverable across supported versions.
Please file issues for bugs and ideas.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
coding guidelines, and PR expectations.

- **Bugs / features** — [GitHub Issues](https://github.com/volturine/shard-notes/issues)
- **Security** — private report via [SECURITY.md](SECURITY.md) (do not open a public issue)

## License

[MIT](LICENSE) © 2026 Roland Rajcsanyi
