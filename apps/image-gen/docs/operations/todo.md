# Leaderbot Image Generator - Primary Backlog (`todo.md`)

> Dit bestand is de enige bron van waarheid voor open werk.
> Historische audit- en refactorrapporten zijn verwijderd of samengevat; open punten staan hier.

## Verified snapshot

- Last reviewed against code: **2026-06-01**
- Verified commit: **`a341b4e`**
- Current direction: generic prompt-first image generation; legacy style-picker UI, quick-reply flows, and director-mode preset plumbing are removed. Internal style-preset compatibility may remain only as backend fallback.
- Product direction: `leaderbot.live` becomes a tenant/customer portal for managing each customer's own AI. The OpenClaw/Messenger gateway remains shielded and is not the customer-facing app.
- Historical audit and inventory files are not active plans. Keep valid open work here instead of reviving stale audit snapshots.

## Architecture boundary notes

- Root `src/` is the generic OpenClaw Facebook/Messenger plugin surface. Keep it channel-integration oriented and avoid moving Leaderbot image-generation runtime ownership into this layer.
- `apps/image-gen/server/_core` is the Leaderbot image-generation runtime. Keep image-generation behavior, prompt-first orchestration, and runtime primitives owned there rather than in Messenger transport code.
- Leaderbot-specific bridge code that currently lives in `src/monitor.ts` is temporary. It must stay behind an adapter boundary so it can be replaced without coupling the generic OpenClaw Facebook/Messenger plugin to Leaderbot runtime details.
- Conversation modules must not import Messenger or WhatsApp transport APIs. They should expose channel-neutral conversation responses/actions for renderers to translate into platform-specific controls.
- State, quota, and storage boundaries must later become explicitly tenant-, workspace-, and channel-scoped before broader customer rollout, with no shared customer-content paths across tenants.

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
- [x] Scaffold customer-facing Tauri portal app with tenant-scoped portal API surfaces
- [x] Add initial Facebook Page Connect authorization entrypoint for customer workspaces
- [ ] Add portal authentication before broad customer launch
- [x] Add tenant isolation tests before broad customer launch
- [x] Add portal audit logging before broad customer launch
- [ ] Add billing and usage controls before broad customer launch
- [ ] Verify GDPR deletion end-to-end before broad customer launch
- [ ] Keep the internal OpenClaw gateway unavailable as a public UI/API; expose only required webhook/health routes
- [ ] Move public legal routes (`/privacy`, `/terms`, `/data-deletion`) into the portal surface before pointing customer traffic there
- [x] Remove legacy campaign/style assets that do not support the portal direction
- [ ] Observe generic text-to-image quality before removing remaining internal style-preset backend compatibility
- [ ] Create "upgrade to premium" prompt when limit reached
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

Open cost-control work:

1. [ ] Implement per-image/request cost tracking.
2. [ ] Add full host-level budget gates before all expensive model/image/tool calls.
3. [ ] Add default-deny tool policy for all high-cost tools exposed to untrusted Facebook-originated users.
4. [ ] Add per-user daily spend caps for paired Facebook users.
5. [ ] Add global Facebook daily spend cap.
6. [ ] Write expensive provider calls to a cost ledger with pseudonymous `userKey`, provider/model, usage, estimated cost, final cost, and status.
7. [ ] Add owner dashboard for Facebook spend by day/month, account/page, `userKey`, blocked attempts, duplicate skips, and provider failures.
8. [ ] Add user-facing balance/spend overview before paid rollout.
9. [ ] Add monthly cost cap enforcement.
10. [ ] Send cost alerts to owner.
11. [x] Add external uptime monitor for `/healthz`.
12. [x] Add a dedicated generated-video quota namespace before enabling any video provider call.
13. [ ] Move remaining feature-specific quota counters toward a single channel-neutral usage ledger before paid rollout.

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
- [x] Create setup guide for Meta configuration
- [ ] Document current generic image prompt behavior for user-facing copy
- [ ] Provide cost monitoring dashboard
- [ ] Create user-facing bot instructions

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
