# Azure DevOps and Jira plugins, one image; PLUGIN_PRODUCT picks which one runs. Build from the repo root:
#   docker build -f apps/plugin-workitems/Dockerfile -t crewhall/plugin-workitems .

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY tools ./tools
COPY apps ./apps
RUN pnpm install --frozen-lockfile --filter "@crewhall/plugin-workitems..."
# Production node_modules; the TypeScript sources run with tsx (a production dependency).
RUN pnpm --filter @crewhall/plugin-workitems deploy --prod --legacy /out
# api-client publishes only dist/ ("files"), so deploy leaves out the sources tsx runs here.
RUN cp -r packages/api-client/src "$(realpath /out/node_modules/@crewhall/api-client)/src"

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=4341
WORKDIR /app
COPY --from=build /out ./
# Every import and both manifests must resolve from exactly these files: a broken image fails here,
# not on the server.
RUN node --import tsx --input-type=module -e "const s = await import('/app/src/server.ts'); await s.loadManifest(undefined, 'azure'); await s.loadManifest(undefined, 'jira')"
USER node
EXPOSE 4341
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4341/healthz || exit 1
CMD ["node", "--import", "tsx", "src/index.ts"]
