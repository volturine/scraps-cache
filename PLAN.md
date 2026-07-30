# Shard Production Hardening Plan

## Goal

Keep Shard's current offline-first SvelteKit and SQLite architecture while
hardening it for:

- Approximately 10,000 accounts
- Approximately 100 simultaneously syncing clients
- Thousands of notes in an individual account
- Strong client-side privacy
- Simple single-server operation
- Reliable, configurable backups

The existing architecture remains intentionally simple: one application
instance, one SQLite database, offline-first browser clients, opaque encrypted
cloud records, and automated encrypted backups.

## 1. Encrypted user backups

Replace plaintext JSON exports with encrypted `.shard-backup` files.

- Perform all encryption and decryption in the browser.
- Ask the user for a backup passphrase when exporting or importing.
- Derive the backup key with Argon2id and a unique random salt.
- Start with 19 MiB of memory, 2 iterations, and parallelism 1. Store the
  algorithm and parameters in the backup header so they can evolve later.
- Encrypt authenticated chunks with XChaCha20-Poly1305.
- Authenticate the format version, chunk type, position, and total count so
  corruption, truncation, or reordering fails safely.
- Include notes, attachments, labels, boards, settings, tombstones, and the
  sync key inside the encrypted payload.
- Require passphrase confirmation during export and never persist the
  passphrase.
- Continue importing plaintext backup versions 1 through 3, with a warning,
  but produce only encrypted version 4 backups.
- Validate and decrypt an import completely before replacing existing device
  data.
- Request persistent browser storage with `navigator.storage.persist()` and
  show whether the browser granted it.
- Remind users when they have not created an encrypted backup for 30 days or
  after substantial changes.

Live IndexedDB data remains protected by the browser and operating-system
sandbox. A separately locked local vault is outside this phase.

## 2. Client-side image optimization

Optimize images in the browser before they enter IndexedDB or sync.

- Correct image orientation.
- Re-encode images through canvas to strip EXIF and GPS metadata.
- Never upscale an image.
- Limit the longest edge to 2560 pixels.
- Encode photographic images as WebP at approximately 82% quality.
- Preserve transparency where needed.
- Use a lossless or high-quality WebP path for screenshots and line art.
- Iteratively reduce quality or dimensions when the result exceeds
  approximately 4 MiB.
- Treat formats the browser cannot decode as ordinary files instead of
  silently discarding them.
- Explain in the attachment UI that images are optimized and originals are not
  retained.
- Add optional `width`, `height`, `byteSize`, and `encodingVersion` fields to
  `NoteImage`.

There is no small user-facing image input limit. The processed image must fit
within the account's 1 GB quota. Non-image files remain subject to the relay's
hard envelope limit and the account quota.

## 3. Frontend-only URL cards

Remove remote link previews entirely.

- Remove the `/api/link-preview` server endpoint.
- Do not fetch OpenGraph metadata, page titles, descriptions, images, favicons,
  or icons.
- Parse URLs directly from note text in the browser.
- Display a local card containing the hostname, shortened path, and a generated
  site badge.
- Do not contact the linked website until the user explicitly opens the link.
- Keep links clickable with `noopener` and `noreferrer`.
- Accept legacy notes and backups containing `linkPreviews`, but ignore the
  metadata and remove it during the next save or encrypted export.

Rendering a note containing a URL must generate no preview-related network
traffic.

## 4. Large-account client performance

Make accounts with thousands of notes responsive without adding a second
database or hosted search service.

- Keep IndexedDB as the durable source of truth.
- Stop mirroring the complete note collection into size-limited
  `localStorage`.
- Retain only minimal boot state, UI preferences, and a small recent-note cache
  in `localStorage`.
- Move sync cursors, record fingerprints, migration state, and pending changes
  into IndexedDB.
- Add a persistent sync outbox containing only changed record keys.
- Hash and upload only changed records during ordinary sync.
- Retain a periodic full reconciliation pass as repair logic.
- Make sync single-flight. Edits arriving during a sync schedule exactly one
  follow-up pass.
- Replace render-all note feeds with windowed or incremental rendering.
- Keep no more than approximately 300 to 400 note cards mounted at once.
- Preserve pinned sections, ordering, search, archive, trash, labels, and both
  grid and list layouts.
