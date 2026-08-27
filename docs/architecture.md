# Architecture

## Product boundary

Leaderbot is a single-owner commercial Messenger bot serving many end users.
The owner operates the Page, infrastructure, offer catalog, provider accounts,
budgets, legal copy, and support. End users receive isolated conversation,
privacy, quota, purchase, and credit state.

This is not a multi-tenant bot platform. An internal owner/workspace boundary
remains as a safety and migration partition, but external customers do not
provision their own Pages, instructions, billing accounts, or workspaces.

## Target request flow

```text
Messenger user
    |
    v
Meta Page webhook
    |
    v
signature + replay + Page-binding checks
    |
    v
pseudonymous conversation subject
    |
    v
conversation layer
    |-------------------------------|
    v                               v
free allowance                 paid credit wallet
    |                               |
    |-------------------------------|
                    |
                    v
          generation reservation
                    |
                    v
             image provider
                    |
                    v
       durable output + Messenger send
                    |
                    v
       quota/credit finalization
```

The webhook process acknowledges safely without holding the Meta request open
for image generation. Redis-backed queue workers own expensive provider work
and durable completion.

## Identity model

The stable domain identity is `ConversationSubjectV2`, derived from:

- internal owner/workspace id;
- channel connection id;
- Messenger Page binding;
- channel;
- raw sender id;
- versioned HMAC key.

Only resulting opaque keys may appear in state, queue, quota, wallet, and
operational metadata. Raw PSIDs remain at the transport boundary and must not be
logged or copied into payment metadata.

Privacy epochs fence deleted identities from old jobs and late provider output.
A reconnect or Page rebinding must not move balance or media to a new subject
without an explicit migration.

## Conversation boundary

Conversation logic returns channel-neutral responses:

```ts
type ConversationResponse = {
  text?: string;
  images?: ImageOutput[];
  actions?: ConversationAction[];
};
```

It owns intent, consent, state transitions, balance messaging, and the decision
to offer checkout. It does not create Messenger template payloads or Mollie
payments.

The Messenger adapter parses inbound events and renders text, images, and
actions. A checkout action becomes a Messenger URL button pointing to a
short-lived signed web handoff.

## Free quota

Free quota is an abuse- and cost-control allowance, not a monetary wallet.

- It is scoped to the exact conversation subject.
- It resets using the configured product calendar.
- Admission is decided before provider work.
- Consumption commits only at the documented successful output boundary.
- Duplicate requests and retries cannot consume twice.
- Exhaustion returns the next reset and, when commercially enabled, the
  one-time premium offer.

## Purchased credits

Purchased credits are a durable, append-only accounting domain separate from
free quota.

Target records:

- `credit_wallets`: current projection per privacy subject and unit type;
- `credit_ledger`: immutable grants, commits, releases, refunds, expirations,
  and operator adjustments;
- `credit_reservations`: short-lived idempotent holds for generations;
- `checkout_intents`: offer snapshot, pseudonymous binding, nonce, expiry,
  provider payment id, and state.

The ledger is authoritative; wallet balance is a transactionally maintained
projection. Purchased balance must never be an increment on the free daily
counter.

Payment flow:

```text
quota exhausted
-> user selects checkout action
-> signed handoff opens product summary
-> user explicitly confirms order and payment
-> server creates one Mollie one-off payment
-> Mollie checkout
-> Mollie webhook/status verification
-> idempotent credit grant
-> return page displays verified status
```

The browser return never grants credits. The trusted payment path verifies the
provider state and atomically links one payment to one immutable grant.

## Premium quality

Quality is selected from a server-owned offer snapshot. A paid bundle may map
to a higher-quality provider mode than the free path, but the mapping is
versioned so existing purchases retain their promised value.

Provider cost varies by model, size, quality, edits, and input images. Global
and per-user spending caps remain active even when the wallet contains credits.
Changing quality or model requires updated unit economics and failure-path
tests.

## Data stores

### Redis

- webhook replay protection;
- queue, leases, and deduplication;
- conversation state where configured;
- free quota and short-lived reservations;
- rate limits.

Production paths fail closed when atomic Redis behavior is required and Redis
is unavailable.

### MySQL

- privacy and Page-binding records;
- durable checkout and payment records;
- target paid-credit ledger and wallet projection;
- accounting and reconciliation metadata;
- legally required retention boundaries.

### Object storage

- source images and generated outputs;
- owner/Page/privacy-subject scoped object keys;
- documented retention and deletion;
- no public listing or broad operator content access.

## HTTP surfaces

Active or target public surfaces:

- `/facebook/webhook` as the canonical direct Messenger callback;
- `/healthz`, `/readyz`, version, and metrics endpoints;
- legal and data-deletion pages;
- a minimal checkout, return, and receipt surface;
- generated asset delivery through the reviewed storage boundary.

The target product does not expose a customer workspace portal, OpenClaw
gateway, pairing UI, admin content browser, or subscription management page.

## Transitional architecture

The repository still contains:

- a root OpenClaw Facebook channel and personal gateway;
- a multi-tenant portal and customer desktop app;
- workspace subscription and Startpilot billing code;
- recurring Mollie workers and subscription tables;
- optional WhatsApp and video paths.

These are implementation facts, not target product commitments. The generic
OpenClaw channel is intended to move to a standalone project, preserving the
package identity `@dj-shortcut/facebook`, channel id `facebook`, and its ClawHub
entry. The root copy is removed only after standalone build, install, release,
and rollback paths are proven. The Leaderbot runtime must never depend on it.

WhatsApp and video are non-blocking capabilities. Do not extend their commercial
credit behavior until the Messenger one-time purchase journey is proven.

## Failure model

Every commercial path defines behavior for:

- duplicate Meta events;
- duplicate checkout clicks;
- payment webhook replay or reordering;
- browser return before webhook delivery;
- provider timeout or ambiguous result;
- Messenger delivery failure;
- process crash after reservation or provider success;
- refund after partial credit use;
- `delete-my-data` during checkout or generation;
- Page disconnect or privacy epoch change;
- Redis, MySQL, Mollie, storage, or provider outage.

The safe default is to stop new paid work, preserve auditable metadata, avoid a
double grant or double charge, and present a recoverable user state.

## Observability

Logs and metrics contain only opaque request ids, bounded counters, durations,
provider outcome classes, wallet operation types, and deployment metadata.
They never contain prompts, messages, images, raw user ids, checkout tokens,
payment credentials, or secrets.

## Deployment

Production uses immutable reviewed artifacts, schema contracts, readiness
checks, rollback images, and protected workflows. Keep those controls during
simplification.

Operational details live in
[`operations/production-deployments.md`](operations/production-deployments.md).
