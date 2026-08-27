# Leaderbot Monorepo

This repo is the operational home for two separate runtimes: the tenant-owned
Leaderbot customer platform and the repository owner's personal
Messenger/OpenClaw gateway. The personal gateway is not customer infrastructure.

## Apps

- Root package: `@dj-shortcut/facebook`, the reusable OpenClaw Facebook channel
  plugin and the owner's private Fly gateway source.
- `apps/image-gen`: the complete Leaderbot customer runtime: direct Meta
  webhook ingress, conversation behavior, images, storage, quota, billing,
  deletion, legal pages and the `leaderbot.live` portal.

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
- Point customer Meta webhooks and all customer-facing work directly at
  `apps/image-gen`. Never proxy them through the OpenClaw gateway.
- Keep the personal OpenClaw gateway shielded, pairing-only by default and
  independent of customer quota, billing, portal and launch readiness.
- Use separate Meta apps, Pages and credentials for Leaderbot customers and the
  personal gateway; never point one app-level callback at both runtimes.
- Shared product docs live under root `docs/`.
- App-specific docs live under the root `docs/` directory and can stay there until they are
  intentionally consolidated.
