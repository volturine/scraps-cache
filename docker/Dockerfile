# syntax=docker/dockerfile:1

FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json svelte.config.js tsconfig.json vite.config.ts ./
RUN npm ci --ignore-scripts

COPY . .
ARG TARGETARCH
RUN npm run build \
	&& npm prune --omit=dev \
	&& cd node_modules/better-sqlite3 \
	&& rm -rf deps src binding.gyp \
	&& case "$TARGETARCH" in \
		amd64) sqlite_arch=x64 ;; \
		*) sqlite_arch="$TARGETARCH" ;; \
	esac \
	&& find prebuilds -maxdepth 1 -mindepth 1 ! -name "linuxmusl-${sqlite_arch}.node" -exec rm -rf {} +

FROM alpine:3.24 AS runtime

COPY --from=node:24-alpine /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	BODY_SIZE_LIMIT=110M \
	SCRAPS_CACHE_SYNC_DATA_DIR=/data

WORKDIR /app

COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chmod=755 docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint

RUN apk add --no-cache libstdc++ libgcc setpriv \
	&& addgroup -g 1000 -S node \
	&& adduser -S -D -H -u 1000 -G node node \
	&& mkdir -p /data \
	&& chown node:node /data

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health/ready`).then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

ENTRYPOINT ["docker-entrypoint"]
