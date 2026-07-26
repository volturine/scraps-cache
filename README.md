# Shard

Offline-first notes — pins, labels, reminders, and optional cloud sync.

## Develop

```sh
cd shard-notes
npm install
npm run dev -- --host 0.0.0.0
```

Tailscale / LAN: `http://<your-ip>:5173/`

## Build

```sh
npm run build
npm start
```

The production build uses SvelteKit's Node adapter. Sync data is stored in
`sync-data/sync.sqlite`; an existing `sync-data/users.json` is imported once and
left in place as a recovery copy.

Optional server settings:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SHARD_SYNC_DATA_DIR` | `sync-data` | Persistent sync-data directory |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES` | `1000000000` | Ciphertext quota per account |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES` | `50000` | Record quota per account |

`npm run preview` remains useful for locally previewing the built app.

## Docker

Copy the example configuration, review the public URL and quotas, then start the
application:

```sh
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Shard is then available at `http://localhost:3000`. The Compose deployment runs
as an unprivileged user with a read-only application filesystem and stores its
SQLite database in the persistent `shard-sync-data` volume.

For a public deployment, set `SHARD_ORIGIN` to the exact externally visible
HTTPS URL. TLS should terminate at a reverse proxy in front of the container.
The container listens on port 3000; change only `SHARD_PORT` to select a
different host port.

Back up the persistent sync volume before upgrades:

```sh
docker run --rm \
  -v shard-notes_shard-sync-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar -czf /backup/shard-sync-data.tgz -C /data .
```

Restore only while the application is stopped. Existing installations using
`sync-data/users.json` can mount that directory at `/data`; Shard imports the
JSON once and retains it as a recovery copy.

### Docker configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `SHARD_PORT` | `3000` | Host port published by Compose |
| `SHARD_ORIGIN` | `http://localhost:3000` | Exact public origin used by SvelteKit |
| `SHARD_BODY_SIZE_LIMIT` | `110M` | Node adapter request limit; must exceed the 101 MB sync cap |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES` | `1000000000` | Encrypted bytes retained per account |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES` | `50000` | Encrypted records retained per account |

`HOST`, `PORT`, and `SHARD_SYNC_DATA_DIR` are fixed inside the Compose service
to `0.0.0.0`, `3000`, and `/data`. Direct `docker run` deployments may override
them when needed.

## Validate

```sh
npm run validate
```

This runs Svelte/TypeScript diagnostics, the Vitest suite, and a production build.
