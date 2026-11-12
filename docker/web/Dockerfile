# Web image: the static SPA from apps/web, served by Caddy on :8080 (the edge Caddy in
# docker/compose.yml proxies to it). Build from the repo root:
#   docker build -f docker/web/Dockerfile -t crewhall/web .
# Branding, theme and texts come at runtime from the api; the image is the same for every org.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
# The call ring and ringback live in tools/sounds (generated WAVs + the WebAudio fallback).
COPY tools/sounds ./tools/sounds
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter "@crewhall/web..."
# Same origin as the api behind the edge proxy: no API URL is baked in.
ENV VITE_API_URL= VITE_API_MOCK=0
# Set by CI; buildInfoPlugin.ts writes them into index.html (.git is not in this image).
ARG BUILD_ID=
ARG BUILD_COMMIT=
ENV BUILD_ID=$BUILD_ID BUILD_COMMIT=$BUILD_COMMIT
RUN pnpm --filter @crewhall/web build

FROM caddy:2-alpine AS runtime
COPY docker/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
EXPOSE 8080
