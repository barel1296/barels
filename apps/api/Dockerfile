# GROS API — multi-stage production image.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @gros/shared --filter @gros/api
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @gros/shared build && pnpm --filter @gros/api build
# Prune to production deps for the api package only.
RUN pnpm deploy --filter @gros/api --prod /out && \
    cp -r apps/api/dist /out/dist && \
    cp -r apps/api/migrations /out/migrations

FROM node:22-alpine
RUN addgroup -S gros && adduser -S gros -G gros
WORKDIR /app
COPY --from=build --chown=gros:gros /out /app
USER gros
ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD wget -qO- http://localhost:3001/healthz || exit 1
CMD ["node", "dist/main.js"]
