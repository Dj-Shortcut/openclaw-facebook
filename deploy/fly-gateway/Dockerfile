# syntax=docker/dockerfile:1.7

ARG OPENCLAW_VERSION=2026.5.12

FROM node:22-bookworm-slim AS plugin-build

WORKDIR /plugin

COPY package.json package-lock.json tsconfig.json ./
COPY openclaw.plugin.json README.md LICENSE ./
COPY index.ts api.ts channel-plugin-api.ts configured-state.ts runtime-api.ts setup-entry.ts ./
COPY src ./src
COPY docs ./docs
COPY examples ./examples

RUN npm ci && npm run build && mkdir -p /tmp/openclaw-plugin && npm pack --ignore-scripts --pack-destination /tmp/openclaw-plugin

FROM node:22-bookworm-slim
ARG OPENCLAW_VERSION

ENV NODE_ENV=production
ENV OPENCLAW_STATE_DIR=/data
ENV OPENCLAW_CONFIG_PATH=/data/openclaw.json
ENV OPENCLAW_FACEBOOK_PLUGIN_PATH=/app/node_modules/@dj-shortcut/facebook
ENV OPENCLAW_CODEX_PLUGIN_PATH=/app/node_modules/@openclaw/codex

WORKDIR /app

RUN --mount=type=cache,id=leaderbot-openclaw-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=leaderbot-openclaw-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git openssl tini && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=plugin-build /tmp/openclaw-plugin/*.tgz /tmp/openclaw-facebook.tgz

RUN npm init -y && \
    npm install --omit=dev "openclaw@${OPENCLAW_VERSION}" "@openclaw/codex@${OPENCLAW_VERSION}" /tmp/openclaw-facebook.tgz && \
    npm cache clean --force && \
    rm -f /tmp/openclaw-facebook.tgz

COPY deploy/fly-gateway/bin ./deploy/fly-gateway/bin

RUN install -d -m 0700 -o node -g node /data && \
    chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "deploy/fly-gateway/bin/start-gateway.mjs", "--allow-unconfigured", "--port", "3000", "--bind", "lan"]