- Keep full attachment bytes out of memory unless a note is opened, exported,
  or actively syncing.
- Preserve the current automatic sync behavior: begin a sync approximately
  five seconds after the last edit and immediately when manually requested.

The client acceptance dataset contains at least 5,000 notes with labels,
reminders, tombstones, and optimized images.

## 5. SQLite sync scalability

Keep SQLite WAL and the existing opaque slotted-envelope design.

- Add `envelope_count` and `ciphertext_bytes` columns to `accounts`.
- Backfill both values transactionally during migration.
- Maintain the values on every insert, replacement, and deletion.
- Remove the per-sync `COUNT` and `SUM` scan.
- Add opaque slot deletion so removed attachments and obsolete records release
  quota without revealing their type or plaintext identity.
- Make upload and deletion operations idempotent using opaque operation IDs.
- Return current encrypted storage usage with successful sync responses.
- Keep the default account limits at 1 GB and 50,000 current envelopes.
- Keep both limits configurable through environment variables.
- Preserve compatibility with clients that do not yet send slot deletions.

### Sync API changes

`POST /api/sync/delta` accepts an optional field:

```ts
deleteSlots?: Array<{
	slot: string;
	id: string;
}>;
```

Successful responses include:

```ts
usage: {
	ciphertextBytes: number;
	envelopeCount: number;
	maxBytes: number;
	maxEnvelopes: number;
};
```

### Cloud-account deletion

Add:

```http
DELETE /api/sync/account
```

- Authenticate with the existing `accountId` and `authSecret`.
- Delete the account and every associated envelope in one transaction.
- Return an indistinguishable authentication failure for missing and incorrect
  credentials.
- Delete cloud ciphertext only. Local notes remain unless the user separately
  chooses to erase them.
- Require an explicit destructive confirmation in the sync settings UI.

## 6. Abuse resistance

Add lightweight, bounded in-memory token-bucket rate limiting for the selected
single-node deployment.

Initial defaults:

- Registration: 5 attempts per hour per client address, burst 2
- Pairing start, poll, and approval: 60 requests per minute per client address
- Sync: 60 requests per minute per account with a small burst
- A bounded server-wide number of simultaneous large sync requests

Additional behavior:

- Return `429 Too Many Requests` with `Retry-After`.
- Bound the limiter's memory and expire inactive keys.
- Configure trusted proxy headers and proxy depth explicitly.
- Do not trust arbitrary forwarded-address headers.
- Record aggregate rate-limit events without logging full addresses, account
  identifiers, request bodies, or credentials.

## 7. Browser and transport security

Add a restrictive Content Security Policy through SvelteKit configuration.

- Restrict scripts and connections to Shard itself.
- Allow `data:` and `blob:` only where attachments require them.
- Block third-party images, frames, objects, and scripts.
- Set `frame-ancestors 'none'`.
- Set `base-uri 'none'`.
- Set `form-action 'self'`.
- Add `Referrer-Policy: no-referrer`.
- Add `X-Content-Type-Options: nosniff`.
- Add a restrictive `Permissions-Policy`.
- Require HTTPS for public deployments.
- Configure HSTS at the trusted reverse proxy.

Logs and error responses must never contain:

- Note content or labels
- Ciphertext or encryption keys
- Authentication secrets
- Pairing codes
- URLs extracted from notes
- Complete account identifiers

## 8. Automated server backups

Use SQLite's online backup API instead of copying a live database and its WAL
files.

Each backup run must:

1. Create a consistent temporary SQLite snapshot.
2. Open the snapshot and run an integrity check.
3. Atomically publish the verified snapshot.
4. Back it up into an encrypted local Restic repository.
5. Optionally back it up into a second S3-compatible Restic repository.
6. Apply retention only after the new backup succeeds.

Defaults:

- Run once every 24 hours.
- Make the interval configurable.
- Retain 7 daily, 4 weekly, and 12 monthly snapshots.
- Enable the encrypted local repository.
- Keep the S3-compatible destination optional.
- Mount Restic passwords and S3 credentials from secret files.
- Never commit backup credentials or place them in command-line arguments.

Provide documented commands for:

- Run a backup immediately
- List available snapshots
- Check repository metadata and data
- Restore into an empty volume
- Validate the restored SQLite database
- Start Shard against the restored data

