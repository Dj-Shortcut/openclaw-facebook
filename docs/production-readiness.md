# Production Readiness

Status: Not ready for broad customer launch. Live Messenger messaging was operator-verified, but complete delete-data handling and live Mollie billing remain NO-GO.

Last updated: 2026-08-21

Canonical release strategy and open work are tracked in
[`docs/operations/todo.md`](operations/todo.md).
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

- Fixed Fly gateway workspace persistence: OpenClaw now uses `/data/workspace` through `OPENCLAW_WORKSPACE_DIR` for static instruction files only.
- Added startup migration for missing static instruction files from `/home/node/.openclaw/workspace` to `/data/workspace`.
- Disabled shared public memory plugins, hooks, flushes, and tools. Existing `USER.md`, `MEMORY.md`, and `memory/` content is moved to `/data/private-memory-quarantine-v1` before startup so Page tenants cannot share durable assistant memory.
- Repaired persisted config when it contains the known legacy default workspace path.
- Kept OpenClaw built-in `image_generate` denied on the public gateway; Messenger image generation stays routed through Leaderbot image-gen.
- Replaced the public-open Facebook DM tool surface with a positive minimal allowlist (`session_status` only); persisted profiles, provider overrides, code mode, and broader session/messaging/automation/runtime tools cannot widen an untrusted turn.
- Added the Fly public route guard: webhook and health routes stay public, customer portal/legal routes can be proxied to Leaderbot, and the broader OpenClaw gateway UI/API is not reachable from the internet.

## Remaining Blockers

- OpenClaw 2026.7.2-beta.7 does not expose a supported non-archiving purge for an ordinary host-owned session transcript to this external path-installed channel plugin. The Messenger delete-data route therefore fails closed before claiming authoritative completion whenever an exact OpenClaw session exists. Launch requires a host-owned exact transcript-erasure capability and trusted plugin provenance; `sessions.delete` is not sufficient because it retains a deleted transcript archive.
- Live image generation requires the separate `leaderbot-fb-image-gen` service key and OpenAI billing/key state to be healthy.
- Broad customer launch remains blocked by the exact OpenClaw transcript gate
  above and the provider-sandbox, deployment, monitoring and human approvals in
  `LAUNCH_READINESS.md`.
- Live Mollie billing is blocked by the explicit sandbox/live items in
  `LAUNCH_READINESS.md`; workspace-entitlement enforcement in provider quota
  paths is implemented and is no longer listed as open repository work.

## Latest Operator Verification

- Root `npm audit` and image-gen `pnpm audit --prod` were rerun on 2026-08-21: both production dependency graphs report zero known vulnerabilities. The remaining Drizzle CLI-only esbuild development-server advisory does not ship in either runtime image and remains a toolchain-upgrade item, not a launch exposure.
- Live Messenger smoke was verified by operator on 2026-06-30 with the real Page.
- The legacy `delete-my-data` behavior was exercised by an operator on 2026-06-30. That smoke is not evidence for the stricter current full-erasure contract: the remaining OpenClaw transcript blocker above must be closed and re-tested.
- Messenger photo forwarding and storage-proxy delivery for generated/source images were verified by operator on 2026-06-30 with tester photo forwards.

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
- `MESSENGER_PRIVACY_ERASURE_ENCRYPTION_ACTIVE_KEY_ID` identifies the current
  durable deletion-job encryption key.
- `MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON` is the secret versioned
  AES-256-GCM keyring. Never place its values in logs, documentation, or a PR.
  Add a new key before switching the active id; retain old keys until the
  privacy-erasure pending count is zero or every pending job has been claimed
  and automatically rewrapped. `/readyz` opens an atomic bounded snapshot of
  every pending envelope, so removing an in-use key or exceeding the safe
  backlog bound fails closed. It also requires this process's recent successful
  metadata-only worker heartbeat and rejects an overdue due-job score. Startup
  awaits the first complete claim/store poll before opening HTTP or starting the
  generation worker; generation-worker-only mode uses that same gate because it
  has no HTTP readiness endpoint.

Mollie billing variables are documented in `apps/image-gen/.env.example`. Keep
`MOLLIE_BILLING_ENABLED=false`, `MOLLIE_MODE=test`, and
`MOLLIE_LIVE_BILLING_ENABLED=false` while the public site only collects
early-access interest. Enable the master switch only in an approved test
environment or after the billing launch decision is GO.

The token alone must not enable forwarding. The Facebook channel config also
needs `leaderbotBridgeEnabled: true` for any Messenger event, Page-scoped sender
ID, prompt, or media URL to be sent to the separate Leaderbot image-generation
service.

### Privacy transport containment

- A provider or Graph transport marked `started`/`ambiguous` is never retried
  or expired automatically. The deletion saga remains `pending`.
- A platform admin can list metadata-only blocked attempts for one explicit
  workspace through `privacyAdmin.blockedProviderAttempts`.
- Only after the started lease has expired (or the outcome is already
  ambiguous), the admin may call `privacyAdmin.reconcileProviderAttempt` with
  the exact attempt hash, connection, binding/privacy epochs, attempt number,
  expected status, a closed reconciliation outcome, and a metadata-only
  evidence-reference hash. The resolver accepts only provider-not-accepted or
  artifact-contained evidence, permanently disables retry, and writes one
  metadata-only `auditLog` event. A legacy blind `abandoned` row remains a hard
  fence and cannot make erasure authoritative.
- Retry the deletion worker after containment. It removes the terminal fence
  and its privacy-scoped user key before marking the subject erased.
- Page disconnect/rebind follows the same fence: active or unreconciled
  attempts block the binding change. After the authenticated evidence-backed
  resolution moves the attempt to `contained`, disconnect/rebind retires that
  terminal metadata atomically before the epoch is bumped; no provider retry
  is issued.

### Tenant-scoped cost ledger rollout

- Provider-attempt detail is stored per workspace and immutable connection,
  binding, and privacy epoch. The global budget baseline contains totals only;
  it contains no workspace, user, request, or provider-usage identifiers.
- `/readyz` check `tenant_scoped_cost_ledger` fails closed when Redis is absent
  in production or when any legacy `cost:ledger:period:*` key remains.
- Never infer a tenant from a legacy ledger payload. Before rollout, an
  authorized operator must count those legacy keys without reading their
  values, apply the approved retention/backup decision, and remove them in
  bounded batches. Re-run `/readyz` after the purge; do not enable provider
  spend while this check is red.
- GDPR erasure writes a monotonic subject tombstone and deletes only the exact
  workspace, connection, and privacy epochs being erased. Redis detail writes
  use a workspace hash slot and atomically check the subject tombstone in the
  same Lua commit, so an expired process lock cannot recreate an older entry.
  Cleanup scans 91 inclusive UTC day partitions for the 90-day TTL: day N
  through day N-90.

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
- Confirm `tenant_scoped_cost_ledger` is green; any legacy-ledger finding is a
  stop condition, not a migration prompt.
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
