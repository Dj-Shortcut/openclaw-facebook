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
- no OpenClaw runtime dependency;
- no external tenant/workspace provisioning;
- no subscription, mandate, automatic renewal, automatic top-up, or overage;
- one-time Mollie checkout only;
- purchased credits separate from the resetting free allowance;
- premium quality selected by a server-owned offer policy.

The reusable OpenClaw Facebook channel remains a separate open-source product.
It will move out of this repository after its standalone package, channel-index,
ClawHub, install, release, and rollback routes are proven.

## Active order

- [ ] **P1 - Direct owner bot and OpenClaw retirement proof.** Point the owner
      Page at the direct `apps/image-gen` Messenger callback using the intended
      Meta app and credentials. Prove verification, signatures, text, consent,
      image generation, edits, quota, deletion, queue, delivery, monitoring,
      and rollback without OpenClaw. Record zero gateway traffic before
      disabling its callback and infrastructure. Preserve or delete legacy
      volume data under an explicit privacy/retention decision. Extract the
      generic OpenClaw channel to its standalone project before removing the
      root package and ClawHub workflows from this repository.

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
      rollback. Then remove the in-repo OpenClaw copy and gateway, customer
      portal, subscriptions, mandates, recurring workers, tenant provisioning,
      and stale secrets/workflows/docs.

## Current P1 gate

- Storage-proxy startup ordering was fixed and merged in PR #445 at reviewed
  source commit `6a7d0431e1e02076a2db7fcf12c8358d7fbf33cd`.
- CI boundaries were separated and merged in PR #447 at main commit
  `6c94be30ecc0fc8723f726c59e23b0cf88afacc9`.
- Production uptime was rechecked on 2026-08-27: image-gen, storage proxy, and
  legacy gateway health/readiness checks passed after one transient network
  failure from a GitHub runner.
- Build run `33092823815` produced and attested immutable storage-proxy digest
  `sha256:99ea65710abb9a2294dcaf02cf76f57b240cb153a69e6020b68a470278103a8d`
  from exact reviewed source `6a7d0431e1e02076a2db7fcf12c8358d7fbf33cd`;
  GitHub provenance attestation `43467733` is the trusted build record.
- Protected deploy run `33101076132` proved artifact and source provenance but
  the candidate refused startup before binding its port. The existing
  metadata-only log could not distinguish Redis connection, Redis readiness,
  app construction, the R2 lifecycle preflight, or server binding.
  `R2_ACCOUNT_ID` was absent by design because the deployed `R2_ENDPOINT`
  alternative was present; do not
  treat that presence flag as the cause. The workflow restored reviewed legacy
  digest `sha256:334f78b92816a92e302a66c4d08742c28361a718b190227d3dbf7b933350cc28`,
  verified its captured configuration, and public `/healthz` returned `200`.
- PR #451 merged bounded, metadata-only startup-stage diagnostics at source
  `1da8da74f301fb368563cd094912e159d3bf6998`. Build run `33104393266`,
  attempt 2, produced runtime digest
  `sha256:a6bb22fcdbdfa6cc211afabfae86cc2423f501e589113f2f0a7e32db0f22083d`
  and GitHub provenance attestation `43482590`. The initial attempt stopped
  before building because exact-source main CI was still running; attempt 2
  started only after that CI passed.
- The manifest now records only that new diagnostics artifact as
  `runtime_reviewed`, keeps the healthy legacy digest as the sole rollback, and
  leaves the failed `99ea...` digest undispatchable.
- Next: deploy the exact `a6bb...` digest through the protected workflow, use
  the safe startup phase code if it fails, and prove health, shared-Redis
  readiness and rollback before recording `runtime_deployed`.
- No direct Page callback or legacy gateway is disabled before that production
  proof and its rollback identity exist.

## Current product hypothesis

Initial experiment, subject to owner sign-off and unit-economics proof:

- free allowance: a small daily number of standard images;
- exhaustion message: exact reset time plus optional purchase;
- candidate offer: a small one-time premium bundle, likely priced above EUR 1
  because fixed payment fees make a EUR 1 purchase inefficient;
- successful usable outputs consume credits; failures do not;
- purchased credits do not reset with the daily free allowance;
- no automatic follow-up outside Meta's allowed messaging window.

Exact price, quantity, quality, expiry, and refund handling are product
decisions. They live in the server-owned offer catalog and checkout copy, not
in browser input or this backlog.

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

Production runs without OpenClaw, subscription workers, tenant portal
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
