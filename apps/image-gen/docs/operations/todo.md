# Leaderbot Image Generator - Primary Backlog (`todo.md`)

> Dit bestand is de enige bron van waarheid voor open werk.
> Historische audit- en refactorrapporten zijn verwijderd of samengevat; open punten staan hier.

## Verified snapshot

- Last reviewed against code: **2026-06-01**
- Verified commit: **`a341b4e`**
- Current direction: generic prompt-first image generation; legacy style-picker UI, quick-reply flows, and director-mode preset plumbing are removed. Internal style-preset compatibility may remain only as backend fallback.
- Product direction: `leaderbot.live` becomes a tenant/customer portal for managing each customer's own AI. The OpenClaw/Messenger gateway remains shielded and is not the customer-facing app.
- Historical audit and inventory files are not active plans. Keep valid open work here instead of reviving stale audit snapshots.

## Actieve backlog (open)

### Architectuur

- [x] Centraliseer Redis client management
- [x] Maak Face Memory retentie configureerbaar via ENV
- [x] Verplaats Admin Rate Limiting van memory naar Redis
- [ ] Consolideer operationele logging naar `safeLog` / gestructureerde logger

### Product & bot-ervaring

- [ ] Design the `leaderbot.live` tenant/customer portal as a real app, not a brochure site
- [ ] Define tenant model: customer workspace, owned AI identity, channel connections, knowledge, usage, and privacy controls
- [ ] Add portal authentication before broad customer launch
- [ ] Add tenant isolation tests before broad customer launch
- [ ] Add portal audit logging before broad customer launch
- [ ] Add billing and usage controls before broad customer launch
- [ ] Verify GDPR deletion end-to-end before broad customer launch
- [ ] Keep the internal OpenClaw gateway unavailable as a public UI/API; expose only required webhook/health routes
- [ ] Move public legal routes (`/privacy`, `/terms`, `/data-deletion`) into the portal surface before pointing customer traffic there
- [x] Remove legacy campaign/style assets that do not support the portal direction
- [ ] Observe generic text-to-image quality before removing remaining internal style-preset backend compatibility
- [ ] Create "upgrade to premium" prompt when limit reached
- [ ] Add image gallery/history for users

### Kosten & quota

Validated controls:

1. [x] Messenger quota checks run before generation.
2. [x] Database-backed daily quota tables/helpers (`dailyQuota`) are available.
3. [x] Duplicate Messenger generation queue enqueues are deduped by request id.
4. [x] Production queue metrics expose queued, processing, failed, global-slot, Redis-backed, and scrape-error state.
5. [x] Public OpenClaw gateway denies the built-in `image_generate` tool; Messenger image generation routes through the separate image-gen service.
6. [x] Optional global daily Messenger image cap (`MESSENGER_GLOBAL_DAILY_IMAGE_CAP`) blocks OpenAI image requests before the provider call.

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

## Reeds geverifieerd in code (afgerond)

- [x] OpenAI image generation integration via Responses image generation
- [x] OAuth callback + state validation flow
- [x] Messenger quota checks before generation
- [x] Database-backed quota tables/helpers (`dailyQuota`) beschikbaar
- [x] Redis-backed Messenger generation queue with dedicated worker is active in production
- [x] Duplicate Messenger generation queue enqueues are deduped by request id
- [x] Webhook opgesplitst in `messengerWebhook.ts` + `webhookHandlers.ts` + `webhookHelpers.ts`
- [x] Deploy to production + webhook connectivity tests
- [x] Text-to-image generation accepts arbitrary visual prompts without defaulting to Storybook Anime
- [x] Image-generation success/failure follow-ups use channel-neutral conversation actions before Messenger rendering
- [x] Removed unused director prompt/social-copy modules so stale template presets cannot re-enter generation output
- [x] Removed director-mode fields from active generation/runtime state so stale template names cannot influence prompts or follow-up edits

## Historisch afgerond

- [x] Meta webhook/page/token setup
- [x] Initial Messenger webhook handler and image upload support
- [x] Legacy preset/style-prompt system documented as deprecated; do not treat it as the current product direction

> Note: Legacy route `/api/webhook/facebook` is deprecated and no longer used.
