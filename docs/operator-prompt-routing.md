# Operator Messenger Routing

This document defines the only supported production ownership model. Customer
traffic and the repository owner's personal OpenClaw traffic are separate Meta
app, Page, credential and runtime paths. Do not subscribe customer and personal
Pages through the same Meta app callback configuration.

## Customer path

```text
Customer Messenger Page
  -> Meta signed webhook
  -> apps/image-gen
  -> workspace resolution
  -> tenant conversation/image/quota/billing runtime
  -> Messenger renderer and Graph API
```

`apps/image-gen` owns the full customer turn before any customer state is read:

- webhook verification and authenticated Page identity;
- exact workspace and channel-connection resolution;
- consent, conversation state and channel-neutral actions;
- image generation/editing, storage and delivery;
- customer quota, entitlement and billing enforcement;
- export, deletion and privacy-safe observability.

A customer event must never be forwarded to OpenClaw, the personal gateway or
the legacy internal Leaderbot bridge. Missing, duplicate, inactive or changed
workspace ownership fails closed.

## Personal OpenClaw path

```text
Owner Messenger Page
  -> Meta signed webhook
  -> OpenClaw Facebook plugin
  -> paired/allowlisted personal OpenClaw turn
```

The checked-in Fly gateway is private and low priority. It stays on pairing (or
an explicit owner allowlist), keeps the Leaderbot bridge disabled, and exposes
only its own webhook and health routes. It does not proxy the customer portal,
reserve customer quota, run customer billing preflights or gate a Leaderbot
release.

The root plugin retains default-off bridge compatibility for older external
installs. That compatibility is not an approved Leaderbot customer route and
must not be enabled in the checked-in production gateway.

## Customer routing order

For each authenticated customer Meta delivery, `apps/image-gen` must:

1. verify the exact raw-body signature for the selected Meta channel;
2. resolve the receiving Page/phone binding to exactly one active workspace;
3. persist work only in that tenant/binding partition;
4. apply consent, deletion, quota and entitlement gates before provider work;
5. produce a channel-neutral conversation response;
6. render and deliver it at the Messenger edge;
7. finalize usage durably and retain metadata-only evidence.

No free-tier, entitlement or operator identity may substitute for workspace
resolution.

## Smoke evidence

Leaderbot release evidence covers the direct customer path only:

- canonical Meta verification and signed delivery on `apps/image-gen`;
- portal login and connection to the same workspace/Page;
- ordinary text, prompt-first image, source-photo edit and multi-photo flow;
- quota/exhaustion before provider work;
- consent grant, refusal and typed fallback;
- `delete-my-data`, queued-work cancellation and late-output suppression;
- delivery failure, retry/dead-letter visibility and rollback.

Personal OpenClaw smoke is independent: verify pairing/allowlist, one ordinary
owner message, `/healthz`, gateway shielding and rollback. Its failure does not
block a Leaderbot release unless a shared change caused a security or data-loss
regression.

Record only commit/digest, route outcome, random request identifiers, bounded
counts, durations and rollback metadata. Never record raw PSIDs, messages,
prompts, tokens, media URLs or generated/customer content.
