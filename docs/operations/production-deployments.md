# Production deployments

Production has one owner: the reviewed Git repository through the manually
dispatched `Deploy production` GitHub Actions workflow. `fly deploy` may replace
or update Machines. Operators never use `fly machine run` as a deployment or
migration shortcut. Only the protected schema workflow may create its one
temporary, no-DNS Machine to prove that a fresh database snapshot restores.

## Ownership model

```text
reviewed main commit
  -> protected production approval
  -> trusted, attested artifact
  -> reviewed immutable digest in the manifest
  -> one app-specific deploy token and canonical fly.toml
  -> deploy one selected app
  -> strict drift, Meta callback, health, and readiness checks
```

The contract lives in `deploy/production/apps.json`. It records the Fly app,
config file, process groups, desired scale, Machine ownership rule, service
check, reviewed rollback-image allowlist, and Meta callback expectations.
`npm run production:validate` checks the repository contract in PR CI. The
production workflow checks live drift before and after every deploy.

Every workflow job that can receive a Fly API token installs the same reviewed
`flyctl` binary without a remote setup action or install script. Version
`0.4.85` is downloaded only from
`https://github.com/superfly/flyctl/releases/download/v0.4.85/flyctl_0.4.85_Linux_x86_64.tar.gz`
and must match SHA-256
`c3b5ed05319adf8a265d68171758ea7b37bd340c5c3dc4e09e17fb6344b8ff90`
before it is extracted or added to `PATH`. GitHub reports the v0.4.85 release as
`immutable: false`, so the version tag and release URL are not trusted by
themselves. The repository validator rejects the setup action, resolver install
URLs, another platform or version, a changed digest, verification after
extraction, and every Fly-token job without this exact installer.

The image-gen HTTP service routes on `/healthz`, which proves that the process
can accept traffic. The scheduled GitHub monitor checks `/readyz` separately for
dependencies such as the image queue. Fly top-level readiness checks are not
used here because Fly halts a deploy when one fails. A dependency incident
therefore raises an alert without making Meta's webhook callback unreachable or
blocking a liveness-only recovery rollout.

The storage-proxy Fly app separately requires the runtime secret names
`STORAGE_RATE_LIMIT_REDIS_URL` and `STORAGE_RATE_LIMIT_KEY_SECRET`. The Redis
endpoint must be private and shared by every proxy Machine; the key secret must
contain at least 32 random bytes. Never put either value in repository or CI
logs. Startup and `/readyz` prove the shared limiter, while `/healthz` remains a
liveness-only signal. The deploy, rollback/recovery, and scheduled uptime gates
check `/readyz` separately. Storage operations fail closed when the limiter
cannot be reached.

## Required GitHub configuration

Protect `main` with a repository ruleset that requires a pull request and the
repository's exact CI checks. Keep force-pushes and deletion blocked. The
production workflows and validator paths must be covered by those checks; a
workflow change may not silently skip its own CI.

Create a protected environment named `production` with required reviewers,
administrator bypass disabled, and access restricted to protected `main`. Add
these environment secrets:

- `FLY_GATEWAY_DEPLOY_TOKEN`: limited to `leaderbot-openclaw-gateway`;
- `FLY_IMAGE_GEN_DEPLOY_TOKEN`: limited to `leaderbot-fb-image-gen`;
- `FLY_STORAGE_PROXY_DEPLOY_TOKEN`: limited to `leaderbot-storage-proxy`;
- `FLY_DATABASE_MIGRATION_TOKEN`: limited to snapshot, temporary restore-volume,
  restore-probe, and reviewer-approved orphan-cleanup operations for
  `leaderbot-portal-mysql`;
- `IMAGE_GEN_DATABASE_MIGRATION_URL`: `127.0.0.1:13306` URL for the dedicated
  expand principal;
- `META_APP_ID` and `META_APP_SECRET`: used only to read and verify webhook
  subscriptions; values are never printed.

Create a second environment named `production-inspection`, limited to protected
`main`, with no reviewer or wait timer and with administrator bypass disabled.
It contains only `FLY_PRODUCTION_READONLY_TOKEN`, an expiring Fly organization
read-only token. The early safety gate may use it only for metadata-only config,
release, image, Machine, and scale reads. It must never use logs, SSH, volumes,
secrets, or customer-content paths. This gate runs before a queued production
approval can block an older recovery.

