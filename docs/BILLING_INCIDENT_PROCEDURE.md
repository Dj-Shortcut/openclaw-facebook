# One-time credit incident procedure

Use this procedure for one-time checkout, payment, credit-grant, wallet, refund,
or reconciliation incidents. It does not cover subscriptions; those are legacy
and must remain disabled.

## First response

1. Assign an incident owner and timestamp.
2. If an incorrect or duplicate charge or grant is possible, disable creation
   of new live checkouts through the approved configuration workflow.
3. Keep payment webhooks and read-only reconciliation available. Disabling new
   sales must not make already-created payments unrecoverable.
4. Pause new paid generations if wallet consistency is uncertain. Free usage
   may continue only when it cannot mutate the affected paid state.
5. Preserve metadata-only evidence. Never copy messages, prompts, media, raw
   PSIDs, checkout tokens, credentials, or provider payload bodies into tickets.

## Triage

Classify the incident:

- checkout intent or signed-handoff failure;
- Mollie payment-status mismatch;
- missing or duplicate credit grant;
- stuck, duplicated, or incorrectly committed reservation;
- refund/chargeback mismatch;
- wallet projection differs from immutable ledger;
- accounting or settlement reconciliation mismatch;
- user deletion or Page rebinding crossed a payment boundary.

Compare the local intent, payment snapshot, immutable credit ledger, wallet
projection, reservations, and freshly fetched Mollie payment in an approved
support session. Content access is not required.

## Safety rules

- Never grant credits from a browser redirect.
- Never edit or delete ledger history to repair a balance.
- Never reuse a payment ID, idempotency key, or checkout nonce.
- Never issue an automatic refund merely because reconciliation is uncertain.
- Use an explicit audited adjustment for a confirmed repair.
- Do not remove a privacy tombstone to restore a purchase. Escalate the legal
  and accounting treatment of paid balance after deletion.

## Recovery

1. Re-fetch the provider payment status.
2. Replay the idempotent local transition in Test Mode or a safe fixture first.
3. Rebuild the wallet projection from the immutable ledger when supported.
4. Apply a narrowly scoped grant, release, refund, or adjustment operation.
5. Prove the same webhook or worker retry has no second effect.
6. Reconcile gross amount, fees, refunds, chargebacks, credits granted, credits
   consumed, and remaining liability.
7. Notify affected users without exposing another user's information.
8. Re-enable paid work only with incident-owner and product/finance approval.

## Closure evidence

Record only incident id, time range, opaque payment/request identifiers, number
of affected users, monetary totals, credit totals, failure classes, corrective
operations, tests, deployment identity, and rollback result.
