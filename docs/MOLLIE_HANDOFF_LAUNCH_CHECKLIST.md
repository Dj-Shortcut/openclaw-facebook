# Mollie + Messenger handoff launch checklist

Status on 2026-08-18: **repository gate PASS; sandbox/live launch NO-GO**.

This checklist covers Luna PR #374, Terra PR #373 at
`9bf6234fa61e630f1825aa2ce3cec34cd8f88278`, and the current Sol draft branch.
The exact reviewed Sol head is recorded in PR #375 and its checks. PR #376, the
identity-v2 WIP branch and `e378bff` are not inputs.

The protected chain is:

`Messenger inbound -> Page-bound handoff -> portal claim -> membership ->`
`checkout -> provider snapshot -> ledger/entitlement -> billing outbox ->`
`Page-scoped delivery or same-paid-row recovery`

No failure may reopen payment truth, create a second charge, cross a workspace
or resurrect erased content.

## 1. Preparation

- [ ] Keep `MOLLIE_BILLING_ENABLED=false`,
      `MOLLIE_LIVE_BILLING_ENABLED=false` and `MOLLIE_MODE=test`.
- [ ] Keep commercial execution disabled for every workspace/mode. Confirm the
      provider-key-free safety/notification drain remains healthy.
- [ ] Name owners for database, Fly, billing, Meta, notification receiver,
      monitoring, accounting, privacy/legal and incident response.
- [ ] Take and verify a database backup. Rehearse the gateway Memory Core repair
      on a cloned volume before changing the gateway runtime/volume.
- [ ] Confirm no legacy/raw Messenger ingress/generation queue payload remains;
      readiness must fail instead of draining it into the paid path.

## 2. Migration order and recovery

- [ ] Use only `pnpm --dir apps/image-gen run db:migrate:production`; do not run
      raw `drizzle-kit migrate` in production.
- [ ] The supported upgrade is exact committed `0014` to final `0015`. The
      runner verifies MySQL 8.4.11 creation inputs, migration singleton lock,
      journal/SQL/snapshot/contract hashes, exact before-state, orphan/counter/scope
      preflights and exact after-state.
- [ ] Pause mutating app/worker processes before the runner and retain its
      metadata-only manifest result.
- [ ] If preflight or partial-state detection fails, make no further DDL change.
      Restore the disposable rehearsal from backup, repair the reported invariant,
      and rerun the full preflight.
- [ ] Rollback is application/exposure first: disable commercial/live billing,
      stop commercial workers, preserve financial/outbox/audit rows and use the
      always-on safety drain. Prefer a forward fix. Restore a verified backup only
      under the approved incident procedure; do not blindly reverse `0015` DDL.

## 3. Fly and credential-free configuration

- [ ] App and worker use the exact same release image, MySQL, Redis, identity,
      privacy, scheduler and notification configuration.
- [ ] `/healthz` is liveness. Deployment traffic/launch decisions use
      `/readyz`; do not turn a readiness failure into a restart loop.
- [ ] Set HTTPS origin-only `APP_BASE_URL` and `PORTAL_BASE_URL`, plus exact
      `MOLLIE_PAYMENT_WEBHOOK_URL` ending in
      `/api/webhooks/mollie/payments` with no query or fragment.
- [ ] Set explicit `MOLLIE_BILLING_SCHEDULER_MODE=pilot_pin|multi_tenant`.
      Pilot mode requires `MOLLIE_BILLING_WORKER_WORKSPACE_ID`; multi-tenant mode
      requires it unset.
- [ ] Set positive daily/monthly/user spend caps, daily image cap and a
      conservative `OPENAI_IMAGE_ESTIMATED_COST_USD`.
- [ ] Run the credential-free chain with
      `MOLLIE_BILLING_PREFLIGHT_ENABLED=true`, full schema installed,
      entitlement/finalization drain and notification plane enabled, while
      checkout and live billing remain off.

Required secret names, never values:

- Core: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PRIVACY_PEPPER`,
  `CONVERSATION_SCOPE_HMAC_SECRET`, `MESSENGER_GENERATION_PARTITION_SECRET`,
  `PORTAL_HANDOFF_TOKEN_SECRET`, `BILLING_PROFILE_EVIDENCE_HMAC_SECRET`.
- Meta/OpenAI: Page credential encryption material and existing
  `FB_APP_SECRET`, `FB_VERIFY_TOKEN`, `OPENAI_API_KEY`,
  `INTERNAL_IMAGE_REQUEST_TOKEN`/gateway bridge secret.
- Mollie: `MOLLIE_API_KEY`; accounting uses the distinct read-only
  `MOLLIE_ACCOUNTING_ACCESS_TOKEN`, never the payment key.
- Notifications: customer/operator destination URLs, key IDs, distinct signing
  secrets, source IDs, receiver public origin, allowlist and receiver ACK names
  exactly as listed in `apps/image-gen/.env.example`.

Secrets are installed only through the deployment secret store. Never place a
value in source, chat, logs, tickets, screenshots, PRs or support notes.

## 4. Test Mode procedure

- [ ] An authorized human injects only a `test_` Mollie key out of band and an
      isolated Facebook Test Page/User credential set. The agent does not read it.
- [ ] Verify `/readyz`, Bancontact, exact webhook routing, workers/heartbeats,
      Redis, spend caps, finalization, notifications, accounting disabled/readiness
      state and metadata-only monitoring before checkout exposure.
- [ ] Attest the isolated workspace billing profile through the authenticated
      admin flow with evidence hash, expiry and expected version. Do not use SQL or
      customer self-attestation.
- [ ] Enable the pilot execution control and commercial test lanes only for the
      isolated workspace after every preflight passes.
- [ ] Run every `NOT RUN` row in `docs/MOLLIE_TEST_RESULTS.md`: paid, terminal,
      duplicate/delayed, repeated checkout, mismatch, refund/chargeback,
      reconciliation and disable-after-transport.
- [ ] Run Facebook Page/user matrix: happy handoff, two-user claim race, wrong
      user/Page/workspace, disconnect/rebind, closed response window, transient
      Graph failure, deletion race and same-paid-row recovery.
- [ ] Run one controlled OpenAI image generation and edit with non-customer test
      data. Prove admission occurs before the provider and configured caps/estimate
      are visible in metadata-only ledger/monitoring.
- [ ] Capture dated redacted evidence: intent/provider operation, one ledger
      effect, entitlement, outbox/delivery identity, claim/membership, recovery and
      zero duplicate charge. Never capture provider secrets or customer content.

## 5. Webhook, worker and monitoring checks

- [ ] Public route admits only exact POST Mollie webhook; reject GET,
      trailing-slash, singular and lookalike routes.
- [ ] Scheduler process heartbeats are current for required lanes; disabled
      commercial tenants expose only the safety outbox lane at the same execution
      epoch. No overdue backlog or dead letter may be hidden by cached counters.
- [ ] Signed notification receiver proves source/audience/key mapping,
      idempotency/digest conflict, replay window, customer effect and non-recursive
      operator escalation.
- [ ] Alert on webhook retries/rate limits, provider ambiguous/reconciliation
      states, outbox failures/age, scheduler lease loss, quota reservation/finalize
      age, notification dead letters, accounting quarantine, privacy erasure and
      paid-without-entitlement/delivery.
- [ ] Logs and alerts contain only workspace-scoped metadata/hashes: never PSID,
      Page token, handoff URL/token, prompt, source/output media or provider secret.

## 6. Paid-user recovery

- [ ] Verify provider payment and local entitlement without changing either.
- [ ] Correct Page connectivity/binding if required. Ask the same customer to
      send a fresh verified normal message to the same Page.
- [ ] Confirm one replay-protected inbound event rearms only the exact failed
      delivery row, rotates the capability generation, keeps older URLs invalid and
      creates no checkout/payment.
- [ ] Privacy/consent/delete/system events never open the paid delivery window.
      Shared-admin manual re-drive remains fail-closed; escalate instead of
      bypassing tenant/user/Page ownership.

## 7. Human-only live switch

Only after sandbox evidence and written operational/legal/accounting approval:

1. Take a final backup and open an authorized launch/rollback window.
2. A human injects the `live_` key out of band while exposure remains off.
3. Set `MOLLIE_MODE=live`; rerun `/readyz`, methods, webhook, notification,
   scheduler, safety drain, Page, quota, finalization and monitoring checks.
4. Enable entitlement/AI enforcement, the approved workspace execution control,
   billing exposure and finally `MOLLIE_LIVE_BILLING_ENABLED` in that order.
5. A human performs one controlled real Startpilot payment.
6. Verify one authenticated snapshot, ledger effect, entitlement, outbox,
   Page delivery, claim and membership; verify redacted observability and no
   duplicate provider operation/charge.
7. On any mismatch, disable commercial/live exposure immediately, preserve
   records and let exact safety containment run. Never recover by charging again.

Current stop point: after repository/CI verification and before test credential
injection.
