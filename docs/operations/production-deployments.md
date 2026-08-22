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
check, and Meta callback expectations. `npm run production:validate` checks the
repository contract in PR CI. The production workflow checks live drift before
and after every deploy.

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

## Normal release

1. Merge a reviewed PR into `main` after CI passes.
2. Dispatch `Deploy production` and choose exactly one target.
3. Leave `rollback_image` empty for a normal source build, except while a target
   is explicitly marked `sourceDeployEnabled: false` in the manifest.
4. Approve the protected `production` environment.
5. Retain the uploaded release artifact. It contains metadata for the release
   before and after deployment plus `rollback-image.txt`; it contains no tenant
   content or secrets.
6. Complete the relevant live Messenger smoke test. For image generation, check
   both prompt-first generation and a source-photo edit while confirming quota
   enforcement remains active.

Pre-deploy drift that the selected `fly.toml` can safely reconcile is reported
as a warning. Detached Machines, unknown process groups, or scale/VM drift stop
the deployment. Gateway volume drift and image-gen digest drift are always
blocking. Post-deploy drift is always blocking and automatically redeploys the
captured pre-release image plus the explicit desired scale before the job exits
failed.

Image-gen is temporarily stricter: its production privacy-boundary release is
ahead of `main`, so the workflow requires an explicitly reviewed immutable
`registry.fly.io/leaderbot-fb-image-gen@sha256:...` value in `rollback_image`.
Do not re-enable image-gen source builds until that source has been reconciled,
tested, and reviewed. The pinned completion-readiness overlay exists only to
correct the release-344 nested-prefix scan without rebuilding older source.
The currently reviewed overlay digest is recorded in
`deploy/production/apps.json`; rollback artifacts captured after this repair
must point to that overlay or a later reviewed image, not unpatched release 344.

## Rollback

Post-deploy verification failures automatically restore the exact image from
`rollback-image.txt` and the manifest's desired scale. The workflow remains
failed so the incident is visible and its artifact records both releases.

For a later manual gateway rollback, dispatch the same workflow and paste the
captured image reference into `rollback_image`. For image-gen, first promote the
rollback digest to `reviewedImage` in `deploy/production/apps.json` through a
reviewed PR; the workflow rejects every other digest. Approval, canonical
configuration, drift checks, Meta verification, and smoke checks still apply.
Do not restore a release by starting an ad-hoc Machine.

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
