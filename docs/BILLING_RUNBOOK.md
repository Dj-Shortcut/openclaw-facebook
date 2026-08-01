# Mollie Billing Runbook

## Safety boundary

Leaderbot sells its own subscriptions. It is not a marketplace and does not use
Mollie Connect. The language model, OpenClaw, and customer-facing clients have no
access to Mollie keys, payouts, settlement movement, or refund mutations.

Only the backend may change entitlements. Amount, EUR currency, interval,
description and quota come from the server catalog. Billing operators may use
provider IDs for reconciliation, but must not copy customer data or secrets into
logs, prompts, tickets, or shared diagnostics.

## Configuration and test-to-live switch

Required variables are documented in `apps/image-gen/.env.example`.

Test configuration must use:

```text
MOLLIE_MODE=test
MOLLIE_API_KEY=test_...
MOLLIE_LIVE_BILLING_ENABLED=false
```

The service rejects a key whose prefix conflicts with the mode. Production and
all live configurations require HTTPS for `APP_BASE_URL` and
`MOLLIE_PAYMENT_WEBHOOK_URL`. The webhook URL must end exactly in
`/api/webhooks/mollie/payments` without a query or fragment.

The in-process worker is deliberately tenant-bound. Set
`MOLLIE_BILLING_WORKER_WORKSPACE_ID` to exactly one workspace in an isolated
test worker. When billing is enabled, startup and readiness fail if this value
is absent; checkout for any other workspace fails closed. When billing is
disabled, readiness does not require Mollie secrets. A durable
tenant-partitioned multi-workspace dispatcher is still required before live
SaaS rollout; do not replace this with a cross-tenant database scan.

Switch to live only after `LAUNCH_READINESS.md` is signed off. Install the live
secret out of band, set `MOLLIE_MODE=live`, verify URLs and methods, and only
then set `MOLLIE_LIVE_BILLING_ENABLED=true`. Roll back by disabling the live
flag; do not delete financial records.

## Payment-method launch check

The protected `portal.billing.launchCheck` procedure calls Mollie's Methods API
for first and recurring sequences. It must report:

- `bancontact: true`
- `sepaDirectDebit: true`
- `salesCountry: BE`
- `currency: EUR`
- `b2bCheckoutEnabled: false`

Bancontact creates a `directdebit` mandate for later collection only when SEPA
Direct Debit is enabled on the Mollie profile. A pending mandate is rechecked by
the bounded DB outbox; an invalid/missing mandate becomes manual review.

## Checkout and webhook verification

1. Confirm the actor is workspace `owner` or `admin` and the Origin matches
   `APP_BASE_URL`.
2. Confirm the requested plan code is active in the server catalog.
3. Confirm a local intent and idempotency key exist before any Payment call.
4. Confirm the first Payment has `sequenceType=first`, `method=bancontact`, the
   full first-period EUR amount, customer ID, exact webhook URL, redirect URL,
   and only the opaque billing intent in metadata.
5. Send the browser to `_links.checkout.href` with GET. A redirect is never
   evidence of payment.
6. The classic webhook reads only `id`, re-fetches the Payment with the API key,
   validates mode, workspace/customer, metadata, amount and currency, and
   commits ledger/delivery/outbox state atomically.
7. Unknown or invalid IDs receive the same generic HTTP 200. Do not add an IP
   allowlist or classic-webhook signature secret. Transient Mollie/database
   failures return a redacted HTTP 503 so Mollie can retry. The exact route uses
   its own high-capacity rate limit instead of the shared application limit.

## Duplicate-payment investigation

1. Freeze new checkout attempts with the live kill switch if customers could be
   charged twice.
2. Search locally by the hashed operational reference, then use the authorized
   billing database/provider console to compare intent, idempotency key,
   customer, Payment and Subscription IDs. Do not paste these into logs.
3. Check `billing_intents`, `payment_ledger`, `webhook_deliveries`,
   `billing_subscriptions`, and `billing_outbox` unique constraints/statuses.
4. List the Mollie Customer's Payments and Subscriptions. Match the opaque
   `billingIntentId` metadata and subscription source intent.
5. Do not automatically refund. An authorized human follows the refund policy
   and records the decision in the financial system.
