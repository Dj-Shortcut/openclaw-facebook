# Leaderbot Image Generator - Primary Backlog (`todo.md`)

> Dit bestand is de enige bron van waarheid voor open werk.
> Historische audit- en refactorrapporten zijn verwijderd of samengevat; open punten staan hier.

## Verified snapshot

- Last reviewed against code: **2026-06-21**
- Verified commit: **`6e2ceb0`**
- Current direction: generic prompt-first image generation; legacy style-picker UI, quick-reply flows, and director-mode preset plumbing are removed. Internal style-preset compatibility may remain only as backend fallback.
- Product direction: `leaderbot.live` becomes a tenant/customer portal for managing each customer's own AI. The OpenClaw/Messenger gateway remains shielded and is not the customer-facing app.
- Historical audit and inventory files are not active plans. Keep valid open work here instead of reviving stale audit snapshots.

## Architecture boundary notes

- Root `src/` is the generic OpenClaw Facebook/Messenger plugin surface. Keep it channel-integration oriented and avoid moving Leaderbot image-generation runtime ownership into this layer.
- `apps/image-gen/server/_core` is the Leaderbot image-generation runtime. Keep image-generation behavior, prompt-first orchestration, and runtime primitives owned there rather than in Messenger transport code.
- Leaderbot-specific bridge code that currently lives in `src/monitor.ts` is temporary. It must stay behind an adapter boundary and remain explicitly opt-in (`leaderbotBridgeEnabled`) so ClawHub/private installs do not forward Messenger content to the external image-generation service just because host-level bridge tokens exist.
- Conversation modules must not import Messenger or WhatsApp transport APIs. They should expose channel-neutral conversation responses/actions for renderers to translate into platform-specific controls.
- State, quota, and storage boundaries must later become explicitly tenant-, workspace-, and channel-scoped before broader customer rollout, with no shared customer-content paths across tenants.

## Production release strategy

Leaderbot is already publicly reachable, so release work is gated by live-safety
risk rather than feature ambition. Each gate should be completed as small PRs
with targeted tests and metadata-only observability. Do not expand public access,
Meta permissions, paid provider usage, or customer self-serve features until the
prior gate is proven in production.

### Gate 1: immediate stabilization

Goal: keep the live Messenger bot reliable, bounded, and reversible while it is
reachable by real users.

Required before any broader traffic, marketing, or customer onboarding:

1. [x] Preserve Meta webhook verification, POST signature validation, request-size limits, fast ACK behavior, and Messenger response-window compatibility.
2. [x] Keep the OpenClaw public gateway shielded: expose only required webhook/health routes and deny built-in high-cost `image_generate` on the gateway.
3. [x] Keep Messenger image/audio/video quota commits tied to provider attempts, with retryable preflight failures releasing reservations.
4. [x] Keep Redis-backed webhook ingress, generation queue dedupe, worker lease/reclaim behavior, and queue metrics enabled for production image-generation traffic.
5. [x] Keep privacy-safe logging defaults: hashed/pseudonymous sender identifiers, redacted errors, and no raw PSIDs, tokens, customer messages, uploaded knowledge, or generated prompts/outputs in logs.
6. [x] Keep face memory disabled by default and retain the protected emergency disable route for rollback.
7. [x] Maintain the documented Fly rollback workflow and non-destructive workspace migration behavior.
8. [ ] Run and record a live Messenger smoke after each production deploy: webhook verification, signed POST delivery, text reply, prompt-first text-to-image, source-photo edit, quota-exhausted path, and Graph API send failure handling.
9. [ ] Verify GDPR consent and `delete-my-data` behavior end-to-end with live or production-equivalent state, including generated assets, retained source images, face-memory state, and tenant/customer portal records. The smoke evidence validator now requires these deletion-proof checks before Gate 1 exit.
10. [x] Add a release checklist entry that confirms `/healthz`, `/readyz`, `/metrics`, queue depth, failed/dead-lettered jobs, and event-loop p95/p99 before and after deploy.

Exit criteria: live smoke passes, deletion proof is recorded, no public route
regression is found, cost/quota metrics are visible, and rollback target is known
before deployment.

### Gate 2: public hardening

Goal: make the public bot safe for sustained usage beyond controlled smoke.

Required before enabling open `dmPolicy`, public promotion, or broader free-tier
access:

