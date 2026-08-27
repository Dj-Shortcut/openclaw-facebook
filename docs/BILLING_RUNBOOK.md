# One-time credit billing runbook

## Scope

Leaderbot's target commercial model is a one-time purchase of premium image
credits by an end user who reached or approached the free daily limit.

There is no subscription, automatic renewal, mandate, automatic top-up, or
post-paid overage. Legacy recurring code remains disabled until it is removed.

Live checkout is currently a **NO-GO** until the gates in
[`LAUNCH_READINESS.md`](LAUNCH_READINESS.md) are closed.

## Offer contract

Every offer is defined server-side and versioned. It contains:

- immutable offer code and version;
- public name and description;
- EUR price in minor units;
- exact number of premium image credits;
- quality/model policy reference;
- explicit no-expiry policy;
- refund and partial-use policy;
- active/public flags.

The browser and Messenger action may select only the offer code. Never accept
price, currency, quantity, model, quality, or expiry from client input.

## Checkout flow

1. Free quota exhaustion returns a channel-neutral checkout action.
2. The server creates a short-lived encrypted handoff bound to the exact
   conversation subject, Page binding, privacy epoch, offer, nonce, and expiry.
   Replaying the same capability resolves to the same local payment intent and
   must never create a second charge.
3. The checkout page shows the seller, total price, credits, quality, validity,
   no-subscription disclosure, refund/withdrawal terms, and an explicit
   order-and-pay button.
4. After explicit confirmation, the server creates one Mollie one-off payment
   with a trusted redirect and webhook URL.
5. Mollie hosts payment method selection and payment credential collection.
6. The return page reports that verification is pending and never grants
   credits or treats browser navigation as payment authority.
7. The webhook/status worker fetches or verifies the latest Mollie object.
8. A valid paid amount, currency, mode, profile, offer, and local intent mark
   that exact user-scoped intent paid once. Spendable grants are derived from
   those paid intents; duplicate payment snapshots cannot add another grant.
9. The user can spend the balance on premium generations.

Do not place raw PSIDs, prompts, messages, image URLs, or secrets in the handoff
URL, redirect URL, Mollie description, or metadata.

## Credit consumption

Paid generation uses the existing durable provider-attempt fence as its atomic
credit lifecycle:

```text
available -> reserved -> committed
                      \-> released
```

- Reserve before a billable provider call.
- Use a stable request receipt/idempotency key.
- Commit once at the documented usable-output/delivery boundary.
- Release on preflight rejection or another failure proven to occur before
  provider transport.
- Hold any failure after transport as ambiguous until provider reconciliation
  proves whether a billable result exists; never retry it automatically.
- Never fall back from paid admission to an unbounded provider call.

Free daily quota remains a separate counter. Its reset must not alter purchased
balance.

## Webhooks and reconciliation

- Accept webhook retries idempotently.
- Fetch provider state rather than trusting mutable browser input.
- Return a generic success for unknown public webhook identifiers when safe,
  without revealing whether a payment exists.
- Quarantine amount, currency, offer, mode, profile, or ownership mismatches for
  human review; do not grant.
- Reconciliation is read-only until it invokes a specific reviewed local
  transition.
- Keep provider payment, local intent, grant, ledger entries, and accounting
  record linked through opaque identifiers.

## Refunds and chargebacks

Refunds are human-approved until a separate automated policy is proven.

- Unused bundle: normally reverse the remaining liability through an explicit
  refund/adjustment operation.
- Partially used bundle: follow the approved policy; never create a negative
  wallet or rewrite consumed history.
- Chargeback or fraud hold: block new paid spending only through an audited
  status transition.
- Provider refund and local wallet adjustment must reconcile but remain
  separately recorded events.

See [`CANCELLATION_REFUND_POLICY.md`](CANCELLATION_REFUND_POLICY.md).

## Operational flags

Until the new wallet path replaces legacy workspace entitlement billing, keep
all live and recurring behavior off. Existing `MOLLIE_*` flags are transitional
implementation details; do not infer product approval from a flag name.

Enabling live checkout requires one reviewed configuration change that proves:

- one-time offer only;
- recurring workers and mandate/subscription creation disabled;
- webhook and drain/reconciliation paths remain available;
- paid-credit enforcement active before checkout exposure;
- provider budgets and rollback configured.

## Required Test Mode cases

- successful, failed, canceled, expired, and pending payment;
- webhook before return and return before webhook;
- duplicate and reordered webhooks;
- duplicate checkout click and expired handoff;
- amount, currency, mode, offer, and user-binding mismatch;
- payment succeeds during deployment or temporary checkout disable;
- exactly one credit grant per payment;
- concurrent reservations and insufficient balance;
- provider failure, ambiguous result, delivery failure, and process crash;
- full and partial refund plus chargeback;
- deletion and Page rebinding during checkout/generation;
- no content or secrets in logs, receipts, or reconciliation output;
- rollback with an already-created payment and an existing wallet.

## Incident response

Follow [`BILLING_INCIDENT_PROCEDURE.md`](BILLING_INCIDENT_PROCEDURE.md). Do not
repair payment state through ad-hoc SQL or provider dashboard changes without a
matching audited local transition.
