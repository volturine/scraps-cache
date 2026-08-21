# Scraps Cache — Full Code Audit

**Date:** 2026-08-21 · **Scope:** all 172 source files under `src/` (server, client crypto/sync, storage, stores, components, routes, config) · **Method:** per-file review by parallel auditors; High/Medium findings re-verified manually against source.

> **Remediation status (2026-08-21):** H1, M1, M3-adjacent, M8, M11, M12 and ~28 Low findings are **fixed** in PR #88 (validated: `npm run validate` green, 336/336 tests). Remaining open items are tracked as issues: #89 (attachment GC grace), #90 (backup syncKey), #91 (VAPID key at rest), #92 (IDB atomicity/memory), #93 (manual merge locking), #94 (localStorage keys), #95 (API hardening batch), #96 (server core batch), #97 (sync polish batch), #98 (storage polish batch), #99 (test-coverage gaps).

---

## Executive summary

The codebase is in strong shape for its threat model. The cryptographic core is unusually careful: CPace PAKE pairing over an 80-bit one-time code, XChaCha20-Poly1305 with fresh nonces and AAD everywhere, OWASP-grade Argon2id (m=19456 KiB, t=2, p=1) for backups, parameterized SQL throughout, constant-time secret comparison, bounded memory on every server path, and no plaintext ever transits the relay. There is **no `{@html}` usage anywhere**, link previews never fetch remote content, and CSP is correctly configured via SvelteKit nonce mode.

Findings: **1 High, 13 Medium, ~40 Low.** The risks are not in the primitives but at state-machine seams: a process-crash path in the wake scheduler, non-atomic local persistence and trash-purge ordering that can resurrect deleted notes, a kanban merge that silently destroys boards edited after deletion, attachment GC racing slower devices, and the sync key being embedded in export files with encryption left to the caller.

| Severity | Count | Themes                                                                           |
| -------- | ----- | -------------------------------------------------------------------------------- |
| High     | 1     | Unhandled rejection crash path (wake scheduler)                                  |
| Medium   | 13    | Data-loss races (merge/purge/GC), non-atomic IDB writes, secret-at-rest exposure |
| Low      | ~40   | Timer/listener cleanup gaps, minor races, hardening, test coverage gaps          |

---

## High

### H1. Wake scheduler can crash the Node process

- **Location:** `src/lib/server/wakeScheduler.ts:108-110`
- **Issue:** `void this.tick()` has no `.catch`. `tick()` uses try/finally but no catch, so any throw from store calls (`claimDueWakes`, `releaseWakeClaim`, `deletePushDevice`, `markWakeDelivered`, `pruneStaleWakes`, `nextWakeAt`) becomes an unhandled promise rejection — which crashes Node by default. Sibling managers (`backupManager.ts:149`, `retentionManager.ts:113`) attach `.catch`; this one doesn't.
- **Fix:** `void this.tick().catch(...)` with structured logging.
- Related (Medium): if `arm()` itself throws inside the `finally` (e.g., SQLite busy in `nextWakeAt`), no timer is armed and the scheduler stalls until an external `nudge()`; also `nudge()` during an in-flight tick is silently overwritten when `arm()` reschedules, delaying delivery up to 30 s. Wrap `arm()` in try/catch with fallback `schedule(FAILED_RETRY_MS)` and coalesce pending nudges.

---

## Medium

### M1. Kanban tombstone merge silently destroys newer edits

- **Location:** `src/lib/kanban.ts:118`
- **Issue:** `mergeKanbanBoards` drops any board with a tombstone entry regardless of timestamps. A board edited on device B _after_ deletion on device A (`board.updatedAt > tombstone time`) is silently destroyed instead of resurrecting or surfacing a conflict — silent data loss under concurrent edit/delete, inconsistent with every other merge path in the file.
- **Fix:** Only filter when `board.updatedAt <= tombstones[board.id]`.

### M2. Attachment slots deleted from relay before slower devices catch up

- **Location:** `src/lib/syncEngine.ts:69-78`
- **Issue:** Attachment slots are deleted from the relay once _this_ device has caught up and nothing locally is pending upload, but a second device that hasn't yet pulled the updated note may still reference the deleted slot — it hydrates a note whose image bytes no longer exist (permanent attachment loss for that device). The guard only inspects local state.
- **Fix:** Relay-side or time-based retention grace for deleted slots (tombstone-delayed GC), or gate deletion on a sync-generation watermark all devices have advanced past.

