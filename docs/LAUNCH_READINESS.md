# Leaderbot Startpilot Launch Decision

Current decision: **NO-GO for live billing**.

This file is the final decision record, not a second engineering backlog. Open
work is tracked once in [`operations/todo.md`](operations/todo.md); Mollie case
evidence is recorded in [`MOLLIE_TEST_RESULTS.md`](MOLLIE_TEST_RESULTS.md).

## Product boundary

Startpilot belongs entirely to `apps/image-gen`:

```text
Customer Messenger/portal
  -> apps/image-gen tenant runtime
  -> quota, image provider and Mollie
```

The repository owner's personal OpenClaw gateway is not used by customers and
is not a billing, entitlement, notification or release dependency. The old
gateway AI-answer quota preflight has been removed. Customer answer admission,
when included in the offer, uses the tenant-bound `apps/image-gen` quota
preflight and durable finalization drain.

## Bounded offer

- EUR 19 once;
- 30 days;
- one workspace and one connected Facebook Page;
- 20 GPT Image 2 generations;
- at most 5 successful images per Europe/Brussels day;
- no renewal, top-up or overage.

Any customer text-answer allowance must be enforced directly in
`apps/image-gen` and stated consistently in the catalog, checkout copy, terms
and portal before launch. OpenClaw answers are not part of the offer.

## GO gates

All six gates must have dated evidence linked below before a `live_` key or live
billing flag is installed.

| Gate | Required evidence | Status |
| --- | --- | --- |
| Direct tenant path | One Meta Page resolves to one workspace; text/image/edit requests reach real tenant quota/provider gates without gateway or free-tier fallback | OPEN |
| Billing integrity | Full Mollie Test matrix plus real-MySQL concurrency, duplicate webhook, ledger, outbox and idempotency evidence | OPEN |
| Customer protection | Approved Belgian B2C terms, VAT/invoice, refund/withdrawal, privacy and financial-retention treatment | OPEN |
| Usage protection | 5/day and 20/period counters, provider hard limit, pre-call admission and durable finalization proven end to end | OPEN |
| Operations | Tenant scheduler, customer/operator notifications, complete accounting export and read-only settlement reconciliation proven | OPEN |
| Release proof | Approved immutable image, schema/restore proof, direct Messenger + portal smoke, monitoring and rollback drill | OPEN |

## Activation order

1. Keep `MOLLIE_MODE=test`, `MOLLIE_BILLING_ENABLED=false`,
   `MOLLIE_LIVE_BILLING_ENABLED=false` and customer entitlement flags off in
   production.
2. Complete the six gates using approved non-customer test data.
3. Record written product, legal, accounting, privacy, security and operator
   approval.
4. Deploy the approved immutable `apps/image-gen` artifact and verify the exact
   database schema and rollback target.
5. Enable customer entitlement/quota enforcement in `apps/image-gen` and repeat
   the direct Messenger/portal smoke in Test Mode.
6. Only then install the `live_` key and deliberately enable live billing.

## Decision rule

- **GO:** every gate is closed with production-relevant evidence.
- **CONDITIONAL GO:** only explicit, time-bounded, non-financial follow-ups
  remain and each has an owner and rollback.
- **NO-GO:** any tenant, payment, entitlement, quota, legal, accounting,
  notification, migration, smoke or rollback control is unproven.