1. [x] Implement per-image/request cost tracking.
2. [x] Add full host-level budget gates before all expensive model/image/tool calls. Current Facebook-host expensive paths are covered by default-deny OpenClaw tool policy plus optional root-gateway caps for image-intent forwards, voice transcription, and generic Leaderbot event forwards; image-gen runtime provider calls keep their quota/spend gates.
3. [x] Add default-deny tool policy for all high-cost tools exposed to untrusted Facebook-originated users.
4. [x] Add per-user daily spend caps, a global Facebook daily spend cap, and monthly cost cap enforcement.
5. [x] Write expensive provider calls to a cost ledger with pseudonymous `userKey`, provider/model, estimated cost, final cost, status, and UTC period.
6. [x] Add richer provider usage dimensions to cost-ledger entries where providers expose safe metadata.
7. [ ] Add owner cost alerts and an owner dashboard for spend, quota blocks, duplicate skips, provider failures, queue health, and delivery failures.
8. [ ] Continue verifying storage-proxy delivery under Messenger crawler constraints, including generated outputs and retained source images.
9. [ ] Evaluate stronger queue/outbox semantics if exactly-once Messenger image sends become mandatory.
10. [x] Keep public legal pages current (`/privacy`, `/terms`, `/data-deletion`) and aligned with Meta App Review, face-memory status, retention, and deletion behavior. Current image-gen runtime legal pages include tested privacy, terms, and data-deletion routes; future portal relocation remains a Gate 3 task.
11. [x] Document Meta App Review impact for each new Messenger capability and avoid permission expansion unless product/policy approval is explicit. Current review notes live in `apps/image-gen/docs/operations/meta-app-review.md`; keep them updated for future Messenger capability changes.

Exit criteria: all paid/provider calls are budget-gated and ledgered, public legal
copy matches behavior, owner monitoring can detect cost/reliability regressions,
and Meta review/demo notes are reproducible.

### Gate 3: customer-platform expansion

Goal: turn `leaderbot.live` into a tenant-owned customer platform without
exposing internal gateway controls or cross-tenant data.

Required before broad customer launch:

1. [ ] Design the `leaderbot.live` tenant/customer portal as a real app, not a brochure site.
2. [ ] Define the tenant model for customer workspace, owned AI identity, channel connections, knowledge, usage, billing, and privacy controls.
3. [ ] Add portal authentication.
4. [ ] Add billing and usage controls, including user-facing balance/spend overview and upgrade prompts.
5. [ ] Move public legal routes (`/privacy`, `/terms`, `/data-deletion`) into the portal surface before pointing customer traffic there.
6. [ ] Keep the internal OpenClaw gateway unavailable as a public UI/API; expose only required webhook/health/legal/customer-app surfaces.
7. [ ] Move remaining feature-specific quota counters toward a single channel-neutral, tenant/workspace-scoped usage ledger before paid rollout.
8. [ ] Verify tenant isolation across uploaded knowledge, extracted text, embeddings/retrieval artifacts, assistant memory, conversations, channel identifiers, generated prompts/outputs, billing, logs, support access, export, and deletion paths.
9. [x] Provide customer-facing bot instructions, current generic prompt behavior copy, privacy controls, and export/deletion instructions.
10. [ ] Keep legacy style-picker/campaign assets removed and do not reintroduce style catalogs unless explicitly requested.

Exit criteria: customer data is tenant-scoped by design, support/break-glass access
is explicit and auditable, customer billing/privacy controls exist, and public
traffic cannot reach internal gateway admin/API surfaces.

## Actieve backlog (open)

### Architectuur

- [x] Centraliseer Redis client management
- [x] Maak Face Memory retentie configureerbaar via ENV
- [x] Verplaats Admin Rate Limiting van memory naar Redis
- [x] Consolideer operationele logging naar `safeLog` / gestructureerde logger

### Product & bot-ervaring