### M3. Image-list merge drops concurrently added photos

- **Location:** `src/lib/noteMerge.ts:72-75`
- **Issue:** In `hydrateImageList`, if the winning side's image list contains ≥1 image with bytes, fallback-only images (photos added concurrently on the losing device) are silently dropped from the merged note, orphaning their attachments.
- **Fix:** Always union fallback-only images (by id) into the result.

### M4. Backup format embeds the root sync key

- **Location:** `src/lib/backup.ts:40-43` (with `src/lib/stores/notes.svelte.ts:613-615`)
- **Issue:** The portable backup format embeds the raw `syncKey` — the root secret granting full relay account access. Confidentiality of every export rests entirely on callers remembering to run `encryptBackup`; nothing structural enforces it. An unencrypted export leaks all note plaintexts plus the sync identity.
- **Fix:** Make encryption structural: remove `sync.syncKey` from the portable format or have the export API return only `EncryptedScrapsCacheBackup`.

### M5. VAPID private key stored plaintext in SQLite meta table

- **Location:** `src/lib/server/webPush.ts:40-43`
- **Issue:** Auto-generated once and stored plaintext, so every relay backup file contains the push-signing private key; backup-dir compromise allows spoofing pushes to all subscribers.
- **Fix:** Document/encrypt-at-rest, or derive from env-only config.

### M6–M7. Non-atomic IndexedDB writes

- **Locations:** `src/lib/db/idb.ts:232-239`, `src/lib/db/idb.ts:455-466`
- **Issues:**
  - `putNoteSnapshot` writes image blobs as separate auto-commit transactions before the note-row tx; a quota/abort midway leaves some new blobs committed while the note row keeps old state (orphans until boot prune).
  - `replaceAllDeviceData` commits the clear before per-note writes; a mid-loop abort leaves the device half-replaced with local data unrecoverable except via re-sync.
- **Fix:** Single transaction where possible, temp-keys-then-swap, or delete just-written keys / resume remaining notes in the catch path.

### M8. Trash purge removes notes before tombstones are durable

- **Location:** `src/lib/stores/notes.svelte.ts:475-482` (with 332-343 → 723-732)
- **Issue:** `emptyTrash`/`purgeOldTrash` remove notes from memory+mirror before `persistDeletedNotes` finishes; if `writeTombstones` fails, no tombstone reached IDB, so reload resurrects "permanently deleted" notes via `mergeNoteLists`.
- **Fix:** Write tombstones before removing from memory, or roll back memory on failure.

### M9. Manual cloud merge bypasses the sync lock

- **Location:** `src/lib/stores/notes.svelte.ts:998-1066`
- **Issue:** `mergeWithCloudManual` bypasses both `syncFlight` and the `withSyncLock` web lock (calls `syncStore.sync` directly); concurrent with an auto-sync flight it can interleave control-plane clears/writes and corrupt baseline/cursor. On `applyPulledSnapshot` failure (1052-1055) memory is restored but IDB already holds remapped notes.
- **Fix:** Route manual flows through the same lock/flight queue.

### M10. Sync credentials persisted plaintext in localStorage

- **Location:** `src/lib/stores/sync.svelte.ts:189`
- **Issue:** `syncKey` (E2E master key) and `authSecret` sit in `localStorage`, readable by any XSS. Acceptable offline trade-off, but this is the widest-trust secret in the app.
- **Fix:** Consider IndexedDB + non-extractable CryptoKey wrapping, or at minimum document the exposure.

### M11. Logout mid-sync race

- **Location:** `src/lib/stores/sync.svelte.ts:507,513,535,539-545`
- **Issue:** `sync()` captures credentials at loop start; if `logout()` runs mid-sync (multi-round loop up to minutes), the flight keeps encrypting/sending with the removed key and can re-persist state via `commitSyncControl` after logout.
- **Fix:** Check `this.account` per round and abort on change.

### M12. Unbounded quota/reset retry loops