Create a third environment named `production-recovery`, also limited to
protected `main`, with no reviewer or wait timer and with administrator bypass
disabled. Recovery must be able to start automatically after a failed or
cancelled deployment; adding a human approval here can leave a failed release
live and let a waiting deployment block its repair. Add separate app-scoped
`FLY_GATEWAY_RECOVERY_TOKEN`, `FLY_IMAGE_GEN_RECOVERY_TOKEN`,
and `FLY_STORAGE_PROXY_RECOVERY_TOKEN` secrets.
Add `FLY_RECOVERY_READONLY_TOKEN` as a separate expiring Fly
organization-readonly token. Successor checks may use it only for metadata-only
config, release, image, Machine, and scale reads; it receives no deployment,
database, log, SSH, volume, secret, or customer-content access.
`production-recovery` contains only these three app rollback tokens and this one
metadata token. Never add a database-app write token, database URL, SQL
credential, or `FLY_DATABASE_MIGRATION_TOKEN` to this reviewerless environment.
Automatic app recovery receives no SQL credential or database URL. Image-gen
rollback compatibility is proven from the immutable
`rollback-schema-phase.txt` artifact, the exact interrupted manifest-bound
schema phase, and that manifest's reviewed rollback-image compatibility map.
Those checks expose metadata only and cannot inspect customer tables, views,
triggers, messages, or other tenant content.

Create a fourth environment named `production-schema-cleanup`, limited to
protected `main`, with no reviewer or wait timer and with administrator bypass
disabled. It contains only `FLY_DATABASE_MIGRATION_TOKEN`, scoped to the exact
restore-probe Machine and volume cleanup operations for
`leaderbot-portal-mysql`. The manual janitor may enter this environment only in
its mutation job after its separate reviewer-gated `production` approval job
has succeeded. Never put this database write token in `production-recovery`.

Every durable rollback plan contains `recovery-protocol.txt` with exact value
`v1`. Recovery first copies and hashes the dependency-free controller from the
current protected workflow commit, then checks out the interrupted commit only as manifest/configuration data. It never executes the interrupted commit's
validator. Protocol v1 must remain supported for at least the full 30-day
rollback-artifact retention window; an absent or unknown protocol blocks before
any production Fly credential or mutation is exposed. Recovery scale counts are
derived only from the exact v1-validated interrupted manifest, never from hardcoded counts in the current workflow.

The orphan schema-probe janitor is `workflow_dispatch` only. It rejects every
non-main ref and completes a reviewer-gated `production` approval job before
its separate mutation job enters the shared image-gen lock. The mutation job is
bound to the protected-main, reviewerless `production-schema-cleanup`
environment only after that approval dependency completes, and only then can
expose its narrowly scoped database migration token and enter the shared lock.
This avoids both an unapproved lock holder and a second approval wait while the
lock needed by automatic recovery is held. It has no `workflow_run`, schedule,
or reviewerless trigger path that can skip the approval job. The protected
schema-transition job still runs its own bounded `if: always()` cleanup inside
the already approved production job; use the manual janitor only when runner
loss leaves an identified orphan.

Keep deploy, database, and recovery Fly tokens separate. An app token must not
be able to change another app or the database recovery volume. Rotate a token
by creating the replacement at the provider, updating only its environment
secret, completing a no-mutation validation, and then revoking the old token.
Never print a token during creation or verification.

Before every production release, verify through the GitHub environment API or
Settings UI that `production` still requires its reviewer and has no
administrator bypass, while
`production-inspection` and `production-recovery` have protected-main access,
no reviewer, no wait timer, and no administrator bypass. Also verify that the
inspection environment contains only its read-only Fly token. Verify that
`production-schema-cleanup` also has protected-main access, no reviewer, no wait
timer, no administrator bypass, and only its narrowly scoped database migration
token. Treat any drift as a release blocker.

Use three exact MySQL principals for the production schema, with no global or
grant-option privileges:

- runtime: exactly `SELECT, INSERT, UPDATE, DELETE`;
- expand migration: exactly `CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES,
SELECT, INSERT, UPDATE`;
- persistent trigger definer: table-level `SELECT, TRIGGER` on
  `billing_outbox` and table-level `SELECT, UPDATE, TRIGGER` on
  `billing_scheduler_tenants`, with no rights on any other table.