- [ ] Design the `leaderbot.live` tenant/customer portal as a real app, not a brochure site
- [ ] Define tenant model: customer workspace, owned AI identity, channel connections, knowledge, usage, and privacy controls
- [x] Add tenant model foundation: knowledge sources + privacy controls persistence and portal snapshot exposure
- [x] Add tenant-checked customer portal API for knowledge source registration and listing
- [x] Add customer-facing knowledge source registration and status list to the portal dashboard
- [x] Add tenant-checked customer control to disable knowledge sources
- [x] Scaffold customer-facing Tauri portal app with tenant-scoped portal API surfaces
- [x] Replace the marketing-style home screen with an authenticated customer portal dashboard and customer-editable AI identity/instructions
- [x] Add tenant-checked workspace name management in the customer portal
- [x] Add tenant-checked workspace member visibility in the customer portal
- [x] Add initial Facebook Page Connect authorization entrypoint for customer workspaces
- [x] Add tested REST portal auth guard for snapshot and customer-owned mutations
- [x] Add tenant-scoped portal export/deletion request tracking for customer data controls
- [x] Add customer-visible data request status summary and outage-safe request loading
- [x] Add initial customer-facing free-plan usage balance and upgrade prompt to the portal dashboard
- [x] Add portal-rendered privacy, terms, and data-deletion pages with local footer links
- [x] Add customer-facing bot instructions for prompt-first image use, workspace context, and data controls
- [x] Keep ordinary Messenger conversations on the OpenClaw turn instead of falling back to image-generation help copy
- [x] Add tenant-checked Messenger disconnect control that clears stored page token data
- [x] Add portal authentication before broad customer launch
- [x] Enforce Facebook Login-only customer portal sessions
- [x] Create or load a persisted customer workspace during Facebook Login before issuing the portal session
- [x] Add tenant-checked portal auth session metadata for customer workspace membership
- [x] Add tenant isolation tests before broad customer launch
- [x] Add portal audit logging before broad customer launch
- [x] Add tenant-checked portal upgrade request control with privacy-safe billing audit metadata
- [x] Add tenant-scoped portal upgrade request tracking and customer-visible request status history
- [x] Add production readiness guard for the customer portal database configuration
- [x] Document the production customer portal database secret, migration, readiness, and smoke-test rollout order
- [x] Add a production portal verifier for DATABASE_URL readiness and public endpoint checks
- [ ] Add billing and usage controls before broad customer launch
- [ ] Deploy and verify the `leaderbot.live` customer portal in production.
  - `leaderbot.live` must route to the tenant/customer portal, not the old gateway or brochure surface.
  - Production auth/session/env config must allow a customer to sign in and load their own workspace.
  - Production portal smoke must cover workspace details, AI identity/instructions, Messenger status/connect controls, usage, privacy controls, and export/deletion request status.
  - Public production surface must expose only the customer portal, legal pages, health/readiness/metrics as intended, and required webhook routes; internal gateway/admin APIs must remain shielded.
- [ ] Verify GDPR deletion end-to-end before broad customer launch
- [ ] Keep the internal OpenClaw gateway unavailable as a public UI/API; expose only required webhook/health routes
- [ ] Move public legal routes (`/privacy`, `/terms`, `/data-deletion`) into the portal surface before pointing customer traffic there. Initial React portal pages and local footer links exist; production routing and Meta review verification remain open.
- [x] Remove legacy campaign/style assets that do not support the portal direction
- [ ] Observe generic text-to-image quality before removing remaining internal style-preset backend compatibility
- [x] Create "upgrade to premium" prompt when limit reached
- [ ] Add image gallery/history for users
- [ ] Plan Messenger generated-video support before implementation
  - Uploaded Messenger videos remain unsupported input.
  - Generated video is future output only, behind a feature flag.
  - Future video provider calls must reserve quota before any paid external request, commit on usable success, and release or expire on failure.
  - See `apps/image-gen/docs/operations/messenger-video-support-spike.md`.

### Kosten & quota

Validated controls:

