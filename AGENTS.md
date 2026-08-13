# Shard

Offline-first notes with end-to-end encrypted multi-device sync: local IndexedDB storage, SQLite relay storage, backups, and a self-hostable SvelteKit app.

**Stack:** Node.js 24 + SvelteKit 5 + TypeScript · Tailwind CSS 4 · IndexedDB · SQLite · npm

## Commands

```bash
npm install                 # install dependencies
npm run dev                 # start the Vite/SvelteKit development server
npm run check               # Svelte and TypeScript diagnostics
npm run format              # Prettier write
npm run format:check        # Prettier check
npm test                    # Vitest unit tests
npm run build               # production build
npm run validate            # check + format + tests + production build
```

- Use npm commands for dependency changes; do not hand-edit `package.json` or the lockfile.
- Prefer the existing npm scripts over ad-hoc scripts.
- Use two browser profiles when developing or testing device pairing and sync.

## Definition of done

Code/config: `just verify` && `just test` && `just test-e2e` before done or review. Markdown-only: skip unless asked.

- Fix failures and warnings immediately (pre-existing ones when you touch the area). Unfixable third-party stub warnings: inline comment why.
- Add backend tests for new/changed backend behavior.

For this repository, use `npm run validate` in place of the unavailable `just verify`, `just test`, and `just test-e2e` recipes. Markdown-only changes do not require validation unless asked.

## Shard security and privacy

- Preserve the opaque-ciphertext relay model: note contents, labels, attachment bytes, and decryptable keys must never be sent to or stored by the server in plaintext.
- Never log secrets, note content, pairing codes, full account IDs, plaintext keys, or ciphertext payloads.
- Treat changes to cryptography, sync pairing, sync merge and tombstones, backups and restore, authentication, rate limiting, CSP/security headers, and admin endpoints as security-sensitive.
- Add focused tests and perform an extra review for changes in those areas.
- Do not commit `.env`, credentials, real user data, or recoverable plaintext fixtures.

## Principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Problem solving

- Start from the intended outcome, then trace the behavior across every relevant layer before changing code.
- Form a causal explanation and actively look for evidence that disproves it.
- Fix the cause where the responsibility belongs. Prefer clear ownership and isolation boundaries over patches at the point where symptoms appear.
- When one fix reveals another failure, investigate it independently instead of forcing it into the previous explanation.
- Before finishing, be able to explain the root cause, why the symptoms were misleading, what now prevents recurrence, and what evidence proves the fix.