After creating or rotating the runtime or expand principal, run its matching
protected inspection mode; the migrator rejects missing and excessive grants.
Inspect the trigger-definer grants privately with the database administrator,
then require the automatic runtime trigger probe below. Bootstrap/contract DDL
credentials are not application or 0016-expand credentials and stay outside
these workflows. No MySQL principal is provisioned to automatic no-review
application recovery.

The trigger definer is a non-runtime executor for the three contract-pinned
billing triggers. Its complete privilege set is table-level `SELECT, TRIGGER`
on `billing_outbox` plus table-level `SELECT, UPDATE, TRIGGER` on
`billing_scheduler_tenants`. It has no rights on any other table and does not
have `INSERT`, `DELETE`, DDL, a schema/global privilege or grant option. Never
add `TRIGGER` to the application runtime principal. Keep the expand principal
separate so its temporary migration rights can be removed without disabling an
already installed trigger.

Before an image-gen rollout, the protected deployment extracts the reviewed
probe from the candidate image, uploads it to one exact started app Machine,
and runs it with that Machine's DML-only runtime identity. The probe locks one
test-mode outbox scheduler row, performs a no-change scheduler update, inserts
and updates one synthetic outbox row with explicit ID `0` under the
connection-local `NO_AUTO_VALUE_ON_ZERO` SQL mode, then rolls the transaction
back and proves the synthetic row is absent. This defined MySQL mode stores
zero instead of allocating a sequence value. The disposable-MySQL regression
also proves the persistent InnoDB auto-increment counter is identical before
and after. This activates all three billing triggers without a Mollie call,
durable row or sequence mutation. The uploaded probe is removed before the
rollout. Any trigger-definer privilege failure therefore blocks before a
Machine is replaced.

If this probe reports `scheduler_update_trigger`, `outbox_insert_trigger` or
`outbox_update_trigger`, stop the release. Never repair it by adding `TRIGGER`
to the runtime account. Before changing a definer, a reviewer-approved database
administrator must privately confirm a recoverable encrypted database snapshot
has status `created`, commercial billing remains disabled, the schema contains
exactly the three contract trigger names, and their metadata plus bodies match
`0015_production_readiness_registry.sql`.

When those triggers currently name the runtime account as their definer, the
administrator must create one separate non-runtime account, lock it against
login, and grant it only table-level `SELECT, TRIGGER` on `billing_outbox` and
table-level `SELECT, UPDATE, TRIGGER` on `billing_scheduler_tenants`, without
rights on any other table, schema/global privileges or grant option. Using a
separately authenticated administrator with the required definer authority,
recreate all three exact checked-in triggers with that account as their
explicit definer in one reviewed maintenance transition. Keep the runtime
account at exactly `SELECT, INSERT, UPDATE, DELETE`; do not reuse the expand
principal as the persistent definer. MySQL account locking blocks login but
does not disable execution of stored objects that name the locked account as
definer.

After the transition, privately prove that all three triggers name exactly that
one locked account and that its only effective object grants are the two exact
table-level sets above. Do not print the account name, grant output or
connection URL. Run the normal runtime/expand schema inspection and the runtime
trigger probe before another deploy, and retain the evidence as metadata only.
That schema inspection deliberately omits privileged trigger metadata, while
bootstrap inspection requires each trigger definer to equal the connected
bootstrap principal. It therefore cannot certify this locked, separate
definer. For this transition, the required replacement gate is the private
three-trigger metadata/body tuple plus exact two-table grant check above,
followed by the DML runtime probe. Do not claim that a bootstrap inspection
under the administrator or expand account verified this boundary. Any body,
SQL-mode, definer, grant or probe mismatch is a failed transition and must be
restored from the reviewed trigger definitions or the pre-change snapshot
before billing is enabled.

The gateway currently has `deploymentEnabled: false`. This is an explicit
bootstrap gate, not an operator override: both the workflow and the canonical
package script reject it. Rehearse the volume migration and prove the current
managed release first. Adding a digest and changing the flag is deliberately
not enough to enable it. A later, separately reviewed transition must define a
manifest-bound bootstrap/rebaseline from the proven live identity, use an
attested artifact built from fully pinned inputs, bind the approved volume and
Machine configuration, and update the validator plus negative tests in the same
PR. Until that complete transition exists, the workflow rejects the target
before production approval or any Fly mutation.

## Normal release

1. Merge a reviewed PR into `main` only after CI passes.
2. For image-gen or storage-proxy, dispatch `Build trusted production artifact`
   for the exact target. The workflow builds from that reviewed `main` commit,
   checks it, pushes an immutable digest, and records a GitHub attestation.