1. [x] Messenger quota checks run before generation.
2. [x] Database-backed daily quota tables/helpers (`dailyQuota`) are available.
3. [x] Duplicate Messenger generation queue enqueues are deduped by request id.
4. [x] Production queue metrics expose queued, processing, failed, global-slot, Redis-backed, and scrape-error state.
5. [x] Public OpenClaw gateway denies the built-in `image_generate` tool; Messenger image generation routes through the separate image-gen service.
6. [x] Optional global daily Messenger image cap (`MESSENGER_GLOBAL_DAILY_IMAGE_CAP`) blocks OpenAI image requests before the provider call.
7. [x] Messenger and WhatsApp image quota now commits when a provider attempt starts, so billable provider failures/timeouts count against user limits while preflight source-image validation failures remain retryable.
8. [x] Messenger generated-video and audio-transcription quota also commits when provider attempts start, closing the same retry leak for newer paid features.
9. [x] Shared bot text rate limiting is configurable via `BOT_TEXT_RATE_LIMIT_MAX` and `BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS` instead of hardcoded limits.
10. [x] New bot features have a reusable feature-scoped limiter helper and generic `FEATURE_RATE_LIMIT_<FEATURE>_*` env convention.
11. [x] Free-tier product targets are documented before runtime changes: `20` image provider attempts per UTC day, `30` bot text messages per `60` seconds, `5` audio transcription attempts per UTC day, and `1` video generation attempt per UTC day.
12. [x] Admin-only `/admin/cost-summary` exposes owner-safe aggregate cost ledger summaries without raw PSIDs, prompts, tokens, or customer content.
13. [x] OpenAI image, audio transcription, and generated-video provider attempts append metadata-only cost ledger entries after quota/budget checks and before external provider calls.
14. [x] Optional global daily Messenger provider spend cap (`MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD`) blocks priced attempts that would exceed the cap and fails closed for unpriced attempts.
15. [x] Optional per-user daily Messenger provider spend cap (`MESSENGER_USER_DAILY_SPEND_CAP_USD`) blocks priced attempts per `userKey` and fails closed for unpriced attempts.
16. [x] Root Facebook gateway stamps untrusted inbound turns with a default-deny `tools.deny` policy for high-cost, runtime, and filesystem tools.
17. [x] Cost ledger summaries roll up provider-attempt cost metadata per request using hashed request keys instead of raw Messenger message IDs.
18. [x] Optional global monthly Messenger provider spend cap (`MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD`) blocks image/audio/video provider attempts before external calls and is exposed in metrics.
19. [x] `delete-my-data` erasure removes the erased user's cost-ledger entries and deletion failure logs use pseudonymous `user` metadata instead of raw PSIDs.
20. [x] Image, audio transcription, and generated-video cost-ledger entries are reconciled from `provider_attempt_started` to success/failure status, with image final cost populated when the estimate is complete.
21. [x] Admin cost summaries expose owner-safe open, failed, blocked, and per-status provider-attempt counts for monitoring regressions without raw PSIDs or prompts.
22. [x] Optional owner cost alerts (`MESSENGER_OWNER_COST_ALERTS=1`) notify on daily/monthly/user spend-cap blocks with metadata-only budget details.
23. [x] Optional root-gateway daily image forward cap (`MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP`) blocks Facebook image-intent bridge calls before they reach Leaderbot image-gen.
24. [x] Optional root-gateway daily audio transcription cap (`MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP`) blocks Facebook voice attachment transcription before media download or model transcription.
25. [x] Optional root-gateway daily Leaderbot event forward cap (`MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP`) blocks generic free-tier/interactive Messenger event forwards before they reach Leaderbot image-gen, while preserving delete-data forwards.
26. [x] Optional audio transcription cost estimate (`OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD`) feeds spend-cap checks and reconciles successful audio ledger attempts with final cost.
27. [x] Optional video generation cost estimate (`OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD`) feeds spend-cap checks and reconciles successful video ledger attempts with final cost.

Open cost-control work:

1. [x] Implement per-image/request cost tracking.
2. [x] Add full host-level budget gates before all expensive model/image/tool calls. Current Facebook-host expensive paths are covered by default-deny OpenClaw tool policy plus optional root-gateway caps for image-intent forwards, voice transcription, and generic Leaderbot event forwards; image-gen runtime provider calls keep their quota/spend gates.
3. [x] Add default-deny tool policy for all high-cost tools exposed to untrusted Facebook-originated users.
4. [x] Add per-user daily spend caps for paired Facebook users.
5. [x] Add global Facebook daily spend cap.
6. [x] Write expensive provider calls to a cost ledger with pseudonymous `userKey`, provider/model, estimated cost, final cost, and status. Image, audio transcription, and generated-video attempts now write metadata-only entries and reconcile success/failure status; image plus optionally-priced audio/video attempts populate final cost when the estimate is complete.
7. [x] Add richer provider usage dimensions to cost-ledger entries where providers expose safe metadata.
8. [ ] Add owner dashboard for Facebook spend by day/month, account/page, `userKey`, blocked attempts, duplicate skips, and provider failures. The admin-only cost summary route now includes stored spend plus open/failed/blocked/status counts and Messenger generation queue health; dashboard UX remains open.
9. [ ] Add user-facing balance/spend overview before paid rollout. Initial free-plan image balance, rate-limit context, blocked count, and upgrade prompt are now visible in the customer portal; paid spend and billing integration remain open.
10. [x] Add monthly cost cap enforcement.
11. [x] Send cost alerts to owner for spend-cap blocks.
12. [x] Add external uptime monitor for `/healthz`.
13. [x] Add a dedicated generated-video quota namespace before enabling any video provider call.
14. [ ] Move remaining feature-specific quota counters toward a single channel-neutral usage ledger before paid rollout.

