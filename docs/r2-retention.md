# R2 Retention Policy

This service uses Cloudflare R2 through the storage proxy for durable image URLs.
Application deletion still runs first, but R2 lifecycle rules are the retention
backstop for objects whose Redis/application state reference has been lost.

## Prefix Inventory

| Prefix | Classification | Active writer | Retention policy |
| --- | --- | --- | --- |
| `inbound-source/` | User-uploaded source images, including face-memory source photos | `server/_core/sourceImageStore.ts` | Expire after 30 days; this is the hard maximum |
| `generated/images/` | Generated image outputs returned to Messenger/WhatsApp | `server/_core/image-generation/generatedImagePublisher.ts` | Expire after 30 days |
| `generated/` | Generated outputs and possible legacy generated artifacts | No current R2 writer found for this parent prefix except `generated/images/`; examples/tests still reference older keys | Do not add a parent-prefix rule until production inventory confirms every child is safe to expire |

No active R2 writer was found for preview/style-catalog assets. The legacy
style-picker flow is deprecated, but the lifecycle policy intentionally targets
`generated/images/` first. Use a broader `generated/` rule only after a
production R2 inventory confirms that any legacy child folders under
`generated/` are disposable on the same retention schedule.

## Recommended Lifecycle Configuration

Use the checked-in Cloudflare lifecycle policy:

```bash
npx wrangler r2 bucket lifecycle set "$R2_BUCKET" \
  --file apps/image-gen/infra/cloudflare/r2-lifecycle.json
```

Then verify:

```bash
npx wrangler r2 bucket lifecycle list "$R2_BUCKET"
```

The policy intentionally uses prefix-scoped delete rules rather than an empty
prefix. Do not add a bucket-wide expiration rule unless the bucket is dedicated
only to short-lived image artifacts. Do not broaden `generated/images/` to
`generated/` without a production inventory of legacy children.

## Why Lifecycle Rules

Lifecycle rules are enforced by R2 at the bucket layer. They do not depend on
Redis state, application workers, queue health, or the storage proxy delete
endpoint. That makes them the safest backstop for orphaned objects.

Application-driven cleanup remains useful because user-initiated deletion should
attempt immediate removal. It is not sufficient as the only retention control
because it can only delete objects whose keys are still known to app state.

## Current Application Cleanup

- `delete-my-data` deletes state-referenced source and generated image URLs,
  generation completion metadata, legacy chat history, and then clears user
  state.
- Face-memory expiry runs on startup and every 24 hours. It deletes retained
  source photos and expired `inbound-source/` session images still referenced by
  state.
- Failed source-photo deletes leave retry markers so later expiry runs can retry
  every failed object delete.

These paths remain correct after lifecycle rules are added. Lifecycle expiration
is a backstop, not a replacement for immediate user deletion.

## User-Visible Impact

`inbound-source/` expiration is mandatory privacy enforcement. These objects are
user-uploaded source images, including face-memory source photos, and must not
survive indefinitely if Redis/application state is lost.

Thirty days is the hard maximum for uploaded source and face-memory objects.
`FACE_MEMORY_RETENTION_DAYS` may choose a shorter application retention window,
but values above 30 are clamped and must not be paired with a longer R2
lifecycle rule.

`generated/images/` expiration aligns product behavior with privacy-policy
language that generated outputs are retained only as long as needed. Generated
result links are temporary: after the retention window, old image URLs may stop
resolving in Messenger or WhatsApp conversations.

Current generation delivery, retry, and completion flows should not depend on
image objects older than 30 days. Before reducing this retention window or
adding gallery/history features, verify that no edit, retry, redelivery, or user
history flow needs older generated objects.

If a future gallery/history feature is added, it must define a separate
tenant-scoped retention model before storing images outside these prefixes or
changing this lifecycle policy.

## Backfill Plan

1. Apply `apps/image-gen/infra/cloudflare/r2-lifecycle.json` to the production
   R2 bucket.
2. List lifecycle rules and confirm `inbound-source/` and `generated/images/`
   are enabled with a 30-day age condition.
3. Wait for R2 lifecycle processing. Existing objects may not disappear
   immediately; Cloudflare documents lifecycle deletion as asynchronous after
   expiration.
4. Re-check sampled stale keys under `inbound-source/` and `generated/images/`.
5. If stale keys remain after lifecycle processing has had time to run, perform
   a one-time R2 inventory delete by prefix and age using Cloudflare/R2
   credentials outside the app runtime. Do not add broad R2 listing credentials
   to the image-gen app for this backfill.
