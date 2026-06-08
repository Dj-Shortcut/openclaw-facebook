# Leaderbot OpenClaw Fly Gateway

This plugin repo now owns the Fly deployment source for the public Messenger gateway.
OpenClaw and the official Codex harness plugin are installed as pinned package dependencies during the Docker build; the Facebook plugin is built from this repository in the same image.

## Update OpenClaw

Edit `OPENCLAW_VERSION` in `deploy/fly-gateway/Dockerfile`, then build/deploy.
Keep the Facebook plugin package peer range compatible with that OpenClaw release.

## Deploy

Run from the `openclaw-facebook` repository root:

```bash
fly deploy -a leaderbot-openclaw-gateway
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
- `agents.defaults.model.primary` defaults to `OPENCLAW_AGENT_MODEL` when set.
- `agents.defaults.thinkingDefault` defaults to `OPENCLAW_AGENT_THINKING_DEFAULT` when set.
- `tools.deny` includes `image_generate` so this public Messenger gateway cannot invoke OpenClaw's built-in image-generation tool; Messenger image generation is routed through the separate Leaderbot image-gen service.
- `OPENCLAW_PUBLIC_GATEWAY_GUARD=1` puts OpenClaw behind a small public route guard. Fly exposes `/facebook/webhook`, `/messenger/webhook`, and `/healthz` publicly. Dashboard/UI/API access requires `OPENCLAW_ADMIN_TOKEN` and a request host listed in `OPENCLAW_ADMIN_HOSTS`; after that, OpenClaw's own device pairing/auth still applies.

The container changes `channels.facebook.dmPolicy: "open"` back to `"pairing"` unless `OPENCLAW_FACEBOOK_ALLOW_OPEN=1` is intentionally set.
Secrets must remain in Fly secrets or the mounted state, never in this repo.
