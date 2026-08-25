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

Before any provider call, run the provider-silent readiness phase with
`MOLLIE_BILLING_PREFLIGHT_ENABLED=true` and
`MOLLIE_BILLING_ENABLED=false`. `MOLLIE_BILLING_DRAIN_ENABLED` and every
entitlement, notification, accounting and provider execution flag stay off in
that phase. A valid response is a
green `/readyz` with `phase: "offline"`; it validates configuration and
schema without reading the Mollie credential or calling Mollie.

The service rejects a key whose prefix conflicts with the mode. Production and
all live configurations require HTTPS for `APP_BASE_URL` and
`MOLLIE_PAYMENT_WEBHOOK_URL`. The effective portal origin from
`PORTAL_BASE_URL` (falling back to `APP_BASE_URL`) must also be an HTTPS origin
in production/live mode, without a path, query, or fragment. The webhook URL
must end exactly in `/api/webhooks/mollie/payments` without a query or
fragment. Billing readiness rejects these misconfigurations before checkout.

The durable scheduler is tenant-partitioned. Set
`MOLLIE_BILLING_SCHEDULER_MODE=pilot_pin` together with exactly one positive
`MOLLIE_BILLING_WORKER_WORKSPACE_ID` for the isolated sandbox pilot, or use
`multi_tenant` with that workspace variable unset after the broader rollout is
approved. Readiness verifies execution controls, matching lane epochs,
heartbeats, backlog and dead letters. Do not introduce a cross-tenant scan.

Set `MOLLIE_BILLING_DRAIN_ENABLED=true` before the first checkout and keep it
true for the retained financial-record lifetime. Commercial disable blocks new
plans, provider creates and checkout URL exposure; it must not disable the
provider/safety drain for an already exposed Payment.
Classic webhooks, reconciliation, exact cancellation, receipt/export and
manual-review delivery stay available until every exposed or ambiguous
operation is terminal. Readiness must be red if exposed work exists without its
drain.

Switch to live only after `LAUNCH_READINESS.md` is signed off. Install the live
secret out of band, set `MOLLIE_MODE=live`, verify URLs and methods, and only
then deliberately enable the commercial and live gates. Emergency commercial
disable stops new exposure but preserves financial evidence and safety drain;
never delete financial records.

## Protected schema and runtime rollout

Production completed the protected move from `0015_base` to the
backwards-compatible `0016_expand` phase. Migration 0017 is blocked for a later
reviewed rollout.
Use the exact protected sequence in
`docs/operations/production-deployments.md`: attested bridge, reviewed digest,
bridge deploy, encrypted snapshot and isolated restore proof, protected 0016
expand, attested runtime, reviewed digest, runtime deploy. Never type migration
commands into a production shell.

## Payment-method launch check

The protected `portal.billing.launchCheck` procedure performs no provider call
in its offline phase. In the explicitly approved provider phase, the one-time
Startpilot launch requires:

- `bancontact: true`
- `providerChecked: true`
- `phase: provider`
- `mode: test`
- `sandboxReady: true`
- `salesCountry: BE`
- `currency: EUR`
- `b2bCheckoutEnabled: false`

In Mollie Test Mode, `ok` remains `false` because that field means live-ready;
use `sandboxReady: true` as the explicit Test Mode GO signal.

SEPA Direct Debit and mandates belong only to the unpublished subscription
foundation and are not a requirement for the one-time Startpilot offer.

## Checkout and webhook verification

1. Confirm the actor is workspace `owner` or `admin`, the Origin matches
   `APP_BASE_URL`, and the workspace has an audited, unexpired Belgian-consumer
   billing profile. The seller's Peppol registration is unrelated to buyer
   eligibility; business/Peppol buyer profiles remain blocked.
2. Confirm the requested plan code is active in the server catalog.
3. Confirm a local intent and idempotency key exist before any Payment call.
4. Confirm the one-time Payment has `sequenceType=oneoff`, `method=bancontact`, the
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

## Dormant subscription cancellation and payment-method code

The public Startpilot offer is one-time and has no renewal or Subscription. The
following behavior is retained only as regression protection for unpublished
subscription foundation code; do not expose it as a launch product.

“Cancel at period end” transactionally marks a local subscription canceled
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

## Operator incidents

Platform admins review materialized `manual_review` notifications in the
tenant-scoped portal incident card. It exposes only event code, reason code and
timestamps; acknowledgement is bound to the exact workspace, operator audience
and unread row and writes a metadata-only audit record. A notification receiver
dead letter is not acknowledged through this card: it keeps `/readyz` red and
requires the documented on-call recovery drill.

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

## Accounting export and import

Workspace owners/admins can download
`/api/portal/billing/export.csv?workspaceId=...`. It separates gross sales,
Mollie fees, refunds, chargebacks and net settlement and includes Payment ID,
booking date, workspace and proof/invoice number. Spreadsheet formula prefixes
are escaped. The export states “Bijzondere vrijstellingsregeling kleine
ondernemingen”.

Book gross revenue, Mollie fees, refunds and chargebacks separately. Never book
the net Mollie payout as revenue and do not deduct input VAT under the stated
small-enterprise exemption without accounting advice.

The GET-only account-level importer is provider-account/mode scoped, bounded,
crash-resumable and quarantines unknown or ambiguous events, but its durable
cursor is not yet bound to one exact Mollie Balance. Keep
`MOLLIE_ACCOUNTING_IMPORT_ENABLED=false` for the pilot. Accountable is the
intended external bookkeeping workflow; reconcile gross revenue, Mollie fees,
refunds, chargebacks, Balances and Settlements there and obtain human sign-off
before live. If the built-in importer is selected later, first add durable
Balance-ID scope to runs, cursors, events and readiness, then use a dedicated
read-only accounting credential rather than the payment API key.

B2B checkout remains disabled until a real Peppol invoicing provider and
approved invoice flow exist. A Mollie payment proof is not a Peppol invoice.

## References

- [Mollie classic webhooks](https://docs.mollie.com/reference/webhooks)
- [Mollie recurring payments](https://docs.mollie.com/docs/recurring-payments)
- [Mollie API idempotency](https://docs.mollie.com/reference/api-idempotency)
- [Mollie Subscriptions API](https://docs.mollie.com/reference/subscriptions-api)
- [Mollie testing](https://docs.mollie.com/reference/testing)
