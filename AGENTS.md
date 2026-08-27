# AGENTS.md

## Mission

This repository powers one owner-operated commercial Messenger image bot.

The product has one business owner and many Messenger end users. Users receive
a bounded free daily image allowance. When that allowance is exhausted, the bot
may offer a clearly priced, one-time purchase of premium image credits. There
are no subscriptions, automatic renewals, mandates, tenant reselling, or
customer-owned bot workspaces in the target product.

Target flow:

```text
Owner Page
-> Meta webhook
-> apps/image-gen
-> conversation layer
-> free allowance or paid credit wallet
-> image provider
-> Messenger renderer
```

OpenClaw, the root Facebook plugin, the personal Fly gateway, the multi-tenant
customer portal, and recurring Mollie billing are retirement paths. They may
remain temporarily only to support a tested migration or safe decommission.
They must not gain new features or become prerequisites for the active bot.

The only source of truth for open work is `docs/operations/todo.md`.

## Product model

- One commercial owner controls the Page, offer catalog, provider credentials,
  budgets, legal copy, and operations.
- Many end users interact through Messenger and have separate pseudonymous
  conversation, quota, privacy, purchase, and credit state.
- Free credits reset on the configured calendar boundary.
- Purchased credits are a separate durable balance and never disappear during
  the free daily reset.
- A paid offer is a one-time credit bundle with an explicit price, number of
  images, quality level, validity policy, and refund policy.
- Premium quality maps to a server-owned provider policy. Browser input or
  Messenger payloads may select an offer code only; they never set price,
  credits, model, quality, or cost controls.
- Failed, rejected, canceled, or undelivered generations do not consume a user
  credit unless the documented product policy states otherwise and the
  reservation/finalization flow proves it atomically.

## Hard production rules

### User isolation

- Treat every Messenger user as a separate privacy and billing subject.
- Scope state by owner/workspace, channel connection, Page binding, privacy
  epoch, and pseudonymous user key.
- Never use a global credit wallet or raw PSID as a durable storage key.
- Deletion, reconnects, retries, and late jobs must not transfer credits,
  messages, media, or generated outputs between users.
- Retain the internal owner/workspace boundary even while the product exposes
  only one owner. It is a safety partition, not a SaaS feature.

### Privacy

- Never log raw PSIDs, access tokens, payment credentials, prompts, customer
  messages, uploaded photos, generated images, or provider payloads.
- Use pseudonymous identifiers and metadata-only operational signals.
- Keep source media and generated assets on documented retention schedules.
- Preserve `delete-my-data`, export where legally required, and late-output
  suppression after erasure.
- Payment records may outlive conversation content only where accounting or
  legal retention requires it; keep that boundary documented and minimal.

### Messenger compliance

- Preserve webhook verification, raw-body request signature validation, replay
  protection, deduplication, and Page binding validation.
- Send upgrade calls to action only in a user-initiated eligible conversation
  window or another explicitly approved Meta policy path.
- Use a Messenger URL action to open a clear web checkout. Do not collect card
  or banking data in chat.
- Do not add Facebook Login, `user_posts`, `user_friends`, profile scraping,
  or social graph features without explicit product and policy approval.
- Update `docs/operations/meta-app-review.md` when visible Messenger behavior or
  requested permissions change.

### Payments and credits

- The target product accepts one-time Mollie payments only.
- Do not create subscriptions, recurring payments, mandates, silent renewals,
  automatic top-ups, or usage overages.
- Create checkout from a short-lived, single-use, signed handoff bound to the
  exact pseudonymous user, Page binding, privacy epoch, offer, and nonce.
- Never put a raw PSID, message, prompt, photo URL, or secret in a checkout URL
  or Mollie metadata.
- Treat the browser redirect as presentation only. Grant credits only after the
  server verifies payment status through the trusted Mollie flow.
- Payment processing, credit grants, reservations, commits, releases, refunds,
  and adjustments must be idempotent and auditable.
- A Mollie payment ID may fund exactly one immutable credit grant.
- A generation reserves before provider work and commits only on the documented
  success boundary. Provider retries must not double-charge the wallet.
- Preserve global and per-user spend caps even for paid users.
- Live billing stays disabled until legal copy, accounting, webhook handling,
  reconciliation, refund behavior, quota enforcement, and rollback are proven.

### Cost protection

- Image generation is billable. Every path must pass free-quota or paid-credit
  admission plus global provider budget controls.
- Never bypass cost checks in fallbacks, workers, retries, admin actions, or
  inline development modes.
- Keep provider retry counts bounded; a transport retry must not silently start
  another billable generation.
