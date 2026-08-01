# Leaderbot Cancellation and Refund Policy

Status: draft pending Belgian legal and accounting review.

## Subscription and renewal

Leaderbot subscriptions renew automatically at the displayed interval and
price. The first period is paid through Mollie Hosted Checkout, initially with
Bancontact. Later payments may be collected by SEPA Direct Debit under the
mandate established by that first payment.

The checkout must show the first amount, recurring amount, interval, automatic
renewal, later direct debit, and cancellation timing before payment.

## Cancellation

Customers can cancel from the Leaderbot billing page. Leaderbot immediately
records the cancellation request and durably cancels the exact Mollie
Subscription so no next collection is scheduled. Service continues only until
the displayed `paid_through` date. Cancellation does not by itself refund an
already-paid period.

## Payment-method change

Changing payment method requires a new Mollie first Payment and mandate. The old
Subscription remains intact if checkout is abandoned or fails. After the new
first Payment is confirmed, the old Subscription must be canceled before the
replacement Subscription may be created. A new paid period is placed after any
already-paid access.

## Refunds and disputes

Refunds are reviewed and issued manually by an authorized administrator; the
assistant and OpenClaw cannot initiate them. A full refund normally withdraws
the related entitlement and stops future collection. A later independently
paid period remains available. A partial refund requires manual entitlement
review. A chargeback can block access while the case is
reviewed. Mandatory consumer rights override this draft policy.

For billing help, use the support address shown in the portal. Do not send API
keys, bank details, full provider payloads, conversations, prompts or uploaded
knowledge.

## Invoicing

Leaderbot v1 is B2C-only in Belgium. Payment proofs state “Bijzondere
vrijstellingsregeling kleine ondernemingen”. B2B checkout is disabled until a
real Peppol invoicing provider is configured. A Mollie payment proof is not a
Peppol invoice.
