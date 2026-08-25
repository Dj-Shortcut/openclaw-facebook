# Leaderbot Mollie launch readiness

Status on 2026-08-25: **NO-GO for a Mollie payment or live billing**.

The protected schema transition, reviewed image-gen runtime deployment,
provider-silent offline preflight and idempotent workspace-wide paid image
counter are complete. Production `/readyz` is green with `phase: "offline"`.
The remaining rollout must prove the operational worker state for one exact
pilot workspace and then run the provider sandbox matrix. OpenClaw remains a
planned later product step, but is not a dependency of the image-generation
offer or the first Mollie sandbox payment.

No step in this document authorizes printing a secret, making an unreviewed
provider call, running a payment, applying SQL from a shell, merging a PR, or
deploying outside the protected workflows.

## Credential-free implementation evidence

- The only public launch offer is `startpilot_once_v1`: EUR 19.00 once for 30
  days, one workspace and Page, guided Messenger image controls, 20 image
  generations and at most five images per day. It has no renewal, direct debit,
  top-up or overage. Dormant AI-answer fields are not advertised or required.
- Checkout is server-owned, EUR-only, Belgium-only and B2C-only. Eligibility is
  based on an audited, expiring Belgian-consumer profile. The seller's Peppol
  registration is an accounting identity and never makes a buyer a business
  customer. Business/Peppol buyer profiles remain ineligible.
- Hosted Checkout redirects are never payment proof. The classic Mollie webhook
  fetches the Payment from Mollie and validates the exact mode, tenant,
  customer, intent metadata, amount and currency before any entitlement change.
- Durable provider-operation states, execution epochs, exact cancellation
  targets, idempotency fingerprints, response-loss reconciliation and
  safety-drain jobs contain checkout/revoke/disable races.
- The tenant scheduler separates commercial execution from the always-available
  safety outbox. Disabled commercial billing cannot expose a new checkout URL,
  while exact cancellations and metadata-only review notifications can drain.
- Paid image admission is workspace-, entitlement-, Page-connection- and
  binding-scoped. One durable idempotent receipt is written before the first
  provider attempt, so provider retries cannot double count and different
  Messenger users share the same 20/5 workspace allowance. The Redis queue
  remains partitioned and privacy-fenced.
- Signed customer/operator notification delivery, durable receipt/outbox,
  retries, dedupe and dead-letter readiness exist without requiring a Mollie
  key. Platform admins now have a tenant-scoped, metadata-only incident inbox
  with monotone acknowledgement; receiver dead letters remain a red readiness
  signal until the on-call drill resolves them.
- The built-in accounting importer is GET-only, provider-account/mode scoped,
  bounded, crash-resumable and quarantines ambiguous events. It is intentionally
  disabled for the pilot because its durable cursor is not yet bound to one
  exact Mollie Balance. Accountable is the intended external bookkeeping
  workflow; its live reconciliation and human approval remain external gates.
- The canonical migration chain and schema contract are tested on MySQL 8.4.11.
  Production completed the protected `0015_base` to `0016_expand` transition
  and runs the reviewed `0016_expand` runtime. Migration 0017 remains blocked
  for a later reviewed rollout.
- PR #400 credential-free code evidence is frozen at commit
  `ee59b09cbbaec76ebacf6eb8faa36ca3a94122bb`. Image Gen CI
  [run 32740281414](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32740281414)
  passed TypeScript, release lint/format, production build, 184 test files and
  1,993 tests; 17 files and 98 tests were intentionally skipped in the ordinary
  pass. Its real Redis suites and 31/31 targeted MySQL 8.4.11 tests also passed
  after the disposable test database verified `0017_contract`. The canonical
  migration smoke
  [run 32740281430](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32740281430)
  passed as well. CodeQL, Gitleaks, Fallow, package validation, artifact dry-run
  and uptime/dependency checks were green. This is code evidence, not a
  production migration or Mollie provider result.

## Remaining credential-free gates

- [x] Expose materialized operator `manual_review` incidents to an authenticated
      tenant-scoped human surface. The portal shows metadata-only event/reason
      timestamps, ACK is exact workspace/audience bound, and receiver dead
      letters keep `/readyz` red rather than disappearing silently.
- [x] Keep the non-balance-scoped built-in accounting importer disabled and
      designate Accountable as the intended external bookkeeping workflow for
      the pilot. This code decision does not mark the external reconciliation
      or accounting approval complete.
- [x] Keep `docs/operations/todo.md`, this checklist, the billing runbook and
      the test-result matrix aligned with the exact reviewed release. They now
      share the credential-free `ee59b09` evidence boundary, while every
      production/provider/human gate remains explicitly open.

## Protected production rollout gates

- [x] Resolve review on PR #400 and land the exact reviewed code on `main`.
- [x] Build an attested `image-gen-bridge`, record its immutable digest in the
      reviewed production manifest, and deploy it through the protected deploy
      workflow. Every app and worker Machine must run the bridge.
