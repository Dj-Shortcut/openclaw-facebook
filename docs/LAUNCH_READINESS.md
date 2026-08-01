# Leaderbot Mollie Launch Readiness

Status on 2026-08-01: **NO-GO** for live billing.

The code path is intentionally fail-closed. `MOLLIE_MODE=test` is the only
approved mode until the checklist below is complete. No deployment, live key,
commit, push, refund, payout, or settlement movement is authorized by this
document.

## Implemented locally

- Server-side `premium_monthly_v1` catalog; browser input selects only a plan code.
- EUR-only, Belgium-only, B2C-only checkout contract.
- A default-off `MOLLIE_BILLING_ENABLED` master switch prevents paid-plan
  exposure, checkout, Mollie routes, workers, and reconciliation during the
  interest-only phase. Explicit key/mode validation, production HTTPS
  enforcement, and the separate `MOLLIE_LIVE_BILLING_ENABLED=false` live kill
  switch remain in place.
- Mollie Customer, full-period Bancontact first payment, Hosted Checkout,
  opaque intent metadata, and deterministic idempotency keys.
- Exact classic webhook route: `POST /api/webhooks/mollie/payments` with a 2 KB
  form parser. It reads `id`, fetches the Payment from Mollie, and does not
  implement a fictitious signature check.
- MySQL billing intent, customer, subscription, ledger, delivery,
  entitlement, outbox, reconciliation-run and anomaly records with duplicate
  constraints, workspace foreign keys, Test/Live isolation, and a cumulative
  `0009` Drizzle snapshot.
- Bounded mandate polling, valid direct-debit mandate check, subscription start
  on the already-paid period end, cancellation, payment-method replacement,
  grace handling, refund/chargeback review states, and daily reconciliation.
- Exact-target cancellation recovery, ambiguous-create containment, stale-lease
  fencing, terminal-state guards, and a seven-day/in-flight collection guard
  for payment-method replacement.
- Tenant-scoped billing summary, payment proof, and CSV accounting export.
- A tenant-bound worker configuration that refuses checkout for any other
  workspace instead of performing cross-tenant job scans.
- Public gateway tests prove that only the exact POST Mollie webhook path is
  admitted; GET, trailing-slash, singular, and lookalike paths are rejected.

## Open blockers

- [ ] Product owner approves the provisional `EUR 29.00 / 1 month` price and
  quota in `apps/image-gen/server/_core/billing/catalog.ts`.
- [ ] A verified billing-country/customer-profile control replaces reliance on
  the fixed BE checkout contract so Belgium-only eligibility cannot be faked by
  a client.
- [ ] A real Mollie Test profile proves Bancontact and SEPA Direct Debit are
  enabled through the launch check.
- [ ] Every scenario in `MOLLIE_TEST_RESULTS.md` is run with a `test_` key and
  evidence is recorded without customer data or secrets.
- [ ] MySQL integration tests prove transaction rollback, unique constraints,
  checkout races, duplicate webhooks, outbox leases, and subscription races.
- [ ] Messenger/WhatsApp inbound Page or channel identity is mapped uniquely to
  a workspace, and the workspace entitlement is enforced by the actual provider
  quota gate. Current sender-scoped quota cannot safely enforce a paid plan.
- [ ] Accounting approves sequential proof/invoice numbering, Belgian retention,
  Mollie fee/settlement import, and the small-enterprise VAT wording.
- [ ] A tenant-partitioned durable scheduler replaces the current
  single-workspace worker configuration and proves restart recovery for every
  tenant without cross-tenant reads.
- [ ] Real customer-warning and operator-incident delivery is configured and
  tested; durable failed outbox records alone are not notification.
- [ ] Legal review approves automatic renewal, SEPA mandate, cancellation,
  withdrawal/refund, privacy, and financial-retention copy.
- [ ] Settlement and balance reconciliation is proven in live-read-only mode;
  Mollie Business Operations endpoints are not available in Test Mode.
- [ ] A database migration backup, rollback rehearsal, monitoring alerts, and
  operator incident drill are complete.
- [ ] Fresh-database and upgrade-path migration tests run against the exact
  supported MySQL production version. Local `drizzle-kit check` passes, but no
  disposable MySQL server was available in this work session.
- [ ] All remote deployment secrets and configuration are checked for legacy
  payment-provider values and those are removed by an authorized operator.

## Manual launch checklist

1. Keep `MOLLIE_BILLING_ENABLED=false`, `MOLLIE_MODE=test`, and
   `MOLLIE_LIVE_BILLING_ENABLED=false` in production.
2. Apply migration `0009_mollie_billing.sql` to a disposable MySQL database.
3. Set `MOLLIE_BILLING_ENABLED=true` only in that isolated test environment,
   using a `test_` key, `MOLLIE_BILLING_WORKER_WORKSPACE_ID` for the isolated
   test workspace, and approved non-customer test data.
4. Run TypeScript, unit, route-guard, MySQL integration, and Mollie sandbox tests.
5. In the Mollie profile, enable and verify Bancontact plus SEPA Direct Debit.
6. Verify the configured webhook is HTTPS and has the exact classic path.
7. Verify redirects never activate access and webhooks/reconciliation do.
8. Verify duplicate checkout, webhook, subscription, refund and chargeback paths.
9. Reconcile gross sales, fees, refunds, chargebacks, and settlements with an
   accountant; never recognize a net payout as revenue.
10. Complete tenant mapping and prove premium quota enforcement end to end.
11. Obtain written product, legal, privacy, accounting, security, and operator
    approval.
12. Only then install a `live_` key and deliberately set
    `MOLLIE_BILLING_ENABLED=true`, `MOLLIE_MODE=live`, and
    `MOLLIE_LIVE_BILLING_ENABLED=true` in the approved production environment.

## Decision rule

- **GO**: all blockers closed and every sandbox/operational result passed.
- **CONDITIONAL GO**: only explicitly time-bounded, non-financial follow-ups
  remain, each with an owner and rollback.
- **NO-GO**: any payment, mandate, entitlement, tenant, legal, accounting, or
  live-key control remains unproven.

Current decision: **NO-GO**.
