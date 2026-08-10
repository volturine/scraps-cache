# Security policy

Shard is designed as a privacy-preserving notes app: note content is encrypted
on the client before optional cloud sync, and the relay stores opaque ciphertext.

## Supported versions

Security fixes are applied to the latest release on `master` and to the most
recent tagged semantic version when practical. Older tags may not receive
backports.

| Version | Supported |
| --- | --- |
| Latest `master` | Yes |
| Latest tagged release | Yes |
| Older tags | Best effort only |

## What Shard protects

- **Local notes** live in the browser (IndexedDB). They are protected by the
  browser and OS sandbox, not by an extra app passphrase while the app is open.
- **Cloud sync** uploads encrypted envelopes only. The server authenticates
  accounts but never receives plaintext notes, labels, attachments, or keys.
- **Device pairing** transfers the sync key using a short code and a PAKE
  (CPace), so the relay does not learn the key in the clear.
- **User backups** (`.shard-backup`) are encrypted client-side with Argon2id +
  XChaCha20-Poly1305 under a user-chosen passphrase.
- **Server snapshots** of the SQLite relay database contain only ciphertext and
  account credentials needed for sync auth — not readable note content.

## What Shard does not claim

- Local live data is not an additional encrypted vault while the browser can
  access IndexedDB.
- A compromised device, malicious browser extension, or malicious self-host
  operator who controls the client you run can still harm you.
- The default sync server (if you self-host one) is a ciphertext relay: it can
  still observe metadata such as account activity, envelope sizes, and timing.

For design detail, see [docs/security.md](docs/security.md).

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Prefer one of:

1. **GitHub Security Advisories** — open a private report on
   [volturine/shard-notes](https://github.com/volturine/shard-notes/security/advisories/new)
2. **Email** — if advisories are unavailable, contact the maintainer through
   the GitHub profile listed on the repository

Include as much of the following as you can:

- Description of the issue and impact
- Steps to reproduce or a minimal proof of concept
- Affected version / commit SHA
- Whether the issue is already public

We aim to acknowledge reports within **7 days** and to provide a status update
within **14 days**. Coordinated disclosure is preferred; please give us a
reasonable window before public discussion when the issue is not already known.

## Scope highlights

In scope examples:

- Cryptography or key-handling bugs (sync, pairing, backups)
- Authentication bypass on sync or admin endpoints
- Cross-account data access on the relay
- Injection or XSS that exposes note content or secrets
- Path traversal or remote code execution in the Node/Docker deployment
- Secrets or user content leaking into logs or metrics

Out of scope examples (unless they lead to a practical exploit):

- Denial of service without a realistic amplification path
- Issues that require a fully compromised client device or physical access
- Misconfiguration of a third-party reverse proxy outside our documented guidance
- Dependency vulnerabilities already fixed on `master` or with no reachable path

## Safe harbor

We will not pursue legal action against good-faith security research conducted
within this policy, that does not violate privacy of others, destroy data, or
disrupt production services without prior coordination.
