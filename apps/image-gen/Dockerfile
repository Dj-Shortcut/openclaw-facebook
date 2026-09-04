ARG NODE_BASE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
ARG MIGRATION_BRIDGE_BASE_IMAGE=registry.fly.io/leaderbot-fb-image-gen@sha256:28d862568aa3cb049ac4aba164bb1e01792691feec646ff87c657f72bd306804

FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build:docker

# This bridge keeps the exact currently proven application runtime and adds
# only the reviewed migrator material plus the reversible billing-trigger
# preflight consumed by the protected deploy workflow. Its minimum phase is
# supplied by the protected artifact workflow from the frozen transition
# manifest.
FROM ${MIGRATION_BRIDGE_BASE_IMAGE} AS migration_bridge
WORKDIR /app
ARG SOURCE_REVISION=unreviewed-local-build
ARG MIGRATION_BRIDGE_BASE_IMAGE
ARG MIGRATION_BRIDGE_SCHEMA_MINIMUM=0016_expand
LABEL org.opencontainers.image.source="https://github.com/Dj-Shortcut/openclaw-facebook" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.leaderbot.artifact.kind="migration-bridge" \
      io.leaderbot.bridge.base-image="${MIGRATION_BRIDGE_BASE_IMAGE}" \
      io.leaderbot.schema.minimum="${MIGRATION_BRIDGE_SCHEMA_MINIMUM}" \
      io.leaderbot.schema.maximum="0018_credit_checkout_reservation"
COPY --from=build /app/dist/migrate-production.cjs ./dist/migrate-production.cjs
COPY --from=build /app/dist/credit-migration-definer-grants.cjs ./dist/credit-migration-definer-grants.cjs
COPY --from=build /app/dist/billing-trigger-runtime-preflight.cjs ./dist/billing-trigger-runtime-preflight.cjs
COPY --from=build /app/drizzle ./drizzle
RUN test -s /app/dist/billing-trigger-runtime-preflight.cjs && \
    test -s /app/dist/credit-migration-definer-grants.cjs && \
    node --check /app/dist/billing-trigger-runtime-preflight.cjs && \
    node --check /app/dist/credit-migration-definer-grants.cjs
RUN printf '%s\n' 'migration-bridge' > /app/.leaderbot-artifact-kind

FROM ${NODE_BASE_IMAGE} AS runtime
WORKDIR /app
ARG SOURCE_REVISION=unreviewed-local-build
ARG NODE_BASE_IMAGE
ARG FFMPEG_VERSION=8.1.2-r0
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/Dj-Shortcut/openclaw-facebook" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.leaderbot.artifact.kind="runtime" \
      io.leaderbot.base.node="${NODE_BASE_IMAGE}" \
      io.leaderbot.runtime.ffmpeg="${FFMPEG_VERSION}" \
      io.leaderbot.schema.minimum="0019_credit_offer_v2" \
      io.leaderbot.schema.maximum="0019_credit_offer_v2"
RUN apk add --no-cache "ffmpeg=${FFMPEG_VERSION}"
RUN printf '%s\n' 'runtime' > /app/.leaderbot-artifact-kind
# Keep the runtime stage slim: copy only the bundled server entrypoint and the
# static assets the production server actually serves from /app/public.
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/public ./public
RUN test -s /app/dist/provision-whatsapp-binding.cjs
RUN test -s /app/dist/billing-trigger-runtime-preflight.cjs

EXPOSE 8080
CMD ["node", "dist/index.cjs"]
