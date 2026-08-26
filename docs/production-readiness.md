# Production Readiness

Status: The personal-only OpenClaw gateway is not ready for a transcript/customer
feature rollout. The direct multi-tenant image-gen route, WhatsApp and live
Mollie billing remain NO-GO until their separate gates pass.

Last updated: 2026-08-26

Canonical release strategy and open work are tracked in
[`docs/operations/todo.md`](operations/todo.md).
This document is the deploy/smoke checklist for the current gateway surface.

OpenClaw is personal-only. The multi-tenant customer image-generation path must
terminate directly in image-gen and must not create an OpenClaw host session.
The flow below describes the transitional gateway path, not the approved target
customer architecture. Exact non-archiving host transcript erasure blocks every
OpenClaw transcript/customer feature. It becomes non-blocking for image-gen only
after protected production evidence proves the direct callback/routing cutover;
until then it remains a conservative live blocker.

## Transitional Gateway Flow

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

- Fixed Fly gateway workspace persistence: OpenClaw now uses `/data/workspace` through `OPENCLAW_WORKSPACE_DIR` for static instruction files only.
- Added startup migration for missing static instruction files from `/home/node/.openclaw/workspace` to `/data/workspace`.
- Disabled shared public memory plugins, hooks, compaction flushes, search, and tools. Existing `USER.md`, `MEMORY.md`, and `memory/` content is moved to the recoverable `/data/private-memory-quarantine-v1` before startup; a collision fails closed.
- Forced public Messenger direct messages to `per-account-channel-peer`. Startup rejects explicit non-`main` Facebook `agentId` values; the runtime route check rejects an inherited secondary default agent before transcript dispatch when the binding omits `agentId`.
- Added immediate cleanup for downloaded Messenger media after successful and failed turns, with a maximum 24-hour persisted attachment TTL as crash recovery.
- Repaired persisted config when it contains the known legacy default workspace path.
- Kept OpenClaw built-in `image_generate` denied on the personal gateway; the multi-tenant Messenger image-generation path terminates directly in image-gen.
- Replaced the public-open Facebook DM tool surface with a positive minimal allowlist (`session_status` only); persisted profiles, provider overrides, additive allowlists, and code mode cannot widen an untrusted public turn.
- Added the mandatory Fly public route guard: only gateway health stays public;
  customer portal, legal, Mollie and both Facebook webhook paths are blocked on
  the personal gateway regardless of stale route/proxy environment values. The
  broader OpenClaw gateway UI/API remains admin-gated.

## Remaining Blockers

- The current route-guard hotfix image does not contain this startup script or plugin build. The standard gateway target remains manifest-blocked pending a mounted-state rehearsal plus reviewed rollout and rollback artifacts that both retain these isolation controls.
- OpenClaw does not yet have verified exact non-archiving host transcript
  erasure. Keep every OpenClaw transcript/customer feature disabled until that
  personal-product privacy gate passes.
- Image-gen may treat the OpenClaw erasure gap as non-blocking only after the
  protected production callback/routing evidence proves that no customer
  image-generation turn creates an OpenClaw session.
- WhatsApp is operationally wired in the image-gen runtime: its credentials are mandatory at startup, `/webhook/whatsapp` is registered, and the production manifest names the callback canonical. Keep its release NO-GO until inbound WABA/phone identity resolves one exact workspace/connection/binding/privacy epoch, production sends use only that row's encrypted token, and text/image/audio attempts fail before any provider call on tenant, rebind, disconnect, or privacy mismatch.
- Live image generation requires the separate `leaderbot-fb-image-gen` service key and OpenAI billing/key state to be healthy.
- `npm audit --omit=dev --audit-level=high` could not complete from this Windows environment because the registry audit endpoint request failed with `EACCES`; rerun from CI or another network before broad launch.
- Broad customer launch still requires the remaining portal, billing, usage-control, monitoring, and tenant-isolation work tracked in the canonical backlog.
- Live Mollie billing is blocked by the explicit items in `LAUNCH_READINESS.md`, including sandbox evidence and workspace-entitlement enforcement in provider quota paths.

## Latest Operator Verification

- Live Messenger smoke was verified by operator on 2026-06-30 with the real Page.
- `delete-my-data` / GDPR deletion behavior was verified by operator on 2026-06-30.
- Messenger photo forwarding and storage-proxy delivery for generated/source images were verified by operator on 2026-06-30 with tester photo forwards.

## Required Fly Secrets / Env Vars

Gateway app: `leaderbot-openclaw-gateway`

- `OPENAI_API_KEY`
- `GATEWAY_AUTH_TOKEN`
- `OPENCLAW_GATEWAY_TOKEN`

Important env:

- `OPENCLAW_STATE_DIR=/data`
- `OPENCLAW_CONFIG_PATH=/data/openclaw.json`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `OPENCLAW_PUBLIC_GATEWAY_GUARD=1`
- `OPENCLAW_PUBLIC_GATEWAY_PATHS=/healthz`
- `OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE=pairing`
- `OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED=0`

Do not configure `LEADERBOT_IMAGE_GEN_URL` or a Leaderbot bridge token on this
personal-only gateway. Image-gen owns its own exact Meta credentials and
workspace/Page bindings; those secrets remain outside this gateway checklist.

