# Leaderbot OpenClaw Fly Gateway

This plugin repo now owns the Fly deployment source for the public Messenger gateway.
OpenClaw and the official Codex harness plugin are installed as pinned package dependencies during the Docker build; the Facebook plugin is built from this repository in the same image.

## Update OpenClaw

Use the single supported workflow in
[`../../docs/openclaw-update.md`](../../docs/openclaw-update.md). Do not edit
`OPENCLAW_VERSION` by hand except through `npm run openclaw:update -- <version>`.
That script keeps package metadata, tests, and the Fly gateway build arg aligned.

The OpenClaw dashboard update action is not the update path for this Fly/Docker
gateway. This image installs OpenClaw during Docker build, so a dashboard
`not-git-install` or package-root update skip means the runtime cannot safely
mutate `/app/node_modules/openclaw` in place. Treat the running Fly machine as
read-only: update the pinned package version in this repository, merge the PR,
then redeploy the image.

Future managed dashboard updates for Fly/Docker should hand off to an explicit
redeploy workflow with operator approval, scoped credentials, audit logging, and
rollback guidance. They should not edit runtime files inside the running
container.

See [`managed-redeploy-handoff.md`](managed-redeploy-handoff.md) for future
dashboard handoff design. The current authoritative operator workflow is
[`../../docs/openclaw-update.md`](../../docs/openclaw-update.md).

## Deploy

Run from the `openclaw-facebook` repository root:

```bash
pnpm run deploy:gateway
```

## Safety Defaults

The container preserves `/data/openclaw.json` and only seeds non-secret defaults when missing:

- `OPENCLAW_WORKSPACE_DIR` defaults to `/data/workspace`, keeping `AGENTS.md`, `USER.md`, `MEMORY.md`, and daily memory on the mounted Fly volume.
- On startup, missing workspace bootstrap files are copied once from the legacy `/home/node/.openclaw/workspace` fallback into `/data/workspace`.
- `plugins.load.paths` includes `/app/node_modules/@dj-shortcut/facebook`.
- `plugins.load.paths` includes `/app/node_modules/@openclaw/codex`.
- `plugins.entries.facebook.enabled` defaults to `true`.
- `channels.facebook.dmPolicy` defaults to `pairing`.
- `channels.facebook.unknownSenderMode` is seeded from `OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE` when missing. The public Leaderbot gateway sets this to `leaderbot_free_tier` so new Page senders enter the free-tier image flow while private installs can keep or set `pairing`.
- `channels.facebook.leaderbotBridgeEnabled` is seeded from `OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED` when missing. Keep it unset/false for ClawHub and private installs; set it only for the intentional public Leaderbot gateway where Messenger content and identifiers are disclosed as being processed by the separate image-generation service.
- `agents.defaults.model.primary` defaults to `OPENCLAW_AGENT_MODEL` when set.
- `agents.defaults.thinkingDefault` defaults to `OPENCLAW_AGENT_THINKING_DEFAULT` when set.
- `tools.deny` includes `image_generate` so this public Messenger gateway cannot invoke OpenClaw's built-in image-generation tool; Messenger image generation is routed through the separate Leaderbot image-gen service.
- `OPENCLAW_PUBLIC_GATEWAY_GUARD=1` puts OpenClaw behind a small public route guard. Fly exposes `/facebook/webhook`, `/messenger/webhook`, and `/healthz` publicly, and can proxy customer portal/legal routes to `LEADERBOT_PORTAL_ORIGIN`. Dashboard/UI/API access requires `OPENCLAW_ADMIN_TOKEN` and a request host listed in `OPENCLAW_ADMIN_HOSTS`; after that, OpenClaw's own device pairing/auth still applies.

The container changes `channels.facebook.dmPolicy: "open"` back to `"pairing"` unless `OPENCLAW_FACEBOOK_ALLOW_OPEN=1` is intentionally set.
Secrets must remain in Fly secrets or the mounted state, never in this repo.
