# Production readiness

Status: **migration in progress; live one-time checkout is disabled**.

The active outcome and order live in
[`operations/todo.md`](operations/todo.md). This document defines the final
production smoke and evidence required for the owner-operated Messenger bot.

## Runtime contract

```text
Owner Page -> Meta webhook -> apps/image-gen -> conversation -> Messenger
```

OpenClaw is not an active runtime dependency. The old gateway and root plugin
remain only until callback, traffic, state, rollback, extraction, and deletion
obligations are safely retired.

## Free journey smoke

Using an approved test Page and non-customer test user:

1. Meta verifies the canonical callback.
2. A signed user-initiated text message receives a normal reply.
3. Consent grant, refusal, typed fallback, and stale reply behave correctly.
4. Prompt-first text-to-image succeeds.
5. Source-photo edit and multi-photo composition succeed.
6. Free balance updates once for a usable delivered result.
7. Duplicate event, provider failure, and delivery failure do not double-count.
8. Exhaustion blocks before provider work and shows the next reset.
9. `delete-my-data` removes eligible state, cancels queued work, and suppresses
   late output.
10. Logs and smoke evidence contain metadata only.

## Paid journey smoke

Required in Mollie Test Mode before any live payment:

1. Exhaustion response presents the exact one-time offer and a decline path.
2. Checkout handoff is signed, short-lived, single-use, and user/Page bound.
3. Checkout shows price, credits, quality, validity, no subscription, and legal
   confirmations.
4. Successful payment creates one grant after trusted status verification.
5. Redirect-before-webhook and webhook-before-redirect both converge.
6. Duplicate or reordered webhooks have no second effect.
7. Failed, canceled, expired, mismatched, and unknown payments grant nothing.
8. Premium generation reserves and commits one credit; failures release it.
9. Concurrent requests cannot overspend the wallet.
10. Refund, partial use, chargeback, deletion, and Page rebinding follow the
    approved ledger policy.
11. Reconciliation detects drift without moving money unexpectedly.
12. Rollback preserves already-created payment and wallet recovery.

## Release evidence

Before rollout:

- approved immutable image and source commit;
- exact rollback image and compatible schema phase;
- recent encrypted backup/restore proof where MySQL changes are involved;
- health, readiness, queue, worker, replay, storage, and dead-letter checks;
- direct Meta callback and expected Page binding;
- live and recurring billing flags in their reviewed state;
- provider hard limit and application spend caps;
- legal, privacy, receipt, support, and refund copy version;
- metadata-only monitoring and incident owner.

Use only the protected workflows in
[`operations/production-deployments.md`](operations/production-deployments.md).

## Evidence boundary

Allowed evidence includes commit/digest, deployment identity, random request
id, opaque subject hash, bounded outcome code, counts, timings, schema phase,
provider status class, and rollback result.

Never retain raw PSIDs, access tokens, checkout tokens, messages, prompts,
photos, generated images, media URLs, Mollie payloads, or payment credentials as
smoke evidence.
