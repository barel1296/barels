# GROS Web — Next.js standalone production image.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @gros/shared --filter @gros/web
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @gros/shared build && pnpm --filter @gros/web build

FROM node:22-alpine
RUN addgroup -S gros && adduser -S gros -G gros
WORKDIR /app
COPY --from=build --chown=gros:gros /repo/apps/web/.next/standalone ./
COPY --from=build --chown=gros:gros /repo/apps/web/.next/static ./apps/web/.next/static
USER gros
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
