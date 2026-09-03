# syntax=docker/dockerfile:1

# Compile JS on the native builder. Vite/Rolldown SIGILL under QEMU arm64 (CI exit 132).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json svelte.config.js tsconfig.json vite.config.ts ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

FROM node:24-alpine AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM alpine:3.24 AS runtime

COPY --from=node:24-alpine /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	BODY_SIZE_LIMIT=110M

WORKDIR /app

COPY --from=build --chown=node:node /app/build ./build
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
RUN apk add --no-cache libstdc++ libgcc \
	&& addgroup -g 1000 -S node \
	&& adduser -S -D -H -u 1000 -G node node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health/ready`).then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"]

USER node
CMD ["node", "build"]