Mollie billing variables are documented in `apps/image-gen/.env.example`. Keep
`MOLLIE_BILLING_ENABLED=false`, `MOLLIE_MODE=test`, and
`MOLLIE_LIVE_BILLING_ENABLED=false` while the public site only collects
early-access interest. Enable the master switch only in an approved test
environment or after the billing launch decision is GO.

Startup makes the reviewed `pairing` and bridge-disabled settings authoritative
over stale top-level or account-level public values on the mounted volume. A
persisted `dmPolicy: open`, `leaderbot_free_tier` or
`leaderbotBridgeEnabled: true` value must not restore customer forwarding.

## Deploy Command

There is no approved gateway deploy command while
`deploy/production/apps.json` keeps the target disabled. After the volume
rehearsal, compatible rollback artifact, reviewed immutable rollout image, and
manifest rebaseline are approved, use the protected `Deploy production`
workflow with target `gateway`. Do not source-deploy this change or use the
route-guard hotfix as isolation evidence.

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

- Confirm both the rollout and rollback images contain the same session, memory, tool, quarantine, and attachment-cleanup controls; an older memory-creating startup image is not rollback-safe.
- Rehearse startup on a snapshot/clone of the mounted volume. Treat quarantine collisions as stop conditions and do not inspect, overwrite, or delete customer content without an approved audited access flow.
- Confirm the gateway `/healthz` route is reachable and no additional gateway UI/API routes are publicly exposed.
- Confirm image-gen `/healthz`, `/readyz`, and `/metrics` are reachable.
- Confirm image-gen queue metrics show bounded `messenger_generation_queue_jobs{state="queued"}`, `messenger_generation_queue_jobs{state="processing"}`, and `messenger_generation_global_slots{state="active"}`.
- Confirm failed/dead-lettered generation jobs are zero or have an owner-reviewed incident note.
- Confirm recent logs contain no raw PSIDs, access tokens, customer messages, uploaded knowledge, generated prompts, or generated outputs.
- Confirm the personal gateway exposes only health publicly. Portal, legal,
  Mollie and both Facebook webhook paths must return `404`; their canonical
  customer endpoints are direct image-gen routes.
- Confirm no `LEADERBOT_IMAGE_GEN_URL`, bridge token, public unknown-sender mode
  or enabled Leaderbot bridge is present in the reviewed gateway configuration.
- Before relying on the image-gen OpenClaw-erasure exemption, confirm the
  production Meta callback and customer image path terminate directly in
  image-gen and create no OpenClaw host session transcript.
- Create a metadata-only smoke evidence file with `npm run messenger:smoke-template > smoke-evidence.json`.

After deploy:

- Re-run gateway `/healthz` and image-gen `/healthz`, `/readyz`, and `/metrics`.
- Confirm gateway `/facebook/webhook` and `/messenger/webhook` return `404`.
- Confirm `webhook_ack_sent` latency stays within the current production target and event-loop p95/p99 remains below the documented rollout threshold.
- Confirm queue depth drains normally, failed/dead-lettered job counts do not increase, and worker lease/reclaim logs are healthy after a worker restart or deploy event.
- Run the manual Messenger smoke below with the real Page.
- Record metadata-only release notes: commit, image/release id, smoke result, rollback target, and any cost/quota anomalies.
- Validate the smoke evidence before sharing or archiving it with `npm run messenger:smoke-validate -- smoke-evidence.json`.

Controlled direct image-gen Messenger smoke, only after the separate Meta gate
authorizes it:

- Confirm the registered Meta Page callback is the canonical image-gen
  `/facebook/webhook`, never the OpenClaw gateway.
- Send `ben je online`; expect an image-gen status reply without any OpenClaw
  session creation.
- Send a normal text question; expect the image-gen conversation response.
- Send a photo without edit text; expect the photo-received prompt asking what to change, not an automatic generated replacement image.
- Send `maak een afbeelding van ...`; expect the image-gen service path.
- Send `maak een futuristische stad bij zonsondergang`; expect text-to-image, not a style-picker default.
- Send `maak een prompt voor een afbeelding`; expect the image-gen conversation
  layer response, not an OpenClaw turn.
- Send a source photo plus explicit edit text such as `maak me cyberpunk`; expect the source-image edit path.

## Rollback Notes

Use only the protected production workflow and a reviewed immutable rollback
image recorded in the production manifest. A previous image that creates
`MEMORY.md`, restores memory search, or lacks per-turn session/tool enforcement
is not an acceptable rollback target.

Startup moves legacy shared `USER.md`, `MEMORY.md`, and `memory/` entries into a
recoverable quarantine. It never overwrites an existing quarantine. Rollback
must preserve that boundary; restoring quarantined content into the public
workspace would reintroduce the incident this control is designed to contain.

## Known Risks

- Keep the personal OpenClaw gateway in pairing mode with
  `leaderbotBridgeEnabled=false`; it is not a customer ingress surface.
- Public image-gen Pages need approved paywall, consent, deletion, quota, abuse,
  privacy and retention controls before commercial exposure.
- Messenger `RESPONSE` messages are constrained by Meta's response window.
- Provider/API billing failures surface as assistant/image-generation failures; smoke tests must include the live keys.
- The current local validation does not replace Meta App Review, Page permission, and webhook subscription checks.