- **Location:** `src/lib/stores/sync.svelte.ts:552-563, 586-594`
- **Issue:** Quota 507 handling retries whole batches as singles without bounding rounds; a relay persistently returning 507 with varying batch composition can loop. Similarly `reset === true` `continue`s without any counter.
- **Fix:** Cap quota-retry iterations and add a reset counter.

---

## Low-severity findings (by area)

### Server core

- `src/lib/server/syncStore.ts:233` — overloaded legacy dual-signature param (`deletionsOrLimit`) is a misuse footgun; split into explicit params.
- `src/lib/server/syncStore.ts:370` — quota projection uses JS UTF-16 `.length` vs SQLite `length()`; diverges for non-ASCII ciphertext (currently unreachable since delta enforces base64url).
- `src/lib/server/syncStore.ts:686-689` — `nextWakeAt` fallback ignores device/delivery join; scheduler can wake for no-op fires.
- `src/lib/server/syncAuth.ts:5-7` — unsalted unstretched SHA-256 credential hash; DB leak permits cheap offline brute force of weak secrets (≥32-char policy mitigates). Consider scrypt/argon2. No `syncAuth.test.ts` exists at all.
- `src/lib/server/rateLimit.ts:48-53` — O(n) full-map prune on every `check()` call.
- `src/lib/server/rateLimit.ts:29-31` — attacker rotating IPs can fill the bucket table and 429 legitimate new clients (documented trade-off).
- `src/lib/server/rateLimit.ts:58-64` — raw socket address keys; behind a proxy all clients share one bucket unless deployment preserves client IPs.
- `src/lib/server/request.ts:27` — repeated string concatenation is O(n²) near the ~101 MB ceiling; collect chunks and join once.
- `src/lib/server/pairingSessions.ts:88-91` — peer cascade deletion makes surviving side see `'not-found'` instead of `'expired'`.
- `src/lib/server/pairingSessions.ts:63-66` — grant can be overwritten repeatedly during window; lock-once would be tighter. Test file has only 2 tests; busy-cap, role restriction, grant overwrite, cascade removal untested.

### Server ops

- `src/lib/server/wakeScheduler.ts:82` — `markWakeDelivered` uses claim-time timestamp; skews delivered-at under long batches.
- `src/lib/server/backupManager.ts:89,113` — `mkdirSync` throws out of `start()`; bad `SCRAPS_CACHE_BACKUP_DIR` can crash boot depending on call site.
- `src/lib/server/backupManager.ts:62-70` — `RETAIN=0` silently falls back to 2; invalid env values ignored without warning.
- `src/lib/server/retentionManager.ts:75` — metrics expose only `lastRunAt`, which looks healthy after persistent failures; expose failures/lastSuccessAt too.
- `src/lib/server/metrics.ts:19` — `/health/*` routes returned verbatim in labels; future parameterized paths would grow cardinality unboundedly.
- `src/lib/server/metrics.ts:110-158` — most series lack `# TYPE` lines (Prometheus text-format inconsistency).
- `src/lib/server/webPush.ts:18` — fallback subject `mailto:scraps-cache@localhost` may be rejected by some push services; log a one-time warning.
- `src/lib/server/pushWakes.ts:127-129` — duplicate-ID check runs after range filter, so duplicates among filtered entries pass while in-range duplicates reject the batch (inconsistent strictness).

### API surface

- `src/hooks.server.ts:11-16` — no HSTS header; HTTPS enforcement left to the proxy (document it or add the header).
- `src/routes/api/admin/backup/+server.ts:6-12` and `admin/retention/+server.ts:6-17` — admin endpoints have no rate limiting unlike every public endpoint; bearer-token guessing is unthrottled.
- `src/routes/api/sync/delta/+server.ts:89-93` — per-account rate-limit bucket consumed _before_ authentication; anyone knowing an accountId can exhaust its bucket and 429 the legitimate client. Move check after credential verification.
- `src/routes/api/sync/delta/+server.ts:15-16` — 100 MB envelope cap × 8 concurrent slots ≈ 800 MB+ parsed strings before quota enforcement; lower toward realistic sizes.
- `src/routes/health/ready/+server.ts:17-20` — unauthenticated endpoint discloses DB readiness and backup health (recon value); reduce detail or restrict to admin.

### Client crypto/sync

