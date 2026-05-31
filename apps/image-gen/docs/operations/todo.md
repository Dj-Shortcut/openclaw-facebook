# Leaderbot Image Generator - Primary Backlog (`todo.md`)

> Dit bestand is de enige bron van waarheid voor open werk.
> Historische audit- en refactorrapporten zijn verwijderd of samengevat; open punten staan hier.

## Verified snapshot

- Last reviewed against code: **2026-05-30**
- Verified commit: **`158365d`** plus the follow-up documentation cleanup
- Current direction: generic prompt-first image generation; legacy style-picker UI and quick-reply flows are removed. Internal style-preset compatibility may remain only as backend fallback.
- Product direction: `leaderbot.live` becomes a tenant/customer portal for managing each customer's own AI. The OpenClaw/Messenger gateway remains shielded and is not the customer-facing app.

## Actieve backlog (open)

### Architectuur

- [ ] Centraliseer Redis client management
- [ ] Maak Face Memory retentie configureerbaar via ENV
- [ ] Verplaats Admin Rate Limiting van memory naar Redis
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

- [ ] Implement cost tracking per image/request
- [ ] Add monthly cost cap enforcement
- [ ] Send cost alerts to owner
- [ ] Add external uptime monitor for `/healthz`

### Opslag & platform

- [x] Use durable storage proxy for generated images and retained source images
- [ ] Continue verifying storage-proxy delivery under Messenger crawler constraints
- [ ] Plan dedicated image-generation worker rollout before high-volume scaling
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
- [x] Webhook opgesplitst in `messengerWebhook.ts` + `webhookHandlers.ts` + `webhookHelpers.ts`
- [x] Deploy to production + webhook connectivity tests
- [x] Text-to-image generation accepts arbitrary visual prompts without defaulting to Storybook Anime
- [x] Image-generation success/failure follow-ups use channel-neutral conversation actions before Messenger rendering

## Historisch afgerond

- [x] Meta webhook/page/token setup
- [x] Messenger webhook handler, quick replies, image uploads
- [x] Preset filter system + style prompts

> Note: Legacy route `/api/webhook/facebook` is deprecated and no longer used.
