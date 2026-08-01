# Leaderbot Mollie Launch Readiness

Status on 2026-08-01: **NO-GO** for live billing.

The code path is intentionally fail-closed. `MOLLIE_MODE=test` is the only
approved mode until the checklist below is complete. No deployment, live key,
commit, push, refund, payout, or settlement movement is authorized by this
document.

## Implemented locally

- Server-side public `startpilot_once_v1` catalog; browser input selects only a
  plan code. The dormant monthly catalog entry is not publicly available.
- Startpilot contract: `EUR 19.00` once for 30 days, one workspace and Facebook
  Page, 300 AI answers, 20 Images 2.0 generations, at most five images per day,
  no subscription, renewal, direct debit, automatic top-up, or overage.
- EUR-only, Belgium-only, B2C-only checkout contract.
- A default-off `MOLLIE_BILLING_ENABLED` master switch prevents paid-plan
  exposure, checkout, Mollie routes, workers, and reconciliation during the
  interest-only phase. A separate default-off
  `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED` switch prevents the new database
  runtime from activating before migration; checkout refuses to start until
  enforcement is enabled. The gateway's independent default-off
  `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED` preflight must also be enabled and
  verified before checkout; while off, ordinary free OpenClaw chat does not
  depend on image-gen. Once customers have paid, both enforcement paths stay
  on even if billing is paused. Explicit key/mode validation, production HTTPS
  enforcement, and the separate `MOLLIE_LIVE_BILLING_ENABLED=false` live kill
  switch remain in place.
- Mollie Customer, one-time Bancontact payment, Hosted Checkout,
  opaque intent metadata, and deterministic idempotency keys.
- Exact classic webhook route: `POST /api/webhooks/mollie/payments` with a 2 KB
  form parser. It reads `id`, fetches the Payment from Mollie, and does not
  implement a fictitious signature check.
- MySQL billing intent, customer, subscription, ledger, delivery,
  entitlement, outbox, reconciliation-run and anomaly records with duplicate
  constraints, workspace foreign keys, Test/Live isolation, and migration
  artifacts through `0010`. GitHub CI run `30713688838` applied the pre-guard
  revision of the cumulative migration chain through `0010` to a fresh MySQL
  8.4 database. The current fail-fast duplicate-claim guard still requires a
  fresh CI rerun. The upgrade path from an existing production-like schema and
  production execution of `0010` remain **NOT RUN / NO-GO**; see
  `MOLLIE_TEST_RESULTS.md`.
- One-time entitlement activation only after an authenticated Mollie API fetch
  confirms payment. The unused subscription foundation retains bounded mandate
  polling, cancellation, grace, refund/chargeback review, and reconciliation,
  but is not exposed as a launch offer.
- Exact-target cancellation recovery, ambiguous-create containment, stale-lease
  fencing, terminal-state guards, and a seven-day/in-flight collection guard
  for payment-method replacement.
- Tenant-scoped billing summary, payment proof, and CSV accounting export.
- A tenant-bound worker configuration that refuses checkout for any other
  workspace instead of performing cross-tenant job scans.
- Public gateway tests prove that only the exact POST Mollie webhook path is
  admitted; GET, trailing-slash, singular, and lookalike paths are rejected.

## Open blockers

- [x] Product owner selected the bounded `EUR 19.00` one-time Startpilot offer
  encoded in `apps/image-gen/server/_core/billing/catalog.ts`.
- [ ] A verified billing-country/customer-profile control replaces reliance on
  the fixed BE checkout contract so Belgium-only eligibility cannot be faked by
  a client.
- [ ] A real Mollie Test profile proves Bancontact is enabled for the one-time
  Startpilot checkout. SEPA Direct Debit remains deferred with the unpublished
  subscription offer.
- [ ] Every scenario in `MOLLIE_TEST_RESULTS.md` is run with a `test_` key and
  evidence is recorded without customer data or secrets.
- [ ] MySQL integration tests prove transaction rollback, unique constraints,
  checkout races, duplicate webhooks, outbox leases, and subscription races.
- [ ] AI-answer finalization is durable or conservatively resolved after a
  successful Messenger delivery. The current single best-effort finalize call
  can undercount repeatedly during an extended gateway-to-image-gen outage and
  therefore must not be enabled for paid customers yet.
- [ ] Paid Images 2.0 is smoke-tested through the explicit GPT Image 2 Image
  API path, and `OPENAI_IMAGE_ESTIMATED_COST_USD` conservatively covers output,
  prompt, and high-fidelity source-image input until actual provider usage is
  reconciled into the cost ledger.
- [ ] USD spend-cap admission is atomically reserved across concurrent workers.
  The current summary-check followed by ledger append can admit simultaneous
  attempts past a configured cap; paid activation remains **NO-GO** until an
  atomic reservation/commit/release path is implemented and concurrency-tested.
