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

Use the manually dispatched `Deploy production` GitHub Actions workflow from a
reviewed `main` commit. The protected `production` environment supplies approval
and app-scoped credentials. The workflow invokes exactly one of:

```bash
npm run deploy:image-gen
npm run deploy:gateway
```

These are CI implementation details and emergency operator entry points, not a
reason to bypass production approval. Never use `fly machine run` for either
production app. The full contract is in
[`operations/production-deployments.md`](operations/production-deployments.md).

## Package managers

- Use npm `>=11.12.1` for the root plugin, root scripts, installs, releases, and
  deploy orchestration. `package-lock.json` is authoritative there.
- Use pnpm `10.28.1` only within `apps/image-gen`, `apps/customer-app`, and
  `apps/image-gen/storage-proxy`. Each app owns its `packageManager` pin and
  `pnpm-lock.yaml`.
- The root `pnpm-lock.yaml` is retained only as an OpenClaw compatibility mirror;
  it does not turn the repository into a pnpm workspace.
- Run `npm run check:package-managers` after changing package metadata,
  lockfiles, or package-manager CI setup.

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