- `src/lib/noteMerge.ts:23-25,45-56` — field-level LWW on unsynchronized wall clocks; skew can silently revert newer edits (partially mitigated by monotonic bump). Documented trade-off or Lamport counter.
- `src/lib/syncTombstones.ts:83-85` — empty IDB map treated as "not migrated", conflating never-migrated with legitimately emptied; use an explicit migration marker key.
- `src/lib/backup.ts:158-160` — `fieldTimes` spread through unsanitized; sanitize to finite positive numbers during normalization.
- `src/lib/stores/sync.svelte.ts:118-129,831-837` — poison/unreadable records skipped forever, re-downloaded every sync with repeated decrypt failures; adopt slot ids where safe.

### Client storage

- `src/lib/noteStorage.ts:90-100` — recent-50 mirror fallback failure is fully silent; return a result so callers can surface/retry.
- `src/lib/noteStorage.ts:28-39` — mirrored linkPreviews keep remote image/icon data URLs, inflating localStorage toward quota.
- `src/lib/imageBlob.ts:17-21` — base64 decode holds binary string + typed array (~2× peak per large photo); use `fetch(dataUrl).blob()` or chunked decode.
- `src/lib/imageBlob.ts:5-8` — non-data-URL input passed straight to `fetch`; empty/relative strings fetch the app itself. Reject non-absolute http(s)/blob URLs.
- `src/lib/db/idb.ts:217-239` — dataUrl + Blob + ArrayBuffer copies of every image held simultaneously; convert one at a time.
- `src/lib/db/idb.ts:328-333` — `getAllNotes` hydrates every note's full attachment bytes into memory at once.
- `src/lib/db/idb.ts:587-595` — outbox-generation cache mutated before tx commit; roll back on abort.

### Stores

- `src/lib/stores/notes.svelte.ts:573-583` — `search`: `n.body.toLowerCase()` throws if `body` undefined; use `(n.body ?? '')`.
- `src/lib/stores/notes.svelte.ts:296-323` — failed `putNote` in `flushNote` throws without scheduling `scheduleNoteRetry` (unlike `persist`); IDB stays stale until later write.
- `src/lib/stores/notes.svelte.ts:651-654` — mid-failure `replaceAllDeviceData` leaves device storage partially replaced while memory untouched; layers diverge until reload.
- `src/lib/stores/reminders.svelte.ts:22,128,132` — `seen` Set grows unboundedly (never pruned, unlike `fired`); slow leak.
- `src/lib/stores/reminders.svelte.ts:95-105` — `void Promise.all(...)` without `.catch`; rejection leaves `armed` stale.
- `src/lib/stores/reminders.svelte.ts:91-94` — optimistic `armed` set before publish confirms; failed push briefly suppresses alerts.
- `src/lib/stores/kanban.svelte.ts:119-127` — every reactive change fires unawaited, undebounced overlapping `saveBoardsToDevice` writes that can complete out of order; debounce or serialize through a promise chain.
- `src/lib/stores/kanban.svelte.ts:107,234` — `boardTombstones` never pruned; grows unbounded and uploaded in full each sync.
- `src/lib/stores/kanban.svelte.ts:194-204` — `replaceWithCloud` resets `activeBoardId` even when still valid.
- `src/lib/stores/ui.svelte.ts:44,106` — `view` cast from arbitrary strings without membership validation; corrupted localStorage breaks rendering.

### Components & UI

