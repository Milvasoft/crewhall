# Backend image (api, and the worker with another command). Build from the repo root:
#   docker build -f apps/backend/Dockerfile -t crewhall/backend .
# Dockerfile.dockerignore next to this file keeps node_modules and dist out of the context.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
# tools/* are workspace packages too (apps/web depends on @crewhall/sounds); pnpm deploy needs them.
COPY tools ./tools
COPY apps ./apps
RUN pnpm install --frozen-lockfile --filter "@crewhall/backend..."
RUN pnpm --filter @crewhall/backend build
# Production node_modules only; workspace packages are already bundled into dist.
RUN pnpm --filter @crewhall/backend deploy --prod --legacy /out
# Desktop releases (apps/desktop `pnpm publish:updates` → apps/desktop/updates) go into the image
# when present; otherwise the folder stays empty and a volume can be mounted there (docker/README.md).
RUN mkdir -p /out/desktop-updates \
 && if [ -d apps/desktop/updates ]; then cp -r apps/desktop/updates/. /out/desktop-updates/; fi

FROM node:22-alpine AS runtime
# pg_dump / pg_restore and tar for backups (dist/crewhall.js, tools/crewhall/crewhall).
RUN apk add --no-cache postgresql18-client tar \
 && mkdir -p /backups && chown node:node /backups
ENV NODE_ENV=production \
    PORT=3000 \
    MIGRATIONS_DIR=/app/migrations \
    CREWHALL_BACKUP_DIR=/backups \
    DESKTOP_UPDATES_DIR=/app/desktop-updates
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
COPY --from=build /out/desktop-updates ./desktop-updates
# Set by CI; getCompat reports them. After the copies so a new build number rebuilds no layer above.
ARG BUILD_ID=
ARG BUILD_COMMIT=
ENV BUILD_ID=$BUILD_ID \
    BUILD_COMMIT=$BUILD_COMMIT
USER node
EXPOSE 3000
CMD ["node", "--import", "./dist/otel.js", "dist/index.js"]
