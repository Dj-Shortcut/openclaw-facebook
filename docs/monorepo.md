# Repository boundaries

The repository is in a controlled product simplification. `apps/image-gen` is
the only active product runtime. Other applications remain temporarily because
their production traffic, state, CI, or rollback obligations must be retired
safely.

## Active

### `apps/image-gen`

Owns:

- direct Meta Messenger ingress;
- conversation behavior and channel-neutral actions;
- image generation and editing;
- free user quota and target paid-credit wallet;
- consent, privacy, deletion, storage, and delivery;
- one-time Mollie checkout foundations;
- legal, health, readiness, and operational routes.

### `apps/image-gen/storage-proxy`

Owns the bounded R2 storage API and public asset boundary. It stays separate
until direct object-storage access can replace it without privacy or rollback
regressions.

### `deploy/production`

Owns reviewed deployment identity, immutable image selection, schema phase, and
rollback metadata.

## Legacy and frozen

### Root package and `src/`

The root package is the old OpenClaw Facebook plugin. It receives no new product
features. Keep it only until the OpenClaw Page callback and runtime are proven
retired, then remove the package, tests, release workflows, lockfile contracts,
and ClawHub artifacts together.

### `deploy/fly-gateway`

The old OpenClaw Fly gateway is retirement-only. Do not deploy or migrate it as
part of the active bot. Preserve only the metadata required to identify,
disable, back up where legally necessary, and remove its Machines, volume,
secrets, and Meta callback safely.

### `apps/customer-app`

The desktop customer portal belongs to the abandoned multi-tenant SaaS model.
Do not add features. Remove it after the active runtime no longer depends on its
contracts or workflows.

## Dependency direction

- Active runtime code must not import the root OpenClaw plugin.
- Legacy root code must not become an ingress or billing dependency for
  `apps/image-gen`.
- New shared code is extracted only when at least two active consumers need it.
- Do not create a generic platform package merely to preserve legacy code.

## Package managers

- `apps/image-gen`, storage proxy, and customer app use their checked-in pnpm
  lockfiles while they exist.
- The root npm package and compatibility lockfiles remain only until OpenClaw
  removal.
- Do not casually regenerate a lockfile owned by another package boundary.

## Removal rule

A legacy subtree is removed when:

1. production traffic is absent or migrated;
2. required data is deleted, retained, or exported under an explicit policy;
3. rollback no longer needs the subtree;
4. CI, workflows, manifests, secrets, and docs are updated together;
5. the active `apps/image-gen` build and tests pass without it.

Git history is the archive. Do not keep dead code or stale docs solely for
historical reference.
