# Leaderbot cancellation and refund policy

Status: draft pending Belgian legal and accounting review.

## One-time Startpilot purchase

The public launch offer is a single EUR 19.00 payment for 30 days of Startpilot
access. It does not renew automatically and does not create a subscription,
direct-debit mandate, top-up or overage charge. At the end of the 30-day period,
access expires unless the product owner later publishes a separately reviewed
offer.

The checkout must show the exact one-time amount, access period and included
limits before payment. A browser redirect is never proof of payment; access is
activated only after the backend verifies the Payment with Mollie.

## Cancellation and withdrawal

Because the public offer has no future collection, there is no recurring
subscription to cancel. A customer may contact the support address shown in the
portal about withdrawal or cancellation rights. An authorized human applies
the legally approved policy; the assistant and OpenClaw cannot move money.

The final withdrawal window, treatment of immediately started digital service,
and required consent wording remain subject to Belgian legal approval.
Mandatory consumer rights override this draft.

## Refunds and disputes

Refunds are reviewed and issued manually by an authorized administrator. A full
refund normally withdraws the related entitlement. A partial refund requires
manual entitlement review. A chargeback can block access while the case is
reviewed. Every exception must create a human-visible, metadata-only operator
incident; do not put customer content or secrets in the incident record.

For billing help, use the support address shown in the portal. Do not send API
keys, bank details, full provider payloads, conversations, prompts or uploaded
knowledge.

## Proof and invoicing

Leaderbot v1 is B2C-only in Belgium. Business/Peppol buyer checkout is disabled.
The seller's own Peppol registration is separate from buyer eligibility and
does not turn a consumer purchase into B2B.

Payment proofs use the approved small-enterprise VAT-exemption wording only
after accounting/legal sign-off. A Mollie payment proof is not automatically a
Peppol invoice. Proof/invoice numbering, retention and bookkeeping treatment
remain launch gates.

## Unpublished subscription foundation

The codebase retains defensive subscription, mandate and exact-cancellation
logic for regression testing. It is not part of the public offer and must not be
advertised or enabled without a separate product, legal, accounting, provider
and migration review.
