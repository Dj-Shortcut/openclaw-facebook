ARG OPENCLAW_VERSION=2026.7.2-beta.7
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

FROM ${NODE_BASE_IMAGE} AS plugin-build

WORKDIR /plugin

COPY package.json package-lock.json tsconfig.json ./
COPY openclaw.plugin.json README.md LICENSE ./
COPY index.ts api.ts channel-plugin-api.ts configured-state.ts runtime-api.ts setup-entry.ts ./
COPY src ./src
COPY docs ./docs
COPY examples ./examples

RUN npm ci --ignore-scripts && npm run build && mkdir -p /tmp/openclaw-plugin && npm pack --ignore-scripts --pack-destination /tmp/openclaw-plugin

FROM ${NODE_BASE_IMAGE}
ARG OPENCLAW_VERSION
ARG NODE_BASE_IMAGE
ARG SOURCE_REVISION=unreviewed-local-build

LABEL org.opencontainers.image.source="https://github.com/Dj-Shortcut/openclaw-facebook" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.leaderbot.artifact.kind="gateway-runtime" \
      io.leaderbot.base.node="${NODE_BASE_IMAGE}" \
      io.leaderbot.gateway.state-rehearsal="real-openclaw-v1"

ENV NODE_ENV=production
ENV OPENCLAW_STATE_DIR=/data
ENV OPENCLAW_CONFIG_PATH=/data/openclaw.json
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace
ENV OPENCLAW_FACEBOOK_PLUGIN_PATH=/app/node_modules/@dj-shortcut/facebook
ENV OPENCLAW_CODEX_PLUGIN_PATH=/app/node_modules/@openclaw/codex
ENV OPENCLAW_SKIP_STARTUP_MODEL_PREWARM=1

WORKDIR /app

RUN --mount=type=cache,id=leaderbot-openclaw-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=leaderbot-openclaw-apt-lists,target=/var/lib/apt,sharing=locked \
    sed -i \
      -e 's|URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/20260824T000000Z|' \
      -e 's|URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/20260824T000000Z|' \
      /etc/apt/sources.list.d/debian.sources && \
    printf '%s\n' 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99leaderbot-snapshot && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git openssl tini && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=plugin-build /tmp/openclaw-plugin/*.tgz /tmp/openclaw-facebook.tgz
COPY deploy/fly-gateway/runtime/package.json ./package.json
COPY deploy/fly-gateway/runtime/package-lock.json ./package-lock.json
COPY scripts/validate-openclaw-runtime.mjs ./scripts/validate-openclaw-runtime.mjs
COPY deploy/fly-gateway/bin/codex-targets.cjs ./deploy/fly-gateway/bin/codex-targets.cjs
COPY deploy/fly-gateway/bin/prune-image-deps-core.mjs ./deploy/fly-gateway/bin/prune-image-deps-core.mjs
COPY deploy/fly-gateway/bin/prune-image-deps.mjs ./deploy/fly-gateway/bin/prune-image-deps.mjs
COPY deploy/fly-gateway/bin/verify-codex-native-deps.cjs ./deploy/fly-gateway/bin/verify-codex-native-deps.cjs

RUN test "$(node -p 'require("./package.json").dependencies.openclaw')" = "${OPENCLAW_VERSION}" && \
    test "$(node -p 'require("./package.json").dependencies["@openclaw/codex"]')" = "${OPENCLAW_VERSION}" && \
    npm ci --omit=dev --include=optional --no-audit --no-fund && \
    mkdir -p /app/node_modules/@dj-shortcut/facebook && \
    tar -xzf /tmp/openclaw-facebook.tgz --strip-components=1 -C /app/node_modules/@dj-shortcut/facebook && \
    EXPECTED_OPENCLAW_VERSION="${OPENCLAW_VERSION}" node ./scripts/validate-openclaw-runtime.mjs /app --gateway && \
    node ./deploy/fly-gateway/bin/prune-image-deps.mjs /app && \
    EXPECTED_OPENCLAW_VERSION="${OPENCLAW_VERSION}" node ./scripts/validate-openclaw-runtime.mjs /app --gateway && \
    node ./deploy/fly-gateway/bin/verify-codex-native-deps.cjs && \
    npm cache clean --force && \
    rm -f /tmp/openclaw-facebook.tgz

COPY deploy/fly-gateway/bin ./deploy/fly-gateway/bin

RUN printf '%s\n' 'gateway-runtime' > /app/.leaderbot-artifact-kind

RUN install -d -m 0700 -o node -g node /data /data/workspace && \
    chown -R node:node /app && \
    chown -R root:root /app/node_modules/@dj-shortcut /app/node_modules/@openclaw

USER node

EXPOSE 3000

HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "deploy/fly-gateway/bin/start-gateway.mjs", "--allow-unconfigured", "--port", "3000", "--bind", "lan"]