6. Run reconciliation after the cause is contained; it may synchronize state
   but never move money.

## Reconciliation

`runDailyBillingReconciliation(workspaceId)` claims one MySQL lease per
workspace, mode and UTC date. It reads only that workspace, fetches that
customer's recent Mollie Payments, re-fetches full snapshots including
refunds/chargebacks, checks the exact remote Subscription, expires stale
entitlements, and records metadata-only anomalies. The next daily timestamp is
advanced atomically with successful run completion; failed runs are retried.

The task is idempotent through daily lease, payment ledger uniqueness and
`(workspace_id, mode, mollie_resource_id, snapshot_hash)` delivery uniqueness.
It does not create refunds, payment retries, payouts, or balance transfers.
Mollie owns recurring-payment retries. A local stopped/review state paired with
a remote active Subscription is recorded as an incident anomaly.

Mollie Balances and Settlements must be reconciled by the authorized accounting
workflow in live read-only mode. Those APIs are not a Test Mode substitute.

## Cancellation and new payment method

“Cancel at period end” transactionally marks the local subscription canceled
and commits an exact-target cancellation job. This closes the provisioning race:
if a remote Subscription appears after the request, the ensure worker records
and cancels that orphan. Local access remains only through `paid_through`.

Changing payment method first creates a new full-period `first` Payment. An
abandoned or failed checkout leaves the old Subscription untouched. Only after
the new Payment is confirmed paid does the transaction queue exact cancellation
of the old Subscription. Creation of the replacement Subscription is blocked on
successful completion of that cancellation job. If an already-paid period
remains, the newly purchased period starts after it. The change is allowed only
for an active Subscription, more than seven days before Mollie's freshly fetched
next payment date, and when no old-Subscription collection is open, pending,
authorized, or newly initiated. Past-due recovery remains a billing-support
flow so a Mollie retry cannot overlap a new full Bancontact payment.

An immediate new subscription after cancellation is blocked until the existing
`paid_through` period ends. As a second line of defense, every valid new first
Payment starts after any still-paid local period.

Failed exact cancellation jobs can be re-armed by an explicit cancellation,
the waiting replacement job, or daily reconciliation. Reconciliation lists the
tenant Customer's remote Subscriptions and queues exact cancellation for every
active/pending Subscription that is neither the current contractually matching
Subscription nor the unique current provisioning intent. Before a containment
DELETE, the worker locks and revalidates current local state so stale work cannot
cancel a Subscription that has since become the legitimate current one.

## Refunds and chargebacks

- Refund creation is a manual, authorized administrator action in Mollie.
- Full refund: withdraw entitlement per policy and cancel future collection.
- Partial refund: put the workspace in manual review.
- Chargeback: block access, cancel future collection, preserve evidence, and
  escalate to billing/security review.
- Never expose refund, payout or key access to OpenClaw or a model.
- A refund or chargeback for an older period does not erase a later
  independently paid period; later proven access is preserved while future
  collection can still be stopped and the case escalated.

## Accounting export

Workspace owners/admins can download
`/api/portal/billing/export.csv?workspaceId=...`. It separates gross sales,
Mollie fees, refunds, chargebacks and net settlement and includes Payment ID,
booking date, workspace and proof/invoice number. Spreadsheet formula prefixes
are escaped. The export states “Bijzondere vrijstellingsregeling kleine
ondernemingen”.

Book gross revenue, Mollie fees, refunds and chargebacks separately. Never book
the net Mollie payout as revenue and do not deduct input VAT under the stated
small-enterprise exemption without accounting advice. The current ledger does
not yet import Mollie Balance/Settlement fee lines or settlement IDs, so those
CSV columns remain empty and the export is not live-accounting complete.

B2B checkout remains disabled until a real Peppol invoicing provider and
approved invoice flow exist. A Mollie payment proof is not a Peppol invoice.

## References

- [Mollie classic webhooks](https://docs.mollie.com/reference/webhooks)
- [Mollie recurring payments](https://docs.mollie.com/docs/recurring-payments)
- [Mollie API idempotency](https://docs.mollie.com/reference/api-idempotency)
- [Mollie Subscriptions API](https://docs.mollie.com/reference/subscriptions-api)
- [Mollie testing](https://docs.mollie.com/reference/testing)