- Model and quality changes require updated unit economics and a rollback.

## Architecture rules

The conversation layer owns:

- intent resolution;
- consent and user-facing responses;
- free-versus-paid admission decisions;
- channel-neutral actions;
- conversation state transitions.

Channel adapters own:

- webhook payload parsing;
- transport and platform APIs;
- rendering text, images, and actions;
- platform delivery failures.

Billing and wallet services own:

- server-side offer catalog;
- checkout intents and payment status;
- immutable grants and adjustments;
- credit reservation, commit, and release;
- metadata-only reconciliation.

Preferred response shape:

```ts
{
  text?: string;
  images?: ImageOutput[];
  actions?: ConversationAction[];
}
```

Do not place Messenger quick-reply payloads, Mollie checkout details, or raw
provider responses inside conversation-domain logic.

## Product experience

The primary journey is prompt-first:

```text
prompt -> image -> result -> next action
```

Source-photo editing may be offered through natural-language instructions.
Do not restore style catalogs or large preset menus.

When free credits are exhausted, the response must remain useful and honest:

- state when free access returns;
- state the exact one-time price and premium credit quantity;
- state that there is no subscription or automatic renewal;
- offer a checkout action and a no-purchase alternative;
- do not create a payment until the user explicitly confirms on the checkout
  page.

## Transitional code

The following are legacy until removed with proof:

- root `src/` OpenClaw Facebook plugin;
- `deploy/fly-gateway` and root `fly.toml`;
- Leaderbot bridge and OpenClaw release tooling;
- `apps/customer-app` multi-tenant portal;
- workspace provisioning for external bot owners;
- Mollie subscriptions, mandates, renewal workers, and recurring UI;
- Startpilot workspace entitlements.

Do not delete a live path merely because it is legacy. Removal requires:

1. replacement behavior exists;
2. targeted tests pass;
3. production traffic is proven absent or migrated;
4. rollback and required data retention are understood;
5. documentation and workflows are updated in the same change.

Do not add abstraction layers to make legacy code more comfortable. Prefer
small extraction, migration, and deletion steps.

## Current priorities

1. Establish the direct owner-operated Messenger runtime and retire OpenClaw
   ingress safely.
2. Add a user-scoped purchased-credit ledger beside the free daily quota.
3. Add the quota-exhaustion call to action and signed one-time Mollie checkout.
4. Prove premium quality, atomic consumption, refunds, deletion, budgets, and
   delivery end to end in test mode.
5. Run a bounded live pilot, then remove subscriptions, tenant portal code, and
   remaining OpenClaw artifacts.

Do not start a later priority while an earlier one is blocked on an executable
test, configuration decision, or production proof.

## High-risk areas

Messenger ingress and delivery:

- `messengerWebhook.ts`
- `webhookHandlers.ts`
- `webhookGenerationJobs.ts`
- `messengerGenerationQueue.ts`

Privacy and identity:

- `conversationSubject.ts`
- `messengerPrivacySubject.ts`
- `consentService.ts`
- `dataDeletionService.ts`
- `faceMemory.ts`

Quota, payments, and cost:

- `messengerImageQuotaStore.ts`
- `generationGuard.ts`
- `costLedger.ts`
- `server/_core/billing/*`
- Mollie webhook and reconciliation paths

Changes here require targeted tests and explicit failure-path verification.

## Documentation rules

- `README.md` explains the product and repository.
- `docs/architecture.md` defines current and target boundaries.
- `docs/operations/todo.md` is the only active backlog.
- Runbooks describe executable operations, not product aspirations.
- Delete stale plans instead of labeling them historical.
- A document that describes removed behavior must be removed in the same change,
  unless it is a temporary decommission runbook with an explicit removal gate.
- Never claim a target feature is live before its code and production evidence
  exist.

## Change discipline

Before making a change, answer:

1. Which current production outcome does it close?
2. Is state scoped to the exact Messenger user and Page binding?
3. Can it grant credits, start provider work, or send a commercial message?
4. What happens on retries, duplicate webhooks, deletion, refund, and timeout?
5. What is the smallest rollback-safe implementation?

Avoid drive-by refactors. Preserve unrelated user changes in the worktree.

## Testing

Minimum TypeScript check:

```bash
pnpm --dir apps/image-gen check
```

Run targeted tests for every modified area. Run the broader image-gen suite
when changing conversation flow, webhook processing, identity, quota, wallet,
payments, image generation, or delivery:

```bash
pnpm --dir apps/image-gen test
```

For production-affecting changes, also validate the immutable build, current
schema contract, readiness checks, smoke journey, and rollback path documented
in `docs/operations/production-deployments.md`.
