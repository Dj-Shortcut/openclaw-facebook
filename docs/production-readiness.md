# Production Readiness

Status: Not ready for broad public launch; ready for controlled production smoke after deploy.

Last updated: 2026-06-21

Canonical release strategy and open work are tracked in
[`apps/image-gen/docs/operations/todo.md`](../apps/image-gen/docs/operations/todo.md).
This document is the deploy/smoke checklist for the current gateway surface.

## Production Flow

1. Meta calls `GET /facebook/webhook` for webhook verification.
2. Meta sends Messenger `POST /facebook/webhook` events with `X-Hub-Signature-256`.
3. The plugin verifies signature, JSON content type, request size/body validity, and registered Page/account target.
4. Inbound events are acknowledged quickly with `200 {"status":"ok"}` and processed in the background.
5. `dmPolicy` gates senders through OpenClaw pairing/allowlist/open access before assistant dispatch.
6. Text-only fast-lane messages can reply directly for greeting/help/status/image intent.
7. Messenger image-generation intents are routed to the separate Leaderbot image-generation service only when `leaderbotBridgeEnabled: true` and a valid internal bridge token are configured.
8. Source-photo generation only uses an uploaded/stored photo when the prompt explicitly asks to edit/restyle that photo.
9. Photo-only/image-analysis messages stay in the OpenClaw assistant path instead of auto-restyling.
10. Assistant replies are sent through Graph API `/{pageId}/messages` as `messaging_type: RESPONSE`.
11. Errors are logged with hashed Messenger identifiers; raw PSIDs, tokens, and message text should not be logged.

## Blocking Issues Fixed

- Fixed Fly gateway workspace persistence: OpenClaw now uses `/data/workspace` through `OPENCLAW_WORKSPACE_DIR`.
- Added startup migration for missing legacy markdown files from `/home/node/.openclaw/workspace` to `/data/workspace`.
- Kept existing persistent workspace files safe: migration only copies missing files.
- Repaired persisted config when it contains the known legacy default workspace path.
- Kept OpenClaw built-in `image_generate` denied on the public gateway; Messenger image generation stays routed through Leaderbot image-gen.
- Added a public-open Facebook DM tool denylist for high-cost/risky OpenClaw tools (`image_generate`, browser/canvas/web fetch/firecrawl, exec, and filesystem mutation tools).
- Added the Fly public route guard: webhook and health routes stay public, customer portal/legal routes can be proxied to Leaderbot, and the broader OpenClaw gateway UI/API is not reachable from the internet.

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
- `OPENCLAW_PUBLIC_GATEWAY_GUARD=1`
- `OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED=1` only for the intentional public Leaderbot gateway
- `LEADERBOT_IMAGE_GEN_URL=https://leaderbot-fb-image-gen.fly.dev`

Image-gen app must have matching internal token:

- `INTERNAL_IMAGE_REQUEST_TOKEN` must match `LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN`.

The token alone must not enable forwarding. The Facebook channel config also
needs `leaderbotBridgeEnabled: true` for any Messenger event, Page-scoped sender
ID, prompt, or media URL to be sent to the separate Leaderbot image-generation
service.

## Deploy Command

```bash
fly deploy -a leaderbot-openclaw-gateway
```

## Smoke-Test Commands

Health:

```bash
curl -I https://leaderbot-openclaw-gateway.fly.dev/healthz
curl -I https://leaderbot-fb-image-gen.fly.dev/healthz
```

Image-gen readiness and metrics:

```bash
curl -fsS https://leaderbot-fb-image-gen.fly.dev/readyz
curl -fsS https://leaderbot-fb-image-gen.fly.dev/metrics
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

## Release Gate Checklist

Before deploy:

- Confirm rollback target with `fly releases -a leaderbot-openclaw-gateway`.
- Confirm the gateway `/healthz` route is reachable and no additional gateway UI/API routes are publicly exposed.
- Confirm image-gen `/healthz`, `/readyz`, and `/metrics` are reachable.
- Confirm image-gen queue metrics show bounded `messenger_generation_queue_jobs{state="queued"}`, `messenger_generation_queue_jobs{state="processing"}`, and `messenger_generation_global_slots{state="active"}`.
- Confirm failed/dead-lettered generation jobs are zero or have an owner-reviewed incident note.
- Confirm recent logs contain no raw PSIDs, access tokens, customer messages, uploaded knowledge, generated prompts, or generated outputs.
- Confirm no public route exposure drift from the intended webhook/health/legal/customer-app surfaces.
- Confirm Messenger prompt routing follows the operator-facing routing guide:
  ordinary conversation stays on OpenClaw, prompt-first image generation and
  source-photo edits are forwarded only through the explicit Leaderbot bridge,
  and cap/failure fallbacks are visible through metadata-only trace stages. See
  [`operator-prompt-routing.md`](operator-prompt-routing.md).
- Create a metadata-only smoke evidence file with `npm run messenger:smoke-template > smoke-evidence.json`.

After deploy:

- Re-run gateway `/healthz` and image-gen `/healthz`, `/readyz`, and `/metrics`.
- Confirm `webhook_ack_sent` latency stays within the current production target and event-loop p95/p99 remains below the documented rollout threshold.
- Confirm queue depth drains normally, failed/dead-lettered job counts do not increase, and worker lease/reclaim logs are healthy after a worker restart or deploy event.
- Run the manual Messenger smoke below with the real Page.
- Record metadata-only release notes: commit, image/release id, smoke result, rollback target, and any cost/quota anomalies.
- Validate the smoke evidence before sharing or archiving it with `npm run messenger:smoke-validate -- smoke-evidence.json`.

Manual Messenger smoke:

- Send `ben je online`; expect a status reply.
- Send a normal text question; expect an assistant reply.
- Send a photo without edit text; expect the photo-received prompt asking what to change, not an automatic generated replacement image.
- Send `maak een afbeelding van ...`; expect the image-gen service path.
- Send `maak een futuristische stad bij zonsondergang`; expect text-to-image, not a style-picker default.
- Send `maak een prompt voor een afbeelding`; expect the normal assistant path, not image generation.
- Send a source photo plus explicit edit text such as `maak me cyberpunk`; expect the source-image edit path.

## Rollback Notes

Use Fly deployment history to identify the previous stable deployment, then roll back:

```bash
fly releases -a leaderbot-openclaw-gateway
fly deploy -a leaderbot-openclaw-gateway --image <previous-image>
```

The workspace migration is non-destructive: it only copies missing files into `/data/workspace` and does not remove legacy files.

## Known Risks

- Public `dmPolicy: "open"` should not be enabled until paywall, consent, deletion, quota, and abuse controls are product-ready.
- Public Pages need clear privacy/data-retention terms before open mode or
  Leaderbot free-tier image generation is enabled.
- Keep `leaderbotBridgeEnabled` false unless external Leaderbot processing is
  intended and disclosed.
- Messenger `RESPONSE` messages are constrained by Meta's response window.
- Provider/API billing failures surface as assistant/image-generation failures; smoke tests must include the live keys.
- The current local validation does not replace Meta App Review, Page permission, and webhook subscription checks.
