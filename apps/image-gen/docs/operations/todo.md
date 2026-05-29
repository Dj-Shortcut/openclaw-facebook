# Leaderbot Image Generator — Primary Backlog (`todo.md`)

> Dit bestand is de **enige bron van waarheid** voor open werk.  
> Audit-bestanden (`docs/security/AUDIT_REPORT.md`, `docs/security/CODE_AUDIT_REPORT.md`) zijn historisch; open punten daaruit worden hier beheerd.

## Verified snapshot
- Last reviewed against code: **2026-05-03**
- Verified commit: **`9380024`** (met focus op superseded audit items)
- Zie ook: [AUDIT_REPORT_2026_05_03.md](./docs/audit/AUDIT_REPORT_2026_05_03.md)

## Actieve backlog (open)

### Audit & Architectuur (Update 2026-05-03)
- [ ] Centraliseer Redis client management (nu versnipperd over 4+ modules)
- [ ] Maak Face Memory retentie (30 dagen) configureerbaar via ENV
- [ ] Verplaats Admin Rate Limiting van memory naar Redis
- [ ] Consolideer alle operationele logging naar `safeLog` / gestructureerde logger

### Product & bot-ervaring
- [ ] Add seasonal filter rotation
- [ ] Create "upgrade to premium" prompt when limit reached
- [ ] Add image gallery/history for users

### Kosten & quota
- [ ] Implement cost tracking (€0.04 per image)
- [ ] Add €100/month cost cap enforcement
- [ ] Send cost alerts to owner
- [ ] Add external uptime monitor for `/healthz` (e.g. UptimeRobot)

### Opslag & platform
- [ ] Implement image upload from Messenger/OpenAI flow to S3 (instead of local `public/generated`)

### Premium tier (ready but inactive)
- [ ] Design premium tier database schema
- [ ] Implement Stripe payment integration
- [ ] Create premium subscription management
- [ ] Implement premium quota limits (10 images/day)
- [ ] Add premium feature flags (ready to activate)

### Testing & docs
- [ ] Test cost tracking
- [ ] Create setup guide for Meta configuration
- [ ] Document filter options and seasonal updates
- [ ] Provide cost monitoring dashboard
- [ ] Create user-facing bot instructions

## Reeds geverifieerd in code (afgerond)
- [x] OpenAI image generation integration (`gpt-image-1` flow)
- [x] OAuth callback + state validation flow
- [x] Messenger quota checks before transformation
- [x] Database-backed quota tables/helpers (`dailyQuota`) beschikbaar
- [x] Webhook opgesplitst in `messengerWebhook.ts` + `webhookHandlers.ts` + `webhookHelpers.ts`
- [x] Deploy to production + webhook connectivity tests

## Historisch afgerond (samenvatting eerdere fasen)
- [x] Meta webhook/page/token setup
- [x] Messenger webhook handler, quick replies, image uploads
- [x] Preset filter system + style prompts

> Note: Legacy route `/api/webhook/facebook` is deprecated and no longer used.
