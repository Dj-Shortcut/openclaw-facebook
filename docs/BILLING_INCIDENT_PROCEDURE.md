# Billing Incident Procedure

## First response

1. Declare an incident owner and timestamp.
2. If duplicate/incorrect charges are possible, set
   `MOLLIE_LIVE_BILLING_ENABLED=false` through the approved secret/config
   workflow and roll the billing service safely. Do not disable webhook receipt
   or delete records.
3. Preserve customer access through already-paid `paid_through` dates unless a
   chargeback, fraud or legal hold requires a documented block.
4. Use metadata-only logs and aggregate metrics. Customer content, email,
   provider IDs, keys and request/response bodies do not belong in tickets or
   shared traces.

## Triage

- Determine whether the issue affects checkout creation, webhook ingestion,
  mandate/subscription provisioning, recurring state, entitlement state, or
  accounting reconciliation.
- Compare local intent, ledger, delivery, subscription, entitlement and outbox
  state with freshly fetched Mollie objects in an approved support session.
- Run read-only daily reconciliation when safe. It must not move money.
- For suspected duplicates, follow `BILLING_RUNBOOK.md`; do not initiate an
  automatic refund.

## Customer-content access

Normal infrastructure access covers billing metadata, uptime, quotas and
financial reliability—not conversations, memory, knowledge or prompts. Content
inspection requires explicit customer approval. Break-glass access must be
narrow, time-limited and audited.

## Recovery and closure

1. Correct state with an audited, tenant-scoped operation.
2. Verify webhooks and reconciliation are idempotent after replay/refetch.
3. Confirm future collections, paid-through and entitlement state for every
   affected workspace.
4. Reconcile gross sales, fees, refunds, chargebacks and settlement totals.
5. Notify affected customers without exposing another tenant's information.
6. Record root cause, impact counts, controls added, test evidence and rollback.
7. Re-enable live billing only with incident-owner and product/finance approval.
