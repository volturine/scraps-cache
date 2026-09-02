# Architecture

Scraps Cache is a **single-page notes client** plus an optional **opaque sync relay**.
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
│  Node / Cloudflare Workers                                 │
│  ┌────────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ /api/sync/*    │  │ rate limit  │  │ sqld (libSQL)   │  │
│  │ pair / delta / │──┤ auth        │──┤ relay + ops DBs  │  │
│  │ register / …   │  │ metrics     │  │                 │  │
│  └────────────────┘  └─────────────┘  └─────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

## Design principles

1. **Offline-first** — IndexedDB is the durable source of truth on each device.
2. **Ciphertext relay** — the server stores slots of encrypted blobs; it never
   receives note plaintext, labels, or attachment bytes.
3. **Simple deployment** — single app process, sqld for state, no
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
| Backups        | `src/lib/backup.ts`, `backupCrypto.ts`                 | Export/import encrypted `.scraps-cache-backup`        |
| Images         | `src/lib/imageOptimize.ts`                             | Resize, WebP, strip EXIF before store/sync            |
| App viewport   | `src/lib/appViewport.ts`                               | Safe area + keyboard frame; overlay host              |
| Reminder wakes | `src/lib/server/wakeDispatch.ts`, `webPush.ts`         | Contentless Web Push ticks; SW reads notes locally    |

### Local data model (conceptual)

- **Notes** — title, body (plain text + checklist lines), color, pins, archive,
  trash, reminder timestamp, label IDs, attachments.
- **Reminder wakes** — optional account-scoped opaque wake IDs and `fireAt`
  timestamps. Each enabled device has independent delivery state, and a device
  does not need the encrypted note before receiving a generic alert. The relay
  never receives note IDs or text.
- **Labels** — named tags with update timestamps for conflict resolution.
- **Boards** — kanban structures + tombstones for cross-device deletion.
- **Sync outbox** — changed record keys scheduled for upload (not a full
  mirror of every field into `localStorage`).
- **Attachments** — full bytes loaded when needed; grid/list may keep thumbnails
  only in memory.

### Sync identity

From a random 32-byte sync key the client derives:

- an Ed25519 signing key; only its public key is registered with the relay
- `accountId` — the stable v1 server-visible account handle derived from the sync key
- One-time pairing code — random 80-bit rendezvous code, shown only while connecting another device

Payload encryption key material is also derived from the sync key. The server
verifies signed one-time challenges and issues 30-minute sessions, but cannot
decrypt envelopes.

Accounts created before proof-of-possession authentication upgrade automatically
replace their stored scrypt credential with the public key after one final legacy
authentication. The account ID and encrypted relay data do not move.

## Server

| Area            | Location                                                 | Responsibility                                  |
| --------------- | -------------------------------------------------------- | ----------------------------------------------- |
| DB layer        | `src/lib/server/db.ts`                                   | sqld/libSQL clients, withTxn, DDL, meta helpers |
| Sync store      | `src/lib/server/syncStore.ts`                            | Relay DB: accounts, envelopes, quotas           |
| Sync auth       | `src/lib/server/syncAuth.ts`                             | Ops DB: challenges, sessions, public key auth   |
| Pairing         | `src/lib/server/pairingSessions.ts`                      | Ops DB: rendezvous for PAKE shares              |
| Delta API       | `src/routes/api/sync/delta/`                             | Upload/download encrypted records, slot deletes |
| Register        | `src/routes/api/sync/register/`                          | Create account credentials                      |
| Reminder wakes  | `src/routes/api/sync/push/*`                             | Device subscriptions + opaque wake ticks        |
| Account delete  | `src/routes/api/sync/account/`                           | Wipe cloud ciphertext for an account            |
| Rate limits     | `src/lib/server/rateLimit.ts`                            | Atomic SQL token bucket on ops DB               |
| Metrics         | `src/lib/server/metrics.ts`, `/metrics`                  | Operator metrics (admin token)                  |
| Operator status | `src/lib/server/operatorMonitor.ts`, `/api/admin/status` | Anonymous JSON usage + activity                 |
| Wake dispatch   | `src/lib/server/wakeDispatch.ts`                         | Pull-based wake claiming and push delivery      |
| Retention sweep | `src/lib/server/retentionSweep.ts`                       | Optional inactive-account sweep (daily gate)    |
| Cron tick       | `src/lib/server/cronTick.ts`                             | Orchestrator for wake + retention + prune       |
| Cron endpoint   | `src/routes/api/cron/tick/`                              | Scheduler entry point for cron triggers         |
| Health          | `/health/live`, `/health/ready`                          | Liveness and readiness probes                   |
| Hooks           | `src/hooks.server.ts`                                    | Security headers, request IDs                   |

### Opaque envelopes

Each synced logical record is uploaded as:

- **slot** — opaque client-chosen identifier for “this logical thing”
- **id** — operation / version identity for idempotent retries
- **ciphertext** — authenticated encrypted blob

The relay can replace or delete by slot without learning whether the payload is
a note, image, label, or board. The storage quota covers active ciphertext,
temporarily retained deletions, and estimated per-record database overhead
(default 1000 MB).

## Deployment shapes

| Mode               | How                             | Notes                                                  |
| ------------------ | ------------------------------- | ------------------------------------------------------ |
| Dev                | `npm run dev`                   | Vite + HMR; sqld required locally                      |
| Workers dev        | `npm run cf:dev`                | Wrangler dev server with workerd runtime               |
| Local prod build   | `npm run build && npm start`    | Node adapter; same env vars as Docker                  |
| Workers prod       | `npm run cf:deploy`             | Cloudflare Workers with sqld or Turso                  |
| Compose            | `docker/compose.yaml`           | Pull pinned GHCR image; sqld sidecar, loopback port    |
| PR preview Compose | `docker/compose.dev.yaml`       | Pull GHCR `dev-*` image on port 3000, isolated volumes |
| Tailscale overlay  | `docker/compose.tailscale.yaml` | Sidecar Serve HTTPS on `*.ts.net` (tailnet only)       |

## Related docs

- [security.md](security.md) — threat model and crypto choices
- [self-hosting.md](self-hosting.md) — operator runbook
- [development.md](development.md) — contributor workflow