- `src/lib/components/Sidebar.svelte:77-87` — `navigationFrame`/`navigationTimer` never cancelled on destroy; pending rAF+timeout can invoke `goto()` after teardown.
- `src/lib/components/Sidebar.svelte:248-252` — Enter clears input, firing blur handler which calls `createLabel('')` a second time; guard with finished flag.
- `src/lib/components/SyncModal.svelte:91-117` — poll race: in-flight poll resolving after Cancel overwrites `mode`/`error`, resurrecting waiting UI; re-check state after await.
- `src/lib/components/SyncModal.svelte:228-230` — copy-flash timeout not cleared on destroy.
- `src/lib/components/NoteEditor.svelte:373,388-390` — copy-flash timer uncleared; Escape bound only on overlay so body-focus Escape does nothing (use `svelte:window` like PhotoFullscreen).
- `src/lib/components/PhotoFullscreen.svelte:16-24` — controls timer cleared only in `close()`; fires after parent nulls `activeIndex` or unmount.
- `src/lib/components/NotesFeed.svelte:22-24` — stale deep page reopened after count shrinks/regrows; clamp via `$effect.pre`.
- `src/lib/components/AttachmentFullscreen.svelte:57-59,106-125` — blob-conversion failure of non-text attachments leaves a blank viewer; show error for all types. Also PDF iframe lacks `sandbox`, and `svelte:window` listener attaches even when `attachment` is null.
- `src/lib/components/BackupPassphraseDialog.svelte:44-57` — no focus trap / initial focus move; keyboard users tab behind overlay.
- `src/lib/components/KanbanCard.svelte:101-120` — drag ghost composites onto implicit white base (bright backing in dark mode); seed from theme bg.
- `src/lib/components/KanbanCard.svelte:70-77` — touch-drag relies on `preventDefault` in pointermove; requires `touch-action: none` to work.
- `src/lib/components/NoteBodyDisplay.svelte:53-57,175` — fullscreen viewer tracks positional index; photos changing while open points at wrong/missing photo; track attachment id instead.
- `src/lib/cardSwipe.ts:101,105,115` — three `setTimeout`s never cancelled; callbacks fire against destroyed components. Also `justDragged` not reset on `pointerdown` (click within 50 ms of prior drag wrongly suppressed).
- `src/lib/appViewport.ts:275-284` — teardown leaves published CSS custom properties set on `<html>`.

### Pages & misc lib

- `src/routes/kanban/+page.svelte:348,351` — `columnNotes(...)` evaluated twice per column per render; compute once via `{@const}`.
- `src/lib/utils.ts:120` — `cloneNote` always emits `images: []` even when absent; combined with `stableStringify` not normalizing absent-vs-empty, clones can hash differently from originals.
- `src/tests/structuredClone.ts:1` — self-referential no-op "polyfill" (`globalThis.structuredClone = structuredClone`); delete or guard properly.

---

## Verified-clean highlights

- **No XSS surface:** zero `{@html}` usage across all components/pages; all interpolation text-encoded; link previews built purely from URL strings with http(s)-only regex, no network I/O; external links carry `rel="noreferrer noopener"`.
- **Crypto core sound:** CPace PAKE, bias-free 80-bit pairing codes, XChaCha20-Poly1305 fresh 24-byte nonces, domain-separated key derivation, Argon2id backups with AAD chunk binding and KDF-parameter bounds, derived-key zeroization.
- **Server discipline:** parameterized SQL everywhere, transactional quota with full-batch rollback, CAS conflict logic, claim-lease wake delivery (no double-delivery), timing-safe comparisons done right (including padded `adminAuth`), fail-closed unset admin token, SSRF-hardened push endpoints (https-only, private/link-local/NAT64 blocked), secrets never logged.
- **Sync correctness in the normal path:** outbox generation snapshotting prevents acking mid-flight edits; tombstone filters prevent resurrection; no lost-update bug found in the auto-sync path.
- **SW lifecycle:** registered prod-only with `updateViaCache:'none'`; reminder SW tested against real `static/sw.js` including content-free notifications for unsynced notes.

## Test coverage gaps worth closing

1. `syncAuth` — no dedicated test file at all (timing-safe compare exercised only indirectly).
2. `pairingSessions` — 2 tests total; busy-cap, role-restricted grants, grant overwrite, peer cascade removal untested.
3. `syncStore` — cross-account endpoint/device reassignment, wake lease-expiry re-claim, malformed legacy JSON at startup.
4. Reminder service worker — `notificationclick`, fetch/cache handlers, malformed push payloads.
5. Rate limiter — bucket expiry/pruning, refill capping after long idle.

## Recommended fix order

1. **H1** — one-line crash fix (`tick().catch`) plus `arm()` try/catch.
2. **M1, M2, M3, M8** — the four silent-data-loss paths (kanban merge, attachment GC grace, image-list union, tombstone-before-purge ordering).
3. **M4/M5** — structural backup encryption and VAPID key at rest.
4. **M6–M9** — atomicity and locking around local persistence and manual merge.
5. Delta pre-auth rate-limit bucket (targeted 429 DoS) and admin-endpoint throttling.
6. Low items opportunistically; close the test-coverage gaps alongside them.
