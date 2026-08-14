# Architecture

Shard is a **single-page notes client** plus an optional **opaque sync relay**.
The same SvelteKit app serves the UI and the sync API when self-hosted.

## High-level layout

```text
┌────────────────────────────────────────────────────────────┐
│  Browser (PWA)                                             │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │ UI (Svelte 5)│  │ Stores      │  │ IndexedDB         │  │
│  │ routes +     │◄─┤ notes/sync  │◄─┤ notes, outbox,    │  │
│  │ components   │  │ kanban/ui   │  │ attachments, …    │  │
│  └──────────────┘  └──────┬──────┘  └───────────────────┘  │
│                           │ encrypt / decrypt locally      │
└───────────────────────────┼────────────────────────────────┘
                            │ HTTPS (opaque envelopes)
┌───────────────────────────▼────────────────────────────────┐
│  Node (SvelteKit adapter-node)                             │
│  ┌────────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ /api/sync/*    │  │ rate limit  │  │ SQLite          │  │
│  │ pair / delta / │──┤ auth        │──┤ accounts +      │  │
│  │ register / …   │  │ metrics     │  │ encrypted slots │  │
│  └────────────────┘  └─────────────┘  └─────────────────┘  │
│  Online SQLite snapshots → optional Restic (Compose)       │
└────────────────────────────────────────────────────────────┘
```

## Design principles

1. **Offline-first** — IndexedDB is the durable source of truth on each device.
2. **Ciphertext relay** — the server stores slots of encrypted blobs; it never
   receives note plaintext, labels, or attachment bytes.
3. **Single node simplicity** — one app process, one SQLite file (WAL), no
   required Redis/Postgres/object store for core operation.
4. **Client-side crypto** — sync keys, backup passphrases, and encryption live
   in the browser using audited primitives (`@noble/*`, CPace).

## Client

| Area           | Location                                               | Responsibility                                        |
| -------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Routes / pages | `src/routes/`                                          | Notes home, kanban, reminders, archive, trash, labels |
| Components     | `src/lib/components/`                                  | Editors, feed, sidebar, sync UI, backup dialogs       |
| Domain types   | `src/lib/types.ts`                                     | Notes, labels, attachments, colors                    |
| Notes state    | `src/lib/stores/notes.svelte.ts`                       | CRUD, search, trash, labels                           |
| Sync state     | `src/lib/stores/sync.svelte.ts`                        | Pairing, auto-sync, cloud status                      |
| Kanban         | `src/lib/stores/kanban.svelte.ts`, `src/lib/kanban.ts` | Boards and columns                                    |
| IndexedDB      | `src/lib/db/idb.ts`                                    | Persistence, outbox, replace/import                   |
| Sync crypto    | `src/lib/syncPairing.ts`                               | Identity, pairing PAKE, payload encrypt/decrypt       |
| Sync records   | `src/lib/syncRecords.ts`, `noteMerge.ts`               | Envelope packing, merge, tombstones                   |
| Backups        | `src/lib/backup.ts`, `backupCrypto.ts`                 | Export/import encrypted `.shard-backup`               |
| Images         | `src/lib/imageOptimize.ts`                             | Resize, WebP, strip EXIF before store/sync            |
| App viewport   | `src/lib/appViewport.ts`                               | Safe area + keyboard frame; overlay host              |

### Local data model (conceptual)

- **Notes** — title, body (plain text + checklist lines), color, pins, archive,
  trash, reminder timestamp, label IDs, attachments.
- **Labels** — named tags with update timestamps for conflict resolution.
- **Boards** — kanban structures + tombstones for cross-device deletion.
- **Sync outbox** — changed record keys scheduled for upload (not a full
  mirror of every field into `localStorage`).
- **Attachments** — full bytes loaded when needed; grid/list may keep thumbnails
  only in memory.

### Sync identity

From a random 32-byte sync key the client derives:

- `accountId` — server-visible account handle (hash-derived)
- `authSecret` — credential presented to the relay (hash-derived)
- One-time pairing code — random 80-bit rendezvous code, shown only while connecting another device

Payload encryption key material is also derived from the sync key. The server
verifies `accountId` + `authSecret` but cannot decrypt envelopes.

## Server

| Area           | Location                                | Responsibility                                   |
| -------------- | --------------------------------------- | ------------------------------------------------ |
| Sync store     | `src/lib/server/syncStore.ts`           | SQLite accounts, envelopes, quotas, migrations   |
| Delta API      | `src/routes/api/sync/delta/`            | Upload/download encrypted records, slot deletes  |
| Register       | `src/routes/api/sync/register/`         | Create account credentials                       |
| Pairing        | `src/routes/api/sync/pair/*`            | Rendezvous for PAKE shares (no plaintext key)    |
| Account delete | `src/routes/api/sync/account/`          | Wipe cloud ciphertext for an account             |
| Rate limits    | `src/lib/server/rateLimit.ts`           | In-memory token buckets (single-node)            |
| Backups        | `src/lib/server/backupManager.ts`       | Online SQLite snapshot + integrity check         |
| Metrics        | `src/lib/server/metrics.ts`, `/metrics` | Operator metrics (admin token)                   |
| Health         | `/health/live`, `/health/ready`         | Liveness and readiness probes                    |
| Hooks          | `src/hooks.server.ts`                   | Security headers, request IDs, graceful shutdown |

### Opaque envelopes

Each synced logical record is uploaded as:

- **slot** — opaque client-chosen identifier for “this logical thing”
- **id** — operation / version identity for idempotent retries
- **ciphertext** — authenticated encrypted blob

The relay can replace or delete by slot without learning whether the payload is
a note, image, label, or board. Usage counters track encrypted byte and envelope
counts per account for quotas (default 1 GB / 50k envelopes).

## Deployment shapes

| Mode               | How                              | Notes                                                  |
| ------------------ | -------------------------------- | ------------------------------------------------------ |
| Dev                | `npm run dev`                    | Vite + HMR; sync data under `sync-data/` by default    |
| Local prod build   | `npm run build && npm start`     | Node adapter; same env vars as Docker                  |
| Dev Compose        | `docker/compose.yaml`            | Build local image, loose admin token default           |
| PR preview Compose | `docker/compose.dev.yaml`        | Pull GHCR `dev-*` image on port 3000, isolated volumes |
| Prod Compose       | `docker/compose.production.yaml` | Pull GHCR image, require admin token + image pin       |
| Tailscale overlay  | `docker/compose.tailscale.yaml`  | Sidecar Serve HTTPS on `*.ts.net` (tailnet only)       |
| Backup overlay     | `docker/compose.backup.yaml`     | Restic local and/or S3 encrypted repos                 |

## Related docs

- [security.md](security.md) — threat model and crypto choices
- [self-hosting.md](self-hosting.md) — operator runbook
- [development.md](development.md) — contributor workflow