- [x] Run the protected schema-transition workflow. It must create a fresh
      encrypted snapshot, prove an isolated restore, and apply only
      `0016_expand`. No ad-hoc production SQL and no 0017.
- [x] Build, attest, review and deploy the `0016_expand` runtime, preserving the
      bridge as the reviewed rollback image.
- [x] With every commercial/provider flag still off, set only
      `MOLLIE_BILLING_PREFLIGHT_ENABLED=true` and capture a redacted green
      `/readyz` response with `phase: "offline"`. Protected deploy
      [run 32820475232](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32820475232)
      recorded that evidence without a Mollie API call.
- [x] Review, merge and deploy the focused image-only offer and paid
      workspace-quota batch. PR #417 and protected deploy
      [run 32860967800](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32860967800)
      shipped exact runtime digest `sha256:01ccf154e0ac4c314f68775a0fd00fe925aaba92fee997a32f932c8d4c36d806`;
      its real MySQL race proves exactly one winner for the last slot and one
      receipt for a replayed request.

## External provider and human gates

- [ ] Confirm Bancontact is available in the Mollie Test profile.
- [ ] Run every sandbox scenario in `MOLLIE_TEST_RESULTS.md` with approved test
      data and a `test_` credential injected outside chat. Preserve only
      metadata-only evidence; do not expose the key or customer data.
- [ ] Run the paid image-provider smoke and confirm the provider-account hard
      limit separately from Leaderbot's customer quotas.
- [ ] Approve Belgian B2C terms, withdrawal/refund handling, privacy wording,
      small-enterprise VAT-exemption wording, proof/invoice numbering and
      financial retention with qualified legal/accounting review.
- [ ] Name the billing/on-call operators and complete the notification,
      cancellation, duplicate-charge and incident drills.
- [ ] Before live, reconcile Mollie fees, Balances and Settlements in the
      approved Accountable workflow and record human sign-off. If the built-in
      importer is chosen instead, first bind its runs/cursors/events/readiness
      to the exact Balance ID and then use a dedicated GET-only credential.
      Test Mode cannot prove live settlement reconciliation.

## Required flag sequence

1. During bridge, migration, runtime rollout and offline preflight, keep:

   ```text
   MOLLIE_MODE=test
   MOLLIE_BILLING_ENABLED=false
   MOLLIE_BILLING_DRAIN_ENABLED=false
   MOLLIE_LIVE_BILLING_ENABLED=false
   MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=false
   AI_ANSWER_FINALIZATION_DRAIN_ENABLED=false
   AI_ANSWER_QUOTA_PREFLIGHT_ENABLED=false
   LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=false
   BILLING_NOTIFICATION_PLANE_ENABLED=false
   MOLLIE_ACCOUNTING_IMPORT_ENABLED=false
   ```

2. After a green `phase: "offline"` and operator-notification gate, deploy the
   provider-safe first operational phase with
   `MOLLIE_BILLING_DRAIN_ENABLED=true` and
   `BILLING_NOTIFICATION_PLANE_ENABLED=true`. Keep
   `MOLLIE_BILLING_ENABLED=false`,
   `AI_ANSWER_FINALIZATION_DRAIN_ENABLED=false` and
   `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=false`. A commercially disabled
   tenant intentionally has only its safety outbox lane enabled, so requiring
   the finalization lane before the audited scheduler transition makes startup
   fail closed.
3. With that safety phase green, configure the exact isolated Test Mode pilot
   outside chat and perform the audited scheduler-enable transition. Keep
   `MOLLIE_BILLING_ENABLED=false`, so the database transition cannot expose a
   checkout URL or create a provider resource.
4. In a separate reviewed config deployment, set
   `AI_ANSWER_FINALIZATION_DRAIN_ENABLED=true` and
   `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=true`. Wait for operational
   `/readyz` and every required worker heartbeat before setting
   `MOLLIE_BILLING_ENABLED=true`. Keep
   `AI_ANSWER_QUOTA_PREFLIGHT_ENABLED=false` and
   `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=false` for the image-only pilot.
   The drain flag stays true after the first exposure even
   when commercial billing is later disabled. Keep `MOLLIE_MODE=test` and
   `MOLLIE_LIVE_BILLING_ENABLED=false` throughout the sandbox matrix.
5. Do not install or enable a `live_` credential until every sandbox,
   production, legal, accounting and incident gate is signed off. Live
   activation is a separate explicit human change with rollback evidence.

## Decision rule

- **GO for sandbox:** reviewed/deployed paid image counter, green operational
  readiness, human-visible operator incidents, and one approved isolated Test
  Mode pilot workspace.
- **GO for live:** every checkbox above complete, sandbox matrix passed and all
  live accounting/legal/operational approvals recorded.
- **NO-GO:** any schema, entitlement, tenant, cancellation, notification,
  provider, legal, accounting or live-key control remains unproven.

Current decision: **NO-GO**.

After the sandbox matrix, legal/accounting approvals and one limited live
payment, resume the separate OpenClaw gateway state/rollback rollout. It remains
an explicit final step of the intended end product, not a prerequisite for
selling image generation safely.
