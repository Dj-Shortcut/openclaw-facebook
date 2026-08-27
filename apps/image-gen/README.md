# Leaderbot Runtime

`apps/image-gen` is the active Leaderbot application. It receives Meta webhook
events, resolves the exact Page and pseudonymous user, runs conversation and
image-generation flows, and renders the result back to Messenger.

The product has one commercial owner and many end users. It is being simplified
from a tenant SaaS into a direct public bot with free daily usage and optional
one-time premium credit bundles.

## Status

Already present:

- direct Messenger webhook verification and signed event ingestion;
- prompt-first text-to-image and source-photo editing;
- queue, replay protection, state, consent, deletion, storage, and delivery;
- per-user free image quota and global cost guards;
- Mollie one-time payment primitives, payment ledger, and reconciliation;
- channel-neutral conversation actions.

Still to be implemented or migrated:

- a durable purchased-credit wallet per Messenger privacy subject;
- a quota-exhaustion checkout action;
- a short-lived signed checkout handoff for the exact user and offer;
- atomic paid-credit reservation, commit, release, refund, and adjustment;
- premium provider quality bound to server-owned offer policy;
- removal of workspace subscriptions, recurring workers, tenant provisioning,
  and the customer portal.

Do not describe these target items as live before the corresponding tests and
production evidence exist.

## Runtime shape

```text
Meta Messenger
    |
    v
/facebook/webhook
    |
    v
verified Page + pseudonymous conversation subject
    |
    v
conversation layer
    |----------------------|
    v                      v
free daily allowance   purchased credit wallet (target)
    |----------------------|
               |
               v
       generation queue/worker
               |
               v
          image provider
               |
               v
       storage and Messenger delivery
```

The HTTP process also serves health, readiness, legal, checkout/return, and
operational routes. MySQL-backed tenant portal and recurring billing routes are
legacy migration debt, not the target product boundary.

## Important modules

- `server/_core/runtime/webhookRuntime.ts`: webhook route composition.
- `server/_core/messengerWebhook.ts`: Messenger verification and ingress.
- `server/_core/conversationSubject.ts`: scoped pseudonymous identity.
- `server/_core/sharedTextHandler.ts`: channel-neutral text behavior.
- `server/_core/webhookGenerationJobs.ts`: generation admission and completion.
- `server/_core/messengerImageQuotaStore.ts`: free per-user image quota.
- `server/_core/generationGuard.ts`: provider concurrency and budget guard.
- `server/_core/dataDeletionService.ts`: user erasure orchestration.
- `server/_core/billing`: Mollie and legacy billing implementation.
- `server/_core/botResponse.ts`: channel-neutral response contract.

## Credit invariants

Free allowance and purchased credits are different balances:

- free allowance resets on the configured `Europe/Brussels` calendar;
- purchased credits must not reset with the free balance;
- a purchase belongs to one exact Page-bound pseudonymous user;
- a payment creates at most one immutable grant;
- a generation reserves before provider work and commits on one documented
  successful delivery boundary;
- rejection, provider failure, duplicate events, timeout, and cancellation
  release or safely reconcile the reservation;
- deletion removes eligible product data without corrupting legally retained
  payment records;
- refunds use explicit ledger adjustments, never history rewrites.

The offer catalog is server owned. Clients may submit only an offer code and
cannot override price, quantity, currency, model, or quality.

## State and privacy

Production state uses Redis and MySQL where required. Keys and rows must remain
scoped to the owner/workspace, channel connection, Page binding, privacy epoch,
and pseudonymous user key.

Never log raw PSIDs, messages, prompts, media URLs, generated images, access
tokens, Mollie credentials, or checkout tokens. Use bounded metadata and opaque
request identifiers.

Optional face memory remains disabled until its consent, retention, deletion,
and legal requirements are approved. See [`../../docs/face-memory.md`](../../docs/face-memory.md).

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

Run from this directory, or use `pnpm --dir apps/image-gen <command>` from the
repository root.

Start the development server:

```bash
pnpm dev
```

The full environment inventory is in `.env.example`; the operational minimum
is in
[`../../docs/operations/ENV_SHORTLIST.md`](../../docs/operations/ENV_SHORTLIST.md).

## Verification expectations

Always run targeted tests for changed modules. Run the complete suite when
changing webhook routing, conversation behavior, identity, quota, payments,
wallets, generation, storage, deletion, or delivery.

Production work additionally requires:

- immutable artifact build and attestation;
- schema compatibility and restore evidence;
- direct Messenger smoke;
- payment and wallet idempotency proof in Mollie Test Mode;
- rollback evidence;
- metadata-only observability verification.

The active order of work is
[`../../docs/operations/todo.md`](../../docs/operations/todo.md).
