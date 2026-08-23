ARG NODE_BASE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_BASE_IMAGE} AS build

ARG SOURCE_REVISION=unreviewed-local-build

LABEL org.opencontainers.image.source="https://github.com/Dj-Shortcut/openclaw-facebook" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

WORKDIR /app

RUN corepack enable

COPY package.json ./
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY index.ts ./

RUN pnpm run build:proxy

FROM ${NODE_BASE_IMAGE} AS runtime

ARG SOURCE_REVISION=unreviewed-local-build
ARG NODE_BASE_IMAGE

LABEL org.opencontainers.image.source="https://github.com/Dj-Shortcut/openclaw-facebook" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.leaderbot.artifact.kind="runtime" \
      io.leaderbot.base.node="${NODE_BASE_IMAGE}"

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/dist ./dist

RUN addgroup -S storageproxy && adduser -S storageproxy -G storageproxy

USER storageproxy

EXPOSE 8787

CMD ["node", "dist/index.cjs"]
