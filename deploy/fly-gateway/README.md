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

- `plugins.load.paths` includes `/app/node_modules/@dj-shortcut/facebook`.
- `plugins.load.paths` includes `/app/node_modules/@openclaw/codex`.
- `plugins.entries.facebook.enabled` defaults to `true`.
- `channels.facebook.dmPolicy` defaults to `pairing`.
- `agents.defaults.model.primary` defaults to `OPENCLAW_AGENT_MODEL` when set.
- `agents.defaults.thinkingDefault` defaults to `OPENCLAW_AGENT_THINKING_DEFAULT` when set.
- `tools.deny` includes `image_generate` so this public Messenger gateway cannot invoke OpenClaw's built-in image-generation tool; Messenger image generation is routed through the separate Leaderbot image-gen service.

The container changes `channels.facebook.dmPolicy: "open"` back to `"pairing"` unless `OPENCLAW_FACEBOOK_ALLOW_OPEN=1` is intentionally set.
Secrets must remain in Fly secrets or the mounted state, never in this repo.
