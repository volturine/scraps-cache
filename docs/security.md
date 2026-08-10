# Security and privacy

This document describes Shard's security model for operators and contributors.
For how to report vulnerabilities, see [SECURITY.md](../SECURITY.md).

## Goals

- Keep **note content private** from the sync server and from passive network
  observers when TLS is used.
- Make **multi-device sync** possible without uploading plaintext.
- Provide **user-controlled encrypted backups** independent of the relay.
- Avoid accidental leaks via **logs, metrics, CSP, and link previews**.

## Trust boundaries

| Component | You trust it with | You should not trust it with |
| --- | --- | --- |
| Your browser / device | Local note plaintext, sync key, backup passphrase while entered | Malware, hostile extensions, shared unlocked sessions |
| Self-hosted relay | Ciphertext, auth material hashes, metadata (sizes, timing, IPs if logged) | Note plaintext, sync key, backup passphrase |
| Reverse proxy / TLS terminator | TLS keys, request metadata | Application secrets if misconfigured |
| Client backup file | Ciphertext at rest | Passphrase (never stored in the file) |

## Cryptography overview

### Sync payloads

- Algorithm: **XChaCha20-Poly1305** (`@noble/ciphers`)
- Key: derived from the client-held sync key
  (`shard-sync-payload:v1:…` domain separation via SHA-256)
- Nonce: random 24 bytes per envelope
- Server stores only the packed nonce + ciphertext

### Account authentication

- Sync key → `accountId` and `authSecret` via SHA-256 with domain separation
- Server stores a **credential hash**, not the raw secret in recoverable form
  suitable for decrypting notes (notes were never decryptable server-side)

### Device pairing

- User enters a **14-digit pairing code** derived from the sync key on an
  existing device (or starts a new identity).
- Devices run **CPace** (ristretto255) over the code so they share a session key
  without revealing the code or sync key to the relay.
- The sync key is sealed to the peer with XChaCha20-Poly1305 under the PAKE
  output; the server only relays opaque PAKE shares and ciphertext.

### Client backups (`.shard-backup`)

- Format name: `shard-encrypted-backup`
- KDF: **Argon2id** (parameters stored in the header so they can evolve)
- Bulk encryption: **XChaCha20-Poly1305** in authenticated chunks
- AAD binds format version, KDF params, chunk index, and count
- Passphrase is confirmed on export and **never persisted** by the app

Plaintext legacy backup versions may still import with a warning; new exports
are encrypted only.

### Images

Before store/sync, images are re-encoded in the browser to strip EXIF/GPS,
optionally resize, and prefer WebP. Original camera files are not retained as
the long-term attachment format.

## Server hardening

- **CSP** (nonce mode) in `svelte.config.js`: default `self`, no third-party
  scripts/frames; `data:`/`blob:` only where attachments need them
- **Headers** in `hooks.server.ts`: `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, restrictive
  `Permissions-Policy`
- **Rate limiting** — in-memory token buckets for register, pairing, and sync
- **Admin token** — required for `/metrics` and `POST /api/admin/backup` in
  production Compose
- **No remote link previews** — URL cards are local hostname badges only;
  opening a link is an explicit user action
- **Docker** — unprivileged-oriented Compose, read-only root filesystem,
  `no-new-privileges`, data on volumes

### Logging rules

Logs and error responses must not contain:

- Note content or labels
- Ciphertext or encryption keys
- Authentication secrets or pairing codes
- URLs extracted from notes
- Complete account identifiers when avoidable

Structured logs use request IDs; prefer redacted identifiers.

## Threat model notes

### Mitigated (design intent)

- Curious or compromised **relay operator** reading note bodies from the DB
- Passive network attacker seeing note plaintext (with HTTPS)
- Casual metadata scraping via OpenGraph-style server-side previews
- Cross-site embedding / simple clickjacking (frame denial + CSP)

### Out of scope / residual risk

- Malware on the client device or a malicious browser extension
- XSS in the app itself (defense-in-depth CSP; still treat as critical)
- Traffic analysis (when you sync, envelope sizes, approximate activity)
- Lost backup passphrase or lost sync key without another device / backup
- Active MITM if TLS is misconfigured or users accept bad certificates
- Physical access to an unlocked browser session with IndexedDB data

Local live notes are **not** wrapped in an extra “vault passphrase” while the
app is in use; browser storage isolation is the boundary.

## Operator checklist

1. Terminate **HTTPS** at a reverse proxy; set `SHARD_ORIGIN` to the public URL.
2. Set a strong random **`SHARD_ADMIN_TOKEN`**.
3. Pin **`SHARD_IMAGE`** to a release tag or digest.
4. Configure trusted proxy headers only when appropriate
   (`SHARD_ADDRESS_HEADER` / `SHARD_XFF_DEPTH`).
5. Enable **encrypted Restic** backups for the SQLite snapshots if the relay
   matters to you (ciphertext still deserves availability protection).
6. Run the monthly restore drill documented in
   [self-hosting.md](self-hosting.md).

## Related source

| Topic | Files |
| --- | --- |
| Pairing + payload crypto | `src/lib/syncPairing.ts` |
| Backup crypto | `src/lib/backupCrypto.ts` |
| Relay storage | `src/lib/server/syncStore.ts` |
| Rate limits | `src/lib/server/rateLimit.ts` |
| CSP | `svelte.config.js` |
| Security headers | `src/hooks.server.ts` |
