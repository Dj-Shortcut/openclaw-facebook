# Repository boundaries

The repository is in a controlled product simplification. `apps/image-gen` is
the only active Leaderbot product runtime. Other applications remain
temporarily because traffic, state, release, or rollback obligations must be
retired safely.

## Active

### `apps/image-gen`

Owns direct Messenger ingress, conversation behavior, image generation, free
quota, the target paid wallet, consent, privacy, deletion, storage, delivery,
one-time Mollie foundations, and minimal legal/checkout/operational routes.

### `apps/image-gen/storage-proxy`

Owns the bounded R2 storage API and public asset boundary. It stays separate
until direct storage access can replace it without privacy or rollback
regressions.

### `deploy/production`

Owns reviewed deployment identity, immutable image selection, schema phase, and
rollback metadata.

## Transitional and frozen

### Root package and `src/`

The root package is the generic OpenClaw Facebook channel, not a Leaderbot
runtime dependency. It receives no new Leaderbot product features. Extract it
to a standalone project while preserving package `@dj-shortcut/facebook`,
channel id `facebook`, install validation, and the ClawHub entry. Remove the
root copy only after the standalone build, release, rollback, and channel-index
route are proven.

### `deploy/fly-gateway`

The personal OpenClaw Fly gateway is retirement-only. Preserve only the
metadata needed to identify, disable, retain or delete data, and remove its
Machines, volume, secrets, and Meta callback safely.

## Dependency direction

- Active runtime code must not import the root OpenClaw plugin.
- The root plugin must not become an ingress or billing dependency for
  `apps/image-gen`.
- New shared code is extracted only when at least two active consumers need it.
- Do not create a generic platform package merely to preserve legacy code.

## Package managers

- `apps/image-gen` and storage proxy use their checked-in pnpm lockfiles.
- The root npm package and compatibility lockfiles remain until plugin
  extraction is complete.
- Do not regenerate a lockfile owned by another package boundary casually.

## Removal rule

A legacy subtree is removed when:

1. production traffic is absent or migrated;
2. required data is deleted, retained, or exported under an explicit policy;
3. rollback no longer needs the subtree;
4. CI, workflows, manifests, secrets, and docs are updated together;
5. the active `apps/image-gen` build and tests pass without it.

Git history is the archive. Do not keep dead code or stale docs solely for
historical reference.
