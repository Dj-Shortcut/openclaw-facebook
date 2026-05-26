# Leaderbot Monorepo

This repo is the operational home for the Messenger/OpenClaw gateway and the
Leaderbot image-generation service.

## Apps

- Root package: `@dj-shortcut/facebook`, the OpenClaw Facebook channel plugin
  and Fly gateway deployment source.
- `apps/image-gen`: the Leaderbot image-generation app.

## Deploy

Gateway:

```bash
npm run gateway:deploy
```

Image generation:

```bash
npm run image-gen:install
npm run image-gen:deploy
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
- Shared product docs live under root `docs/`.
- App-specific docs can stay under `apps/image-gen/docs/` until they are
  intentionally consolidated.