3. Put that exact digest, its source commit, and its artifact kind in
   `deploy/production/apps.json` through a second reviewed PR. The validator
   rejects an untrusted digest or an unsafe transition state.
4. Dispatch `Deploy production`, choose exactly one target, and supply the exact
   reviewed digest when the workflow requests `rollback_image`.
5. Approve the protected `production` environment. A green build does not
   override `deploymentEnabled: false`; a blocked target stays blocked.
6. Retain the uploaded release artifacts. They contain metadata for the release
   before and after deployment, an immutable `rollback-image.txt`, and the exact
   checked-in reviewed rollback config copied to `before.fly.toml`. Image-gen's
   plan also contains `rollback-schema-phase.txt`, captured from the exact
   reviewed manifest only after the rollback image is proven compatible with
   that phase. These artifacts contain no tenant content or secrets. A live Fly
   config is evidence only and is never trusted as rollback input.
7. Complete the relevant live Messenger smoke test. For image generation, check
   both prompt-first generation and a source-photo edit while confirming quota
   enforcement remains active.

Image-gen keeps `/healthz` as its liveness diagnostic and also configures
`/readyz` as a Fly service check for traffic readiness. Operational billing
therefore needs its initial scheduler heartbeats within the 45-second readiness
grace; a missing database, schema, lane or heartbeat keeps the Machine out of
service. The external uptime workflow checks both endpoints independently.

### Storage-proxy immutable release

The storage proxy is an independent production app. Never build or deploy it
locally.

1. Dispatch `Build trusted production artifact` with `storage-proxy` from a
   reviewed `main` commit.
2. Review the attested digest and record it in the manifest with transition
   state `runtime_reviewed`. For the first trusted rollout, retain only the exact
   proven legacy image as rollback.
3. Merge that manifest PR through green CI, then dispatch `Deploy production`
   with `storage-proxy` and the exact reviewed digest.
4. The workflow verifies the artifact's source and attestation, captures the
   previous image and Fly config, checks live drift, deploys the digest, and
   tests `/healthz`. On failure it restores and verifies the captured release.

The currently recorded storage-proxy `reviewedImage` is also its current live
rollback image. Replace `reviewedImage` with the newly built digest only after
the reviewed merge has produced that immutable artifact; do not replace it with
a mutable tag.

### Image-gen database migration gate

Production moves only from `0015_base` to the backwards-compatible
`0016_expand` shape. Migration 0017 is blocked. There is no production contract
command, manifest switch, or operator environment variable that may enable it.
A later 0017 rollout needs a separate design and review.

Use this exact sequence:

1. **Build the bridge.** Dispatch `Build trusted production artifact` with
   `image-gen-bridge`. The workflow proves that the bridge keeps the exact live
   application runtime, works with both 0015 and 0016, and attests both its
   reviewed source and exact legacy base image.
2. **Review and deploy the bridge.** Record its digest and source commit in the
   manifest with state `bridge_reviewed`. After green CI, deploy that exact
   digest through `Deploy production`. Prove every app and worker Machine runs
   it.
3. **Freeze deploys.** In a new reviewed PR, set state `expand_pending`, disable
   application deploys, and keep only the bridge as the recovery image.
4. **Back up and prove recovery.** Dispatch
   `Apply reviewed image-gen schema expand`. The protected workflow first checks
   that every Machine is the attested bridge. It creates a fresh encrypted
   snapshot, restores it into an isolated encrypted volume, runs MySQL checks,
   and removes the temporary restore volume. It records metadata only, never
   customer rows.
5. **Apply only 0016.** The same workflow runs `apply-expand` and then verifies
   `0016_expand` from an exact bridge worker. It cannot apply 0017. If the known
   0016 sequence was interrupted, rerun this same protected workflow with the
   exact prior run ID and run attempt that uploaded its pre-expand evidence.
   The workflow accepts that evidence only when its snapshot, database,
   migration-manifest, schema-contract, and bridge tuple still match. Unknown
   or partial shapes fail closed.
6. **Build the runtime.** Record the successful expand phase and state
   `runtime_build_pending` in a reviewed PR. Then dispatch
   `Build trusted production artifact` with `image-gen-runtime`. The build must
   reject 0015, accept 0016, and produce a trusted attestation.
