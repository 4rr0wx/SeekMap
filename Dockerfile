# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js vitest.config.ts .prettierrc.json .prettierignore ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm typecheck && pnpm test && pnpm build
RUN pnpm --filter @hideseek/server deploy --prod --legacy /production/server

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_ROOT=/app/public
WORKDIR /app
RUN groupadd --system --gid 10001 hideseek \
    && useradd --system --uid 10001 --gid hideseek --home-dir /app hideseek \
    && mkdir -p /data /app/public \
    && chown -R hideseek:hideseek /data /app

COPY --from=build --chown=hideseek:hideseek /production/server/ ./
COPY --from=build --chown=hideseek:hideseek /workspace/apps/server/dist ./dist
COPY --from=build --chown=hideseek:hideseek /workspace/apps/web/dist ./public
RUN rm -f ./node_modules/@hideseek/shared && mkdir -p ./node_modules/@hideseek/shared
COPY --from=build --chown=hideseek:hideseek /workspace/packages/shared/package.json ./node_modules/@hideseek/shared/package.json
COPY --from=build --chown=hideseek:hideseek /workspace/packages/shared/dist ./node_modules/@hideseek/shared/dist

USER hideseek
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