Add a restore smoke test to CI and document a monthly operator restore drill.

The default server-backup recovery point is up to 24 hours. Linked devices may
retain newer local changes and repopulate a restored or reset relay.

## 9. Health and observability

Add:

```text
/health/live
/health/ready
/metrics
```

`/health/live` reports only whether the process is alive.

`/health/ready` verifies:

- SQLite can be queried.
- Database migrations are complete.
- The data volume is writable.
- The backup process is not stuck or repeatedly failing.

Protect `/metrics` with an administrative secret or private network access. It
should expose:

- Request counts, status codes, and latency
- Rate-limit events
- SQLite busy time
- Sync batch sizes
- Aggregate envelope and ciphertext-byte totals
- Last attempted and last successful backup times
- Backup duration and failure count

Use structured JSON logs with request IDs and redacted identifiers. Close
SQLite and stop backup jobs through SvelteKit's graceful shutdown lifecycle.

Pin release image tags in production rather than deploying `latest`.

## 10. Testing and acceptance criteria

### Backup and cryptography

- The correct passphrase restores every field and attachment.
- An incorrect passphrase changes no existing device data.
- A modified header, corrupted chunk, missing chunk, reordered chunk, or
  truncated file fails safely.
- Plaintext backup versions 1 through 3 still import.
- Large exports do not load every full attachment into memory simultaneously.

### Privacy

- Rendering notes containing URLs produces no preview network requests.
- Optimized images contain no EXIF or GPS metadata.
- CSP blocks third-party scripts, images, frames, and objects.
- Logs and error responses contain no secrets or user content.

### Sync correctness

- Slot deletion updates usage counters transactionally.
- Retried uploads and deletions are idempotent.
- Existing clients without deletion support continue syncing.
- Older offline devices cannot resurrect a newer deletion.
- Interrupted pagination resumes without skipped records.
- Relay reset and bootstrap converge correctly.
- Quota failures roll back the complete request.
- Account deletion removes every associated envelope.

### Client performance

With 5,000 notes in one account:

- The application becomes interactive within 3 seconds on the reference
  desktop profile and 5 seconds on the mobile profile.
- Search completes within 150 ms.
- No more than 400 note cards are mounted.
- Opening and editing one note does not rebuild every attachment or sync record.

### Server load

Use a reproducible fixture containing:

- 10,000 registered accounts
- At least 1,000,000 current envelopes
- 100 concurrently syncing clients

Required results on the documented reference server:

- Small-delta sync p95 below 750 ms
- Error rate below 0.5%
- No skipped or duplicated sync state
- Event-loop delay p99 below 200 ms
- Bounded memory during large requests and online backups

### Recovery

- Restore a local snapshot into an empty volume and pass integrity checks.
- Restore using only the configured S3-compatible repository.
- Existing device credentials work against the restored relay.
- Devices resume delta sync without recreating their sync account.
- Recovery documentation contains every required command and configuration
  value.

## Implementation order

1. Remove remote previews and add local URL cards.
2. Add security headers and log redaction.
3. Add client-side image optimization and metadata removal.
4. Implement encrypted client backups.
5. Replace full `localStorage` mirrors and add the IndexedDB sync outbox.
6. Add incremental or windowed note rendering.
7. Add SQLite usage counters and opaque slot deletion.
8. Add rate limiting and cloud-account deletion.
9. Add health endpoints, protected metrics, and graceful database shutdown.
10. Add automated local and S3-compatible server backups.
11. Run privacy, recovery, client-scale, and server-load validation.

## Scope boundaries

- The production target is approximately 10,000 accounts and 100 concurrently
  syncing clients.
- The deployment remains one SvelteKit Node process and one SQLite database.
- The default cloud quota remains 1 GB per account.
- Images are optimized client-side and originals are not retained.
- Local live notes are not protected by an additional application passphrase.
- Client exports are independently recoverable with their backup passphrase.
- Rich remote link metadata is intentionally removed.
- Server backups run daily by default and are configurable.
- Active/active application nodes and zero-downtime database failover are out of
  scope.
- A Postgres or object-storage migration should occur only if repeatable load
  tests show that the single-node design has reached its measured limit.
