# Leaderbot Image Generator - Primary Backlog (`todo.md`)

> Dit bestand is de enige bron van waarheid voor open werk.
> Historische audit- en refactorrapporten zijn verwijderd of samengevat; open punten staan hier.

## Verified snapshot

- Last reviewed against code: **2026-05-30**
- Verified commit: **`158365d`** plus the follow-up documentation cleanup
- Current direction: generic prompt-first image generation; legacy style flows are compatibility only.

## Actieve backlog (open)

### Architectuur

- [ ] Centraliseer Redis client management
- [ ] Maak Face Memory retentie configureerbaar via ENV
- [ ] Verplaats Admin Rate Limiting van memory naar Redis
- [ ] Consolideer operationele logging naar `safeLog` / gestructureerde logger

### Product & bot-ervaring

- [ ] Observe generic text-to-image quality before removing legacy style-picker flows
- [ ] Migrate remaining Messenger state quick replies to channel-neutral conversation actions
- [ ] Decide which style-catalog compatibility flows can be removed after real Messenger tests
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
