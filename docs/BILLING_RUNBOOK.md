# Mollie Billing Runbook

## Safety boundary

Leaderbot sells its own one-time access offer. It is not a marketplace and does
not use Mollie Connect. The language model, OpenClaw, and customer-facing
clients have no access to Mollie keys, payouts, settlement movement, or refund
mutations.

Only the backend may change entitlements. Amount, EUR currency, access period,
description and quota come from the server catalog. Billing operators may use
provider IDs for reconciliation, but must not copy customer data or secrets
into logs, prompts, tickets, or shared diagnostics.

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
`MOLLIE_PAYMENT_WEBHOOK_URL`. The effective portal origin from
`PORTAL_BASE_URL` (falling back to `APP_BASE_URL`) must also be an HTTPS origin
in production/live mode, without a path, query, or fragment. The webhook URL
must end exactly in `/api/webhooks/mollie/payments` without a query or
fragment. Billing readiness rejects these misconfigurations before checkout.

The durable DB scheduler is tenant- and mode-partitioned. Set
`MOLLIE_BILLING_SCHEDULER_MODE=pilot_pin` for an isolated pilot and pair it with
`MOLLIE_BILLING_WORKER_WORKSPACE_ID`; use `multi_tenant` only after the launch
decision explicitly authorizes it. Registry rows, execution epochs, leases,
heartbeats and fairness prevent cross-tenant claims. Disabling commercial
billing fences checkout/exposure while the safety outbox remains able to drain
exact cancellation and metadata-only review/notification work. When billing is
disabled, credential-free readiness does not require a Mollie key.

Switch to live only after `LAUNCH_READINESS.md` is signed off. Install the live
secret out of band, set `MOLLIE_MODE=live`, verify URLs and methods, and only
then set `MOLLIE_LIVE_BILLING_ENABLED=true`. Roll back by disabling the live
flag; do not delete financial records.

## Payment-method launch check

The protected `portal.billing.launchCheck` procedure checks the one-time
payment method for the public Startpilot offer. It must report:

- `bancontact: true`
- `offerType: one_time`
- `paymentSequenceType: oneoff`
- `sepaDirectDebitRequired: false`
- `salesCountry: BE`
- `currency: EUR`
- `b2bCheckoutEnabled: false`

The launch offer does not create a recurring mandate or Mollie Subscription.
Subscription code remains dormant for containment/reconciliation of legacy or
unexpected remote state and is not a customer launch path.

## Checkout and webhook verification

1. Confirm the actor is workspace `owner` or `admin` and the Origin matches
   `APP_BASE_URL`.
2. Confirm the requested plan code is active in the server catalog.
3. Confirm a local intent and idempotency key exist before any Payment call.
4. Confirm the Payment has `sequenceType=oneoff`, `method=bancontact`, the
   full one-time EUR amount, customer ID, exact webhook URL, redirect URL,
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

The DB scheduler claims one fenced reconciliation lease per workspace and mode.
It reads only that workspace, fetches that customer's recent Mollie Payments,
re-fetches full snapshots including refunds/chargebacks, expires stale
entitlements, and records metadata-only anomalies. The next due timestamp is
advanced atomically with successful run completion; failed runs are retried.

The task is idempotent through daily lease, payment ledger uniqueness and
`(workspace_id, mode, mollie_resource_id, snapshot_hash)` delivery uniqueness.
It does not create refunds, payment retries, payouts, balance transfers or a
new Subscription. Any remote active/pending Subscription discovered for this
one-time offer is an incident: exact tenant/resource binding is required before
the safety lane may contain it.

Mollie Balances and Settlements must be reconciled by the authorized accounting
workflow in live read-only mode. Those APIs are not a Test Mode substitute.

## One-time access and unexpected recurring state

Startpilot is a one-time purchase. There is no automatic renewal, cancel-at-
period-end action, mandate replacement or customer payment-method migration.
Access ends at the recorded entitlement expiry unless a later separately
authorized one-time offer is purchased.

The subscription/cancellation worker is a safety boundary only. If response
loss, legacy data or a provider anomaly exposes a remote Subscription, the
worker first proves exact workspace, mode, customer, source intent and remote
resource binding. It then records containment and an operator notification;
scope or metadata mismatch performs no provider mutation and goes to manual
review. This dormant safety path must never be presented as the launch product.

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
`/api/portal/billing/export.csv?workspaceId=...&from=YYYY-MM-DD&until=YYYY-MM-DD`.
`from` is inclusive, `until` is exclusive, and the requested range may not
exceed 366 days. The server selects Test or Live mode; the caller does not.
The export includes gross sales, refunds, chargebacks, Payment ID, booking date,
workspace and proof/invoice number. Spreadsheet formula prefixes are escaped.
It states “Bijzondere vrijstellingsregeling kleine ondernemingen”.

Book gross revenue, Mollie fees, refunds and chargebacks separately. Never book
the net Mollie payout as revenue and do not deduct input VAT under the stated
small-enterprise exemption without accounting advice. The CSV reserves columns
for Mollie fees, net settlement and settlement ID, but the current ledger does
not yet import the required Balance/Settlement lines, so those columns remain
empty and the export is not live-accounting complete.

B2B checkout remains disabled until a real Peppol invoicing provider and
approved invoice flow exist. A Mollie payment proof is not a Peppol invoice.

## References

- [Mollie classic webhooks](https://docs.mollie.com/reference/webhooks)
- [Mollie API idempotency](https://docs.mollie.com/reference/api-idempotency)
- [Mollie testing](https://docs.mollie.com/reference/testing)
