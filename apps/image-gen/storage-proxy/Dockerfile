FROM node:20-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json ./
COPY pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY index.ts ./

RUN pnpm run build:proxy

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/dist ./dist

RUN addgroup -S storageproxy && adduser -S storageproxy -G storageproxy

USER storageproxy

EXPOSE 8787

CMD ["node", "dist/index.cjs"]
