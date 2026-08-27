# Leaderbot production outcomes

This is the only source of truth for open product and production work.

Last reset: **2026-08-27**.

## Product decision

```text
One owner-operated Facebook Page
-> direct Meta webhook
-> apps/image-gen
-> many isolated Messenger users
-> free daily images
-> optional one-time premium credit bundles
```

The target product has:

- one commercial owner;
- many end users with separate pseudonymous state;
- no OpenClaw dependency;
- no external tenant/workspace provisioning;
- no subscription, mandate, automatic renewal, automatic top-up, or overage;
- one-time Mollie checkout only;
- purchased credits separate from the resetting free allowance;
- premium quality selected by a server-owned offer policy.

## Active order

- [ ] **P1 - Direct owner bot and OpenClaw retirement proof.** Point the owner
      Page at the direct `apps/image-gen` Messenger callback using the intended
      Meta app and credentials. Prove verification, signatures, text, consent,
      image generation, edits, quota, deletion, queue, delivery, monitoring,
      and rollback without OpenClaw. Record zero OpenClaw traffic before
      disabling its callback and gateway. Preserve or delete legacy volume data
      under an explicit privacy/retention decision.

- [ ] **P2 - User-scoped purchased-credit ledger.** Add an append-only credit
      ledger, wallet projection, and idempotent reservation/commit/release model
      bound to the exact conversation subject and privacy epoch. Keep free daily
      quota separate. Prove duplicate events, concurrency, crashes, deletion,
      Page rebinding, refund adjustments, and insufficient balance.

- [ ] **P3 - Quota-exhaustion CTA and one-time checkout.** Return a
      channel-neutral upgrade action when free credits are exhausted. Open a
      short-lived single-use checkout handoff bound to user, Page, privacy
      epoch, offer, and nonce. Show exact price, credit count, quality, validity,
      no-subscription disclosure, and no-purchase alternative. Grant once only
      after trusted Mollie payment verification; never from the browser return.

- [ ] **P4 - Premium quality and Test Mode journey.** Bind the paid offer to a
      versioned premium provider policy and prove unit economics. In Mollie Test
      Mode, pass paid checkout, delayed/replayed webhook, cancellation, failure,
      refund, partially used wallet, provider failure, delivery failure,
      deletion, budget exhaustion, receipt, reconciliation, and rollback.

- [ ] **P5 - Bounded live pilot and legacy removal.** Obtain legal/accounting
      approval, enable one reviewed live offer for a bounded audience, monitor
      conversion, cost, failures, and support without content access, and prove
      rollback. Then remove OpenClaw, ClawHub/release tooling, the gateway,
      customer portal, subscriptions, mandates, recurring workers, tenant
      provisioning, and stale secrets/workflows/docs.

Current release blocker: the 2026-08-27 storage-proxy promotion failed during
startup because lifecycle inspection ran before the server was ready. Fly
restored the previous healthy image and `/healthz` returned 200. No new deploy
may start until the initialization-order fix, recovery workflow, production
validator, readiness proof, and rollback proof are green together.

## Current product hypothesis

Initial experiment, subject to owner sign-off and unit-economics proof:

- free allowance: a small daily number of standard images;
- exhaustion message: exact reset time plus optional purchase;
- candidate offer: a small one-time premium bundle, likely priced above EUR 1
  because fixed payment fees make a EUR 1 purchase inefficient;
- successful usable outputs consume credits; failures do not;
- purchased credits do not reset with the daily free allowance;
- no automatic follow-up outside Meta's allowed messaging window.

The exact price, quantity, quality, expiry, and refund handling are product
decisions. They must live in the server-owned offer catalog and checkout copy,
not in client input or this backlog.

## Definition of done

The new product is proven when a real Messenger user can:

1. use the free daily allowance;
2. reach exhaustion without another provider call;
3. see an honest one-time premium offer;
4. decline and continue safely;
5. pay through Mollie without exposing their Messenger identity;
6. receive exactly one credit grant after verified payment;
7. generate the promised premium images with atomic balance updates;
8. survive retries, failures, refund, deletion, and rollback without a double
   charge, double grant, lost paid balance, or privacy leak.

Production must run without OpenClaw, subscription workers, tenant portal
administration, or undocumented manual steps.

## Work rules

- Only one production outcome is active at a time: P1 through P5.
- A PR counts as progress only when it makes an acceptance point executable or
  closes it with evidence.
- Do not create additional roadmap, readiness, foundation, or follow-up
  documents. Add necessary work to the current outcome.
- Local tests are not production proof.
- Store only metadata-only smoke evidence: commit/digest, opaque request id,
  bounded outcomes, counts, timings, and rollback identity.
- Never store PSIDs, messages, prompts, media, generated images, tokens,
  checkout handoffs, or payment credentials as evidence.

## Supporting runbooks

- Architecture: `docs/architecture.md`
- Messenger setup: `docs/setup.md`
- Production smoke: `docs/production-readiness.md`
- Payment launch gates: `docs/LAUNCH_READINESS.md`
- Billing operations: `docs/BILLING_RUNBOOK.md`
- Meta review: `docs/operations/meta-app-review.md`
- Deployment and rollback: `docs/operations/production-deployments.md`
- Security: `docs/security/SECURITY.md`