7. **Review and deploy the runtime.** Record that exact digest and source commit
   with state `runtime_reviewed`, retain the bridge as the only rollback, and
   enable deployment in a reviewed PR. After green CI, deploy it through
   `Deploy production`, prove every Machine switched, and complete both image
   smoke tests.

Do not type migration commands into a production shell and do not start an
ad-hoc migration Machine. Normal releases use the image's compatibility check;
the protected schema workflow is the only production path that changes this
database.

Application rollback leaves the successfully applied schema in place and may
use only an image explicitly reviewed for that phase. Never blindly restore a
pre-migration snapshot after production writers continued: that would silently
discard later writes. A production restore requires point-in-time recovery to a
verified boundary, or a coordinated writer pause with a durable buffer and a
proven replay plan. Otherwise preserve the database and recover forward.

### Messenger queue two-phase rollout

The queue namespace switch is two releases, never one mixed code/config change.

Phase A — bridge image, v1 writes:

1. Build and review the bridge image that reads both v1 and v2.
2. Set image-gen `reviewedImage` to that exact digest. Keep the last proven live
   v1 image in `reviewedRollbackImages` for this phase only.
3. Add the bridge digest to `generationQueueV2ReaderImages`.
4. Keep both `generationQueueWriteVersion` in the manifest and
   `MESSENGER_GENERATION_QUEUE_WRITE_VERSION` in `apps/image-gen/fly.toml` on
   `v1`.
5. Deploy, then confirm every app and worker Machine runs the bridge digest.
   Check health, readiness, v1+v2 queue counts, processing leases, dead letters,
   privacy erasure, and normal image delivery before continuing.

Phase B — config-only v2 activation:

1. Use the same fully deployed bridge digest; do not include application-code
   changes.
2. In one reviewed PR, change both queue write-version fields to `v2`.
3. Remove every older v1-only digest from `reviewedRollbackImages`. Every digest
   that remains in `reviewedImage` or `reviewedRollbackImages` must also appear
   in `generationQueueV2ReaderImages`; repository validation blocks otherwise.
4. Deploy and repeat the queue and delivery checks.

A Phase-A failure may restore the captured older v1 image because producers
still write v1. After Phase B starts, the rollback floor is the bridge image:
restore that same dual-reader image with the captured v1 write configuration.
Never restore a v1-only reader after any v2 job may have been accepted.

Pre-deploy drift that the selected `fly.toml` can safely reconcile is reported
as a warning. Detached Machines, unknown process groups, scale/VM drift, and
gateway volume drift stop the deployment. A previous image-gen digest is
permitted only during pre-deploy validation when it is explicitly listed in
`reviewedRollbackImages`; this lets a newly reviewed digest roll out without
making an arbitrary or known-bad current release rollback-safe. Post-deploy
digest drift is blocking. Before deployment, mutable Fly release tags are
resolved to one immutable digest. The active image and identity must match the
reviewed rollback config already committed for that digest. Any failed
deployment or post-deploy check uses the job's explicitly reserved rollback
budget to restore the allowlisted image, reviewed configuration, and explicit
desired scale.

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
in the already approved production run. It restores the exact immutable image
from `rollback-image.txt`, the checked-in reviewed `before.fly.toml`, and the
manifest's desired scale. The same run keeps the per-target deployment lock
until this recovery is verified. A cancelled or otherwise completed
non-successful run is checked again by the completion-recovery workflow; a
manual fallback requires the exact run ID, attempt, target, protected-main
recovery environment, and durable rollback artifact. It does not add a human
approval wait. Old or unrelated runs fail closed.
Image-gen recovery compares its captured `rollback-schema-phase.txt` with the
exact interrupted manifest and reviewed rollback image before any mutation. It
never opens a database tunnel, receives a database URL, or queries a customer
table.
The deploy run remains failed so the incident is visible and its artifacts
record both releases.

The disabled gateway has no manual rollback shortcut. Its later reviewed
bootstrap/rebaseline transition must first prove and record the live identity,
immutable image, exact volume attachment, and complete Machine configuration;
only that transition may establish its initial rollback point. For image-gen or
storage-proxy, promote the new release to that target's `reviewedImage` and
retain only independently reviewed previous digests in
`reviewedRollbackImages`. The workflow validates both operator input and every
pre-release capture before any deploy. Approval, canonical configuration, drift
checks, relevant Meta verification, and smoke checks still apply. Do not restore
a release by starting an ad-hoc Machine.

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
