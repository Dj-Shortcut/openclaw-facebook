# Production deployments

Production has one owner: the reviewed Git repository through the manually
dispatched `Deploy production` GitHub Actions workflow. `fly deploy` may replace
or update Machines; `fly machine run` is not a production deployment path.

## Ownership model

```text
reviewed main commit
  -> protected production approval
  -> one app-specific deploy token
  -> one canonical fly.toml
  -> fly deploy (one selected app)
  -> strict drift, Meta callback, health, and readiness checks
```

The contract lives in `deploy/production/apps.json`. It records the Fly app,
config file, process groups, desired scale, Machine ownership rule, service
check, reviewed rollback-image allowlist, and Meta callback expectations.
`npm run production:validate` checks the repository contract in PR CI. The
production workflow checks live drift before and after every deploy.

The image-gen HTTP service routes on `/healthz`, which proves that the process
can accept traffic. The scheduled GitHub monitor checks `/readyz` separately for
dependencies such as the image queue. Fly top-level readiness checks are not
used here because Fly halts a deploy when one fails. A dependency incident
therefore raises an alert without making Meta's webhook callback unreachable or
blocking a liveness-only recovery rollout.

## Required GitHub configuration

Create a protected environment named `production` with required reviewers and
restrict it to `main`. Add these environment secrets:

- `FLY_GATEWAY_DEPLOY_TOKEN`: limited to `leaderbot-openclaw-gateway`;
- `FLY_IMAGE_GEN_DEPLOY_TOKEN`: limited to `leaderbot-fb-image-gen`;
- `META_APP_ID` and `META_APP_SECRET`: used only to read and verify webhook
  subscriptions; values are never printed.

Keep the two Fly tokens separate. A compromised image-gen deployment must not
be able to mutate the stateful gateway, and vice versa.

The gateway currently has `deploymentEnabled: false`. This is an explicit
bootstrap gate, not an operator override: rehearse the volume migration and
prove the current managed release first, then add its immutable digest to
`reviewedRollbackImages` and set `deploymentEnabled: true` in the same reviewed
PR. Repository validation rejects enablement without that digest, and the
workflow rejects a blocked target before production approval or any Fly
mutation.

## Normal release

1. Merge a reviewed PR into `main` after CI passes.
2. Dispatch `Deploy production` and choose exactly one target.
3. Leave `rollback_image` empty for a normal source build, except while a target
   is explicitly marked `sourceDeployEnabled: false` in the manifest.
4. Approve the protected `production` environment.
5. Retain the uploaded release artifacts. They contain metadata for the release
   before and after deployment, an immutable `rollback-image.txt`, and the
   captured pre-release `before.fly.toml`; they contain no tenant content or
   secrets.
6. Complete the relevant live Messenger smoke test. For image generation, check
   both prompt-first generation and a source-photo edit while confirming quota
   enforcement remains active.

Pre-deploy drift that the selected `fly.toml` can safely reconcile is reported
as a warning. Detached Machines, unknown process groups, scale/VM drift, and
gateway volume drift stop the deployment. A previous image-gen digest is
permitted only during pre-deploy validation when it is explicitly listed in
`reviewedRollbackImages`; this lets a newly reviewed digest roll out without
making an arbitrary or known-bad current release rollback-safe. Post-deploy
digest drift is blocking. Before deployment, mutable Fly release tags are
resolved to one immutable digest and both the digest and active Fly
configuration are saved durably. Any failed deployment or post-deploy check
uses the job's explicitly reserved rollback budget to restore the captured,
allowlisted image, captured configuration, and explicit desired scale.

Image-gen is temporarily stricter: its production privacy-boundary release is
ahead of `main`, so the workflow requires an explicitly reviewed immutable
`registry.fly.io/leaderbot-fb-image-gen@sha256:...` value in `rollback_image`.
Do not re-enable image-gen source builds until that source has been reconciled,
tested, and reviewed. The pinned completion-readiness overlay exists only to
correct the release-344 nested-prefix scan without rebuilding older source.
The currently reviewed overlay digest is recorded in
`deploy/production/apps.json`; rollback artifacts captured after this repair
must point to that overlay or a later reviewed image, not unpatched release 344.
Before changing `reviewedImage`, add the previous digest to
`reviewedRollbackImages` only if it is independently known safe. Captured
image-gen rollback images are checked against the current reviewed image and
that allowlist before deployment starts, so release 344 can never become an
automatic rollback target.
The overlay depends on its pinned Fly registry base remaining available and
must be re-pinned for every legitimate image-gen release. The Leaderbot
production owner must reconcile the privacy-boundary source into `main` and
delete the overlay by 2026-09-30; `docs/operations/todo.md` tracks this removal.

The Meta callback check uses `META_GRAPH_VERSION` with an explicit `v21.0`
default. The production owner must review and bump that pin before Meta retires
v21.0 on 2027-01-21; do not rely on Meta's automatic version fallback. The
manifest also owns the complete allowed subscription-object and field set;
additional Meta objects or webhook fields are blocking scope drift and require
a reviewed manifest change.

## Rollback

Deployment or post-deploy verification failures start a bounded rollback step
in the already approved production job. It restores the exact immutable image
from `rollback-image.txt`, the captured `before.fly.toml`, and the manifest's
desired scale. Every preceding deployment step has a shorter explicit timeout;
their maximum combined budget leaves time inside the job limit for restoration
without a second production approval. The deploy job remains failed so the
incident is visible and its artifacts record both releases.

For a later manual gateway rollback, first add the captured immutable digest to
the gateway's `reviewedRollbackImages` in `deploy/production/apps.json` through
a reviewed PR. Then dispatch the same workflow and paste that exact reference
into `rollback_image`; arbitrary registry images are rejected. For image-gen,
promote the new release to `reviewedImage` and retain only independently
reviewed previous digests in `reviewedRollbackImages`. The workflow validates
both operator input and each image-gen pre-release capture before any deploy.
Approval, canonical configuration, drift checks, Meta verification, and smoke
checks still apply. Do not restore a release by starting an ad-hoc Machine.

## Stateful gateway exception

The gateway currently has important OpenClaw state on a Fly Volume. Do not
converge, destroy, or replace detached gateway Machines until the volume state
has been backed up, migration has been rehearsed on a copy, and the canonical
Machine-volume attachment is explicitly approved. The pre-deploy drift gate is
intentionally fail-closed while this remains unresolved.

Longer term, move gateway state into tenant-scoped durable storage so two or
more interchangeable gateway Machines can run without shared customer-content
paths or host-bound state. Terraform may own stable infrastructure resources,
but it must not co-own Machines that `fly deploy` manages.