### Cost Ledger Reliability Hardening (Phase 2)

- [x] P1 | owner: image-gen-runtime | Handle cost-ledger per-period overflow explicitly. Emit structured warnings + metric and report dropped-entry count when cap truncation occurs.
- [x] P1 | owner: image-gen-runtime | Make cost-ledger append/update writes resilient under same-period concurrent updates using single-writer or safe retry semantics.
- [x] P2 | owner: image-gen-runtime | Make provider-attempt updates period-safe across midnight retries by reconciling by entry identity rather than current-period-only assumptions.
- [x] P2 | owner: image-gen-runtime, storage-platform | Reduce worst-case delete-my-data ledger cleanup latency by making `deleteCostLedgerEntriesForUser` bounded/performance-safe for high-history users. Cleanup now scans the fixed 90-day retention window, skips locks for periods without matching user entries, and emits metadata-only completion counts.

Historical branch review note:

- [x] Reviewed stale branch `chore/image-gen-cost-ledger` on 2026-06-23. Do not merge or revive it wholesale: it predates the current portal/privacy work and would remove newer customer-portal, privacy-request, and OpenClaw login changes. Useful ideas from that branch are already represented on `main`: Redis legacy cost-ledger compatibility, deletion retry safety, admin cost-summary validation, Facebook inbound tool-policy config merging, delete-data attachment forwarding, and stricter positive USD cost estimate parsing.

Quota drift investigation note:

- Root cause: free-tier product targets were documented before runtime defaults changed, while older constants and tests still encoded `3` image/audio attempts and `10` bot text messages. Image and audio provider retry loops also reported only one quota commit for a multi-attempt provider operation.
- Affected paths reviewed: Messenger primary image generation, queued/background generation, internal Messenger image requests, duplicate delivery recovery, WhatsApp text-to-image and source-image edits, audio transcription, generated video, bot text rate limiting, global daily image/video caps, and provider-attempt callbacks.
- Bypasses closed: image and audio provider retries now require quota before each external provider call; preflight failures still release reservations without burning credits; duplicate completed deliveries still return before quota reserve/commit.
- Duplicated logic found: state quota in `messengerQuota.ts`, channel-neutral wrappers in `limits/generationQuota.ts`, global caps/concurrency in `generationGuard.ts`, feature rate limits in `featureRateLimit.ts`, and legacy DB daily quota helpers in `server/db.ts`.
- Concurrency risks remaining: state-store reservation locks reduce same-sender overlap, but global budget counters can overcount after failed attempts, reservation TTL expiry can still strand in-flight work during long provider calls, and multi-instance behavior depends on Redis-backed state being enabled in production.
- Follow-up: replace scattered quota constants/counters with one channel-neutral usage ledger/reservation service keyed by channel, sender/user identity, workspace/tenant, operation type, provider/model, reservation token, attempt status, estimated/final cost, and UTC period.

### Opslag & platform

- [x] Use durable storage proxy for generated images and retained source images
- [ ] Continue verifying storage-proxy delivery under Messenger crawler constraints
- [x] Run dedicated Messenger image-generation worker in production with Redis-backed queue enabled
- [ ] Evaluate stronger queue/outbox semantics if exactly-once Messenger image sends become mandatory

### Premium tier (ready but inactive)

- [ ] Design premium tier database schema
- [ ] Implement payment integration
- [ ] Create premium subscription management
- [ ] Implement premium quota limits
- [ ] Add premium feature flags

### Testing & docs

