# Portal site (Next.js, standalone output). Build from the repo root:
#   docker build -f apps/portal/Dockerfile -t crewhall/portal .
# Runtime env: HUB_API_URL, PORTAL_CONTENT_TOKEN, PORTAL_REVALIDATE_SECRET, PORTAL_DEFAULT_LOCALE,
# PORTAL_PUBLIC_URL (see apps/portal/.env.example). No Hub access is needed at build time.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/portal ./apps/portal
RUN pnpm install --frozen-lockfile --filter "@crewhall/portal..."
RUN pnpm --filter @crewhall/portal build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3002 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# standalone output keeps the monorepo layout below outputFileTracingRoot (the repo root)
COPY --from=build --chown=node:node /repo/apps/portal/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/portal/.next/static ./apps/portal/.next/static
# The cache is a volume in compose; a new volume takes this directory's owner, so `node` can
# write ISR pages (otherwise it is root's and every revalidation fails with EACCES).
RUN mkdir -p apps/portal/.next/cache && chown node:node apps/portal/.next/cache
USER node
EXPOSE 3002
# ISR pages and the fetch cache live in apps/portal/.next/cache (one replica; see README)
CMD ["node", "apps/portal/server.js"]