- [ ] End-to-end production-like tests prove that one inbound Messenger Page
  maps uniquely to its workspace and that the resulting entitlement reaches the
  real AI-answer and image-provider quota gates without a free-tier fallback.
- [ ] The Redis image-generation queue is explicitly workspace-partitioned;
  PSID, prompt, and source-image jobs must never share an unscoped global
  tenant queue before more than one customer workspace is onboarded.
- [ ] Accounting approves sequential proof/invoice numbering, Belgian retention,
  Mollie fee/settlement import, and the small-enterprise VAT wording.
- [ ] A tenant-partitioned durable scheduler replaces the current
  single-workspace worker configuration and proves restart recovery for every
  tenant without cross-tenant reads.
- [ ] Real customer-warning and operator-incident delivery is configured and
  tested; durable failed outbox records alone are not notification.
- [ ] Legal review approves the one-time pilot terms, withdrawal/refund,
  privacy, invoice, and financial-retention copy. The current copy is an
  explicitly pre-launch draft, not legal approval.
- [ ] Settlement and balance reconciliation is proven in live-read-only mode;
  Mollie Business Operations endpoints are not available in Test Mode.
- [ ] A database migration backup, rollback rehearsal, monitoring alerts, and
  operator incident drill are complete.
- [x] Fresh-database migration for the current guarded `0010` revision passed
  MySQL 8.4 GitHub CI run `30715666890` / job `91410691295` on 2026-08-01.
  This is fresh-database CI evidence only, not an upgrade-path or production
  migration authorization.
- [ ] Upgrade-path migration through `0010` from the exact supported
  production-like schema is **NOT RUN / NO-GO**. Production migration is also
  **NOT RUN**.
- [ ] All remote deployment secrets and configuration are checked for legacy
  payment-provider values and those are removed by an authorized operator.

## Manual launch checklist

1. Keep `MOLLIE_BILLING_ENABLED=false`,
   `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=false`,
   `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=false`, `MOLLIE_MODE=test`, and
   `MOLLIE_LIVE_BILLING_ENABLED=false` in production.
2. Before any production migration, run the duplicate-Page preflight and apply
   migrations through `0010` to a disposable MySQL database. Then verify the
   exact production-version upgrade path with a backup and rollback plan.
   Production migration through `0010` is currently **NOT RUN** and remains a
   **NO-GO** item. During the eventual production upgrade, pause and drain
   channel-connection create/update writes from before the duplicate preflight
   until the `(channel, externalId)` unique key is installed; otherwise a new
   claim could race the preflight.

   ```sql
   SELECT channel, externalId, COUNT(*) AS duplicate_count
   FROM channelConnections
   WHERE externalId IS NOT NULL
   GROUP BY channel, externalId
   HAVING COUNT(*) > 1;
   ```

   The result must be empty before `0010` adds the tenant-boundary unique key.
3. Set `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=true` on image-gen and
   `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=true` on the gateway, verify the
   reserve/commit/release flow, and only then set `MOLLIE_BILLING_ENABLED=true`
   in that isolated test environment,
   using a `test_` key, `MOLLIE_BILLING_WORKER_WORKSPACE_ID` for the isolated
   test workspace, and approved non-customer test data.
4. Configure a conservative `OPENAI_IMAGE_ESTIMATED_COST_USD`, run an explicit
   GPT Image 2 generation and edit smoke with approved test data, then run
   TypeScript, unit, route-guard, MySQL integration, and Mollie sandbox tests.
5. In the Mollie profile, enable and verify Bancontact for the Startpilot.
6. Verify the configured webhook is HTTPS and has the exact classic path.
7. Verify redirects never activate access and webhooks/reconciliation do.
8. Verify duplicate checkout, webhook, one-time entitlement, refund and
   chargeback paths. Keep recurring subscription scenarios deferred while that
   offer remains unpublished.
9. Reconcile gross sales, fees, refunds, chargebacks, and settlements with an
   accountant; never recognize a net payout as revenue.
10. Complete tenant mapping and prove Startpilot quota and Images 2.0
    enforcement end to end.
11. Obtain written product, legal, privacy, accounting, security, and operator
    approval.
12. Only then install a `live_` key and deliberately set
    `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=true`,
    `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=true`,
    `MOLLIE_BILLING_ENABLED=true`, `MOLLIE_MODE=live`, and
    `MOLLIE_LIVE_BILLING_ENABLED=true` in the approved production environment.

## Decision rule

- **GO**: all blockers closed and every sandbox/operational result passed.
- **CONDITIONAL GO**: only explicitly time-bounded, non-financial follow-ups
  remain, each with an owner and rollback.
- **NO-GO**: any payment, mandate, entitlement, tenant, legal, accounting, or
  live-key control remains unproven.

Current decision: **NO-GO**.
