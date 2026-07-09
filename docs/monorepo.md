# Leaderbot Monorepo

This repo is the operational home for the Messenger/OpenClaw gateway and the
Leaderbot image-generation service.

## Apps

- Root package: `@dj-shortcut/facebook`, the OpenClaw Facebook channel plugin
  and Fly gateway deployment source.
- `apps/image-gen`: the Leaderbot image-generation app.
- Planned `leaderbot.live` portal: a tenant/customer app for managing each
  customer's own AI. This must stay separate from the private OpenClaw gateway
  UI/API.

## Deploy

```bash
pnpm run deploy
pnpm run deploy:image-gen
pnpm run deploy:gateway
```

Legacy aliases (still available):

```bash
pnpm run gateway:deploy
pnpm run image-gen:deploy
```

## Validate

Gateway/plugin:

```bash
npm run check
```

Image generation:

```bash
npm run image-gen:install
npm run image-gen:check
npm run image-gen:test
npm run image-gen:build
```

## Boundaries

- Do not commit `.env`, Fly secrets, generated images, logs, `node_modules`, or
  build output.
- Keep both Fly apps separate: `leaderbot-openclaw-gateway` and
  `leaderbot-fb-image-gen`.
- Keep the OpenClaw gateway shielded. Customer-facing work belongs in the
  portal app/API, not by exposing the gateway UI publicly.
- Shared product docs live under root `docs/`.
- App-specific docs live under the root `docs/` directory and can stay there until they are
  intentionally consolidated.
