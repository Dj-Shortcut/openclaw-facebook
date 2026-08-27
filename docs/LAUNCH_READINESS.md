# One-time premium credits launch decision

Current decision: **NO-GO for live payments**.

This document defines launch gates, not a second backlog. Implementation order
lives only in [`operations/todo.md`](operations/todo.md).

## Gates

| Gate | Required result | Status |
| --- | --- | --- |
| Direct Messenger runtime | Owner Page uses `apps/image-gen`; no OpenClaw traffic or fallback | OPEN |
| User credit identity | Wallet and checkout are bound to exact Page, privacy epoch, and pseudonymous user | OPEN |
| Ledger integrity | One payment grants once; reservations commit/release atomically under retries and crashes | OPEN |
| Checkout clarity | Exact price, credits, quality, validity, no subscription, and order-and-pay confirmation | OPEN |
| Mollie Test Mode | Complete success/failure/replay/refund/reconciliation matrix passes | OPEN |
| Unit economics | Payment fees, tax treatment, image/edit cost, retries, storage, support, and refund reserve fit the offer | OPEN |
| Consumer protection | Belgian legal/accounting review approves checkout, withdrawal, receipt, refund, privacy, and retention | OPEN |
| Meta compliance | CTA and confirmation behavior fit approved permissions and messaging window | OPEN |
| Cost protection | Free and paid admission plus global/per-user provider caps fail closed | OPEN |
| Operations | Monitoring, incident handling, reconciliation, support, deletion, and metadata-only evidence work | OPEN |
| Release safety | Immutable artifact, schema/restore proof, smoke, rollback, and outstanding-payment recovery pass | OPEN |

## Activation order

1. Keep live checkout and every recurring path disabled.
2. Complete the direct Messenger and user-wallet migrations.
3. Pass the full Mollie Test Mode and failure-path suite.
4. Approve one immutable offer and provider-quality policy.
5. Obtain written product, legal, accounting, privacy, security, and operator
   approval.
6. Deploy the reviewed artifact with paid admission active but live checkout
   still hidden.
7. Run a production-equivalent no-money smoke and rollback drill.
8. Enable one bounded live offer for a limited audience.
9. Review conversion, cost, refunds, failures, and support before expansion.

## Decision rule

- **GO:** every gate is closed with dated production-relevant evidence.
- **CONDITIONAL GO:** only explicit, time-bounded non-financial follow-ups remain
  and none can affect charging, credit balance, privacy, delivery, or rollback.
- **NO-GO:** any payment, credit, legal, Meta, cost, deletion, reconciliation,
  migration, or rollback control remains unproven.

Never install or expose a live key merely to test whether the flow works.
