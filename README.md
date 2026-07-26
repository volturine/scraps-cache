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

### Pull the published image

The recommended server deployment pulls the multi-architecture image published
to GitHub Container Registry:

```sh
cp .env.example .env
docker compose -f compose.production.yaml pull
docker compose -f compose.production.yaml up -d
docker compose -f compose.production.yaml ps
```

Shard is then available at `http://localhost:3000`. The Compose deployment runs
as an unprivileged user with a read-only application filesystem and stores its
SQLite database in the persistent `shard-sync-data` volume.

`SHARD_IMAGE` defaults to `ghcr.io/volturine/shard-notes:latest`. For predictable
production rollouts, set it to a release tag such as
`ghcr.io/volturine/shard-notes:1.2.3`.

To build from the local checkout instead, use the development template:

```sh
docker compose up -d --build
```

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
| `SHARD_IMAGE` | `ghcr.io/volturine/shard-notes:latest` | Image pulled by the production template |
| `SHARD_ORIGIN` | `http://localhost:3000` | Exact public origin used by SvelteKit |
| `SHARD_BODY_SIZE_LIMIT` | `110M` | Node adapter request limit; must exceed the 101 MB sync cap |
| `SHARD_SYNC_MAX_ACCOUNT_BYTES` | `1000000000` | Encrypted bytes retained per account |
| `SHARD_SYNC_MAX_ACCOUNT_ENVELOPES` | `50000` | Encrypted records retained per account |

`HOST`, `PORT`, and `SHARD_SYNC_DATA_DIR` are fixed inside the Compose service
to `0.0.0.0`, `3000`, and `/data`. Direct `docker run` deployments may override
them when needed.

## CI/CD

[`.github/workflows/ci-cd.yaml`](.github/workflows/ci-cd.yaml) runs the complete
application validation and a multi-platform Docker build for every pull request.
After changes reach `main`, it publishes:

- `ghcr.io/volturine/shard-notes:latest`
- `ghcr.io/volturine/shard-notes:main`
- `ghcr.io/volturine/shard-notes:sha-<commit>`

Tags beginning with `v` additionally publish semantic-version tags. For example,
`v1.2.3` publishes `1.2.3` and `1.2`. Images include SBOM and provenance
attestations. The workflow uses the repository-scoped `GITHUB_TOKEN`; no registry
password or custom secret is required.

## Validate

```sh
npm run validate
```

This runs Svelte/TypeScript diagnostics, the Vitest suite, and a production build.