- [ ] Test cost tracking
- [ ] P1/P2 [owner: image-gen-runtime-test] Add targeted cost-ledger reliability tests for concurrent append/update behavior, overflow observability, midnight-crossing update reconciliation, and delete-cleanup latency under multi-period user history.
- [x] Create setup guide for Meta configuration
- [x] Document operator-facing prompt routing and OpenClaw-vs-image-generation fallback behavior separately from the completed customer-facing bot instructions. See `docs/operator-prompt-routing.md`.
- [ ] Provide cost monitoring dashboard

### Maintenance backlog

Run each pass as a separate, reviewable PR validated with `pnpm --dir apps/image-gen check`, `pnpm --dir apps/image-gen test`, `pnpm --dir apps/image-gen fallow:report`, and `pnpm --dir apps/image-gen fallow:gate`.

0. OpenClaw runtime upgrades for Fly/Docker installs
   - [x] Single supported update, validation, release, and rollback workflow is documented in `docs/openclaw-update.md`.
   - [x] Runtime validation is automated by `npm run openclaw:validate` and the Fly gateway image build.
   - [x] Follow-up: design a managed redeploy handoff with explicit operator approval, scoped deploy credentials, redacted audit logs, and rollback guidance. Do not mutate `/app/node_modules/openclaw` inside a running Fly machine. See `deploy/fly-gateway/managed-redeploy-handoff.md`.
1. Unused dependencies / package cleanup
   - Fallow currently reports `unused_dependencies: 0`; do not remove `express` while runtime/tests still import it.
   - Re-run Fallow after each dependency update and verify package-lock/pnpm-lock changes stay scoped.
2. Dead exports and dead files
   - Triage server dead exports before frontend entries; Fallow may not see Vite's `client/index.html` entry correctly.
   - Avoid data deletion, face memory, storage retention, webhook routing, Meta verification, and public API contracts unless code search and tests prove removal is safe.
3. Duplicated helpers
   - Start with duplicated test queue helpers reported in Messenger generation/webhook queue tests.
   - Keep helper extraction inside test code unless production duplication has direct maintenance cost.
4. Large/hot modules
   - Split only one responsibility per pass from webhook and generation modules.
   - Preserve routing, consent, quota, and image delivery behavior with targeted tests.
5. Risky architectural refactors
   - Handle channel-neutral conversation layering, portal ownership boundaries, and storage proxy changes separately from maintenance cleanup.
   - Require explicit migration and rollback notes before touching production data or public contracts.

## Reeds geverifieerd in code (afgerond)

- [x] OpenAI image generation integration via Responses image generation
- [x] OAuth callback + state validation flow
- [x] Messenger quota checks before generation
- [x] Database-backed quota tables/helpers (`dailyQuota`) beschikbaar
- [x] Redis-backed Messenger generation queue with dedicated worker is active in production
- [x] Duplicate Messenger generation queue enqueues are deduped by request id
- [x] Face Memory retention is configurable via `FACE_MEMORY_RETENTION_DAYS`
- [x] Webhook opgesplitst in `messengerWebhook.ts` + `webhookHandlers.ts` + `webhookHelpers.ts`
- [x] Deploy to production + webhook connectivity tests
- [x] Text-to-image generation accepts arbitrary visual prompts without defaulting to Storybook Anime
- [x] Image-generation success/failure follow-ups use channel-neutral conversation actions before Messenger rendering
- [x] Removed unused director prompt/social-copy modules so stale template presets cannot re-enter generation output
- [x] Removed director-mode fields from active generation/runtime state so stale template names cannot influence prompts or follow-up edits
- [x] Made image prompt building more prompt-faithful by removing role/template language and blocking default cinematic/editorial/anime/luxury aesthetics unless requested
- [x] Kept ambiguous "make me / maak me" visual requests prompt-first and routed missing-subject complaints as image follow-up corrections
- [x] Aligned internal image-request routing with prompt-first intent rules so retained photos no longer hijack ambiguous "maak me" prompts
- [x] Extracted shared image intent primitives so Messenger and internal image-request routing use the same prompt-first rules

## Historisch afgerond

- [x] Meta webhook/page/token setup
- [x] Initial Messenger webhook handler and image upload support
- [x] Legacy preset/style-prompt system documented as deprecated; do not treat it as the current product direction

> Note: Legacy route `/api/webhook/facebook` is deprecated and no longer used.
