# Production Readiness

Status: Not ready for broad public launch; ready for controlled production smoke after deploy.

Last updated: 2026-05-26

## Production Flow

1. Meta calls `GET /facebook/webhook` for webhook verification.
2. Meta sends Messenger `POST /facebook/webhook` events with `X-Hub-Signature-256`.
3. The plugin verifies signature, JSON content type, request size/body validity, and registered Page/account target.
4. Inbound events are acknowledged quickly with `200 {"status":"ok"}` and processed in the background.
5. `dmPolicy` gates senders through OpenClaw pairing/allowlist/open access before assistant dispatch.
6. Text-only fast-lane messages can reply directly for greeting/help/status/image intent.
7. Messenger image-generation intents are routed to the separate Leaderbot image-generation service.
8. Photo-only/image-analysis messages stay in the OpenClaw assistant path instead of auto-restyling.
9. Assistant replies are sent through Graph API `/{pageId}/messages` as `messaging_type: RESPONSE`.
10. Errors are logged with hashed Messenger identifiers; raw PSIDs, tokens, and message text should not be logged.

## Blocking Issues Fixed

- Fixed Fly gateway workspace persistence: OpenClaw now uses `/data/workspace` through `OPENCLAW_WORKSPACE_DIR`.
- Added startup migration for missing legacy markdown files from `/home/node/.openclaw/workspace` to `/data/workspace`.
- Kept existing persistent workspace files safe: migration only copies missing files.
- Repaired persisted config when it contains the known legacy default workspace path.
- Kept OpenClaw built-in `image_generate` denied on the public gateway; Messenger image generation stays routed through Leaderbot image-gen.

## Remaining Blockers

- Live Meta webhook and Graph API delivery still require manual smoke tests with the real Page.
- Live image generation requires the separate `leaderbot-fb-image-gen` service key and OpenAI billing/key state to be healthy.
- `npm audit --omit=dev --audit-level=high` could not complete from this Windows environment because the registry audit endpoint request failed with `EACCES`; rerun from CI or another network before broad launch.
- GDPR consent/delete-my-data behavior must be verified at product level before broad public launch; the current plugin preserves access gating but does not implement a full public billing/privacy product by itself.

## Required Fly Secrets / Env Vars

Gateway app: `leaderbot-openclaw-gateway`

- `FACEBOOK_APP_SECRET` or `MESSENGER_APP_SECRET`
- `MESSENGER_PAGE_ACCESS_TOKEN`
- `MESSENGER_PAGE_ID`
- `MESSENGER_VERIFY_TOKEN`
- `OPENAI_API_KEY`
- `GATEWAY_AUTH_TOKEN`
- `OPENCLAW_GATEWAY_TOKEN`
- `LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN`

Important env:

- `OPENCLAW_STATE_DIR=/data`
- `OPENCLAW_CONFIG_PATH=/data/openclaw.json`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `LEADERBOT_IMAGE_GEN_URL=https://leaderbot-fb-image-gen.fly.dev`

Image-gen app must have matching internal token:

- `INTERNAL_IMAGE_REQUEST_TOKEN` must match `LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN`.

## Deploy Command

```bash
fly deploy -a leaderbot-openclaw-gateway
```

## Smoke-Test Commands

Health:

```bash
curl -I https://leaderbot-openclaw-gateway.fly.dev/healthz
```

Check persistent workspace path after deploy:

```bash
fly ssh console -a leaderbot-openclaw-gateway
cd /data/workspace
ls -la
```

Check logs:

```bash
fly logs -a leaderbot-openclaw-gateway
```

Manual Messenger smoke:

- Send `ben je online`; expect a status reply.
- Send a normal text question; expect an assistant reply.
- Send a photo without restyle text; expect analysis/clarifying assistant behavior, not a generated replacement image.
- Send `maak een afbeelding van ...`; expect the image-gen service path.
- Send a source photo plus explicit `restyle ...`; expect source-image image-gen path.

## Rollback Notes

Use Fly deployment history to identify the previous stable deployment, then roll back:

```bash
fly releases -a leaderbot-openclaw-gateway
fly deploy -a leaderbot-openclaw-gateway --image <previous-image>
```

The workspace migration is non-destructive: it only copies missing files into `/data/workspace` and does not remove legacy files.

## Known Risks

- Public `dmPolicy: "open"` should not be enabled until paywall, consent, deletion, quota, and abuse controls are product-ready.
- Messenger `RESPONSE` messages are constrained by Meta's response window.
- Provider/API billing failures surface as assistant/image-generation failures; smoke tests must include the live keys.
- The current local validation does not replace Meta App Review, Page permission, and webhook subscription checks.
