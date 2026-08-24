# Leaderbot Mollie launch readiness

Status on 2026-08-24: **NO-GO for a Mollie payment or live billing**.

The credential-free implementation and CI evidence are substantially complete,
but production is still on schema phase `0015_base` and the reviewed image-gen
runtime requires `0016_expand`. The protected bridge, backup/restore rehearsal,
schema expand, runtime deployment, provider sandbox matrix, and human approvals
below must happen in order. A green core `/readyz` is not Mollie readiness while
`MOLLIE_BILLING_PREFLIGHT_ENABLED=false`.

No step in this document authorizes printing a secret, making an unreviewed
provider call, running a payment, applying SQL from a shell, merging a PR, or
deploying outside the protected workflows.

## Credential-free implementation evidence

- The only public launch offer is `startpilot_once_v1`: EUR 19.00 once for 30
  days, one workspace and Page, 300 AI answers, 20 image generations and at
  most five images per day. It has no renewal, direct debit, top-up or overage.
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
- Entitlement admission and durable AI-answer/image reservations are
  workspace-, connection-, binding- and privacy-scoped. The Redis generation
  queue is partitioned and its real integration tests cover erasure and retry
  races.
- Signed customer/operator notification delivery, durable receipt/outbox,
  retries, dedupe and dead-letter readiness exist without requiring a Mollie
  key. Platform admins now have a tenant-scoped, metadata-only incident inbox
  with monotone acknowledgement; receiver dead letters remain a red readiness
  signal until the on-call drill resolves them.
- The accounting importer is GET-only, provider-account/mode scoped, bounded,
  crash-resumable and quarantines ambiguous events. The portal CSV is bounded,
  but it is not the authoritative live fees/settlements report.
- The canonical migration chain and schema contract are tested on MySQL 8.4.11.
  Production intentionally remains on `0015_base`; only the protected
  `0015_base` to `0016_expand` workflow is authorized. Migration 0017 is blocked
  for a later reviewed rollout.
- PR #400 CI at commit `276bab2ac4f1d8396dedb055fa3f26c3c2e7360a`
  passed TypeScript, lint, build, CodeQL, Gitleaks, Fallow, the migration smoke,
  1,902 image-gen tests, real Redis tests and targeted real-MySQL tests. This is
  code evidence, not production migration or Mollie provider evidence.

## Remaining credential-free gates

- [x] Expose materialized operator `manual_review` incidents to an authenticated
      tenant-scoped human surface. The portal shows metadata-only event/reason
      timestamps, ACK is exact workspace/audience bound, and receiver dead
      letters keep `/readyz` red rather than disappearing silently.
- [ ] Complete an operator-facing accounting quarantine/settlement review flow,
      or designate an approved external bookkeeping workflow as the
      authoritative live source for fees, settlements and quarantined events.
- [ ] Keep `docs/operations/todo.md`, this checklist, the billing runbook and
      the test-result matrix aligned with the exact reviewed release.

## Protected production rollout gates

- [ ] Resolve review on PR #400 and land the exact reviewed code on `main`.
- [ ] Build an attested `image-gen-bridge`, record its immutable digest in the
      reviewed production manifest, and deploy it through the protected deploy
      workflow. Every app and worker Machine must run the bridge.
- [ ] Run the protected schema-transition workflow. It must create a fresh
      encrypted snapshot, prove an isolated restore, and apply only
      `0016_expand`. No ad-hoc production SQL and no 0017.
- [ ] Build, attest, review and deploy the `0016_expand` runtime, preserving the
      bridge as the reviewed rollback image.
- [ ] With every commercial/provider flag still off, set only
      `MOLLIE_BILLING_PREFLIGHT_ENABLED=true` and capture a redacted green
      `/readyz` response with `phase: "offline"`. This step makes no Mollie API
      call.

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
- [ ] For live only, configure the dedicated GET-only accounting credential and
      prove Balance/Settlement reconciliation. Test Mode cannot prove this.

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

2. After a green `phase: "offline"` and operator-notification gate, configure an
   isolated Test Mode pilot outside chat. With
   `MOLLIE_BILLING_ENABLED=false`, apply one reviewed operational transition
   that sets `AI_ANSWER_FINALIZATION_DRAIN_ENABLED=true`,
   `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=true`,
   `BILLING_NOTIFICATION_PLANE_ENABLED=true`, the verified quota/gateway
   handshake, the exact pilot scheduler and
   `MOLLIE_BILLING_DRAIN_ENABLED=true`. Do not restart between partial values.
   Wait for operational `/readyz` and every required worker heartbeat before
   setting `MOLLIE_BILLING_ENABLED=true`. Run
   `AI_ANSWER_QUOTA_PREFLIGHT_ENABLED=true` only as its own reviewed, atomic
   preflight phase. The drain flag stays true after the first exposure even
   when commercial billing is later disabled. Keep `MOLLIE_MODE=test` and
   `MOLLIE_LIVE_BILLING_ENABLED=false` throughout the sandbox matrix.
3. Do not install or enable a `live_` credential until every sandbox,
   production, legal, accounting and incident gate is signed off. Live
   activation is a separate explicit human change with rollback evidence.

## Decision rule

- **GO for sandbox:** reviewed `0016_expand` runtime, green offline preflight,
  human-visible operator incidents, and an approved isolated Test Mode pilot.
- **GO for live:** every checkbox above complete, sandbox matrix passed and all
  live accounting/legal/operational approvals recorded.
- **NO-GO:** any schema, entitlement, tenant, cancellation, notification,
  provider, legal, accounting or live-key control remains unproven.

Current decision: **NO-GO**.
