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
`STORAGE_RATE_LIMIT_REDIS_URL`, `STORAGE_RATE_LIMIT_KEY_SECRET`,
`R2_LIFECYCLE_ACCESS_KEY_ID`, and `R2_LIFECYCLE_SECRET_ACCESS_KEY`. The Redis
endpoint must be private and shared by every proxy Machine; the key secret must
contain at least 32 random bytes. The lifecycle pair must be a separate
Cloudflare R2 Admin Read only credential. That provider grant is account-wide
bucket listing/configuration, object read/list, and read-only R2 Data Catalog
table/metadata access, while the ordinary object credential stays bucket-scoped
Object Read & Write. The proxy consumes the lifecycle pair only once per process
startup for `GetBucketLifecycleConfiguration`, before it listens; request
handling and the proxy do not use Data Catalog. Never use Admin Read & Write or
put any credential value in repository or CI logs. The runtime can prove that the two
access-key IDs differ and that the lifecycle read succeeds, but the S3
credential contract cannot technically attest the Cloudflare permission level.
Verify that grant in the Cloudflare UI.

Startup and `/readyz` prove the shared limiter, while `/healthz` remains a
liveness-only signal. Deploy and rollback/recovery gates for an attested runtime
check `/readyz` separately. During the exact `legacy-bootstrap` /
`awaiting_attested_runtime` transition, the scheduled uptime gate checks only
`/healthz` because that legacy image has no public readiness route. The same
liveness-only check remains during `runtime_reviewed`, when the attested image
is approved but may not yet be live. After a successful deploy proves
`/readyz`, a follow-up reviewed manifest change records `runtime_deployed`; the
repository validator then requires `/readyz` with
`rateLimiter: "shared_redis"`. Storage operations fail closed when the limiter
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
- `IMAGE_GEN_DATABASE_PROVISIONER_URL`: `127.0.0.1:13306` URL for the separate
  protected database provisioner that alone creates, grants, locks, unlocks,
  and drops reviewed MySQL principals;
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

During the reviewed `0016_expand -> 0018_credit_checkout_reservation`
transition, keep four execution roles separate from a fifth protected
provisioner. Except for the conditional `SUPER` case below, the first four may
not have a global privilege or `WITH GRANT OPTION`:

- temporary pre-migration 0016 runtime: schema-level exactly `SELECT, INSERT,
UPDATE, DELETE`;
- 0017/0018 credit migration and credit-object definer: schema-level exactly
  `CREATE, CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT,
UPDATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE`, table-level exactly `DELETE`
  on `billing_intents`, and table-level exactly `CREATE, DELETE` on
  `credit_wallets`; the table-level `CREATE` permits MySQL to record the exact
  future-table grant before 0017 creates that table and does not permit schema
  DELETE;
- final 0018 credit runtime: schema-level `SELECT`, table-level `INSERT, UPDATE,
DELETE` only on the 41 entries in `productionRuntimeWritableTableNames`, and
  `EXECUTE` only on the 17 entries in `creditWalletRoutineNames`; it has no
  direct DML on `credit_wallets`, `credit_reservations`, or `credit_ledger`;
- persistent trigger definer: table-level `SELECT, TRIGGER` on `billing_outbox`
  and table-level `SELECT, UPDATE, TRIGGER` on
  `billing_scheduler_tenants`, with no rights on any other table; this role
  remains limited to the legacy billing triggers during the transition.
- protected provisioner: account-administration and grant authority used only
  inside reviewer-gated `production` jobs; it is never available to the app,
  production inspection, automatic recovery, or no-review cleanup. Its exact
  grants are global `CREATE USER` without grant option, table-level `SELECT` on
  `mysql.user` without grant option, schema-level `SELECT, EXECUTE WITH GRANT
OPTION`, table-level `INSERT, UPDATE, DELETE WITH GRANT OPTION` only on the 41
  entries in `productionRuntimeWritableTableNames`, and table-level `CREATE,
DELETE WITH GRANT OPTION` only on `credit_wallets`. It has no other grant, is
  not root, and has no `ALL`, `SUPER`, or schema-wide DML or DDL grant. The
  schema-wide `EXECUTE` delegation is required because this credential exists
  before the 17 reviewed credit procedures do; the staging workflow still
  grants the runtime only their exact names.

MySQL may additionally expose creator grants of `ALTER ROUTINE` and `EXECUTE`
to the credit migration principal only for those 17 procedures and the
transitional `credit_create_wallet` until 0018 drops it. Global `SUPER` is
required and accepted only when binary logging is enabled and
`log_bin_trust_function_creators` is disabled; otherwise it is excessive.
After creating or rotating a runtime or migration principal, run its exact
phase-matched protected inspection; missing or excessive grants fail closed.
The credit migration additionally requires
`@@GLOBAL.automatic_sp_privileges=1`. Every already-created credit procedure
must name the authenticated migration account from `CURRENT_USER()` as its
definer and retain an exact procedure-level creator `EXECUTE` grant before the
transition may resume. Schema-level `ALTER ROUTINE` remains part of the exact
migration-principal contract; MySQL need not duplicate it per procedure.
The protected workflow first performs a non-mutating migration-principal and
schema-phase inspection, then creates, restores, validates, and durably uploads
the exact pre-credit recovery evidence. This pregrant inspection accepts an
absent or incomplete subset of only the two reviewed definer table grants so a
connection loss between their two statements remains resumable; it rejects any
revoke or unreviewed privilege. Only after the recovery evidence exists does it
open the separate provisioner connection, prove every effective provisioner
grant matches the exact ceiling above, discover the migration account through
`CURRENT_USER()`, and idempotently complete the two exact definer table grants.
A second strict migration-principal inspection runs before credit DDL.
The workflow never passes the provisioner connection to the migrator or
application and does not log either database account identity. The
runtime-principal staging and cleanup workflows use this same separately
protected provisioner secret; they never reuse the migration principal for
account administration.
If the credit transition is abandoned or rolled back without retaining the
credit routines, use a separate reviewed cleanup to revoke `DELETE` on
`billing_intents` and `CREATE, DELETE` on `credit_wallets` from the migration
account. Do not widen that cleanup to schema-level DELETE.
Inspect the separate legacy trigger-definer grants privately and require the
automatic runtime trigger probe below. Bootstrap/contract DDL credentials stay
outside these workflows. No MySQL principal is provisioned to automatic no-review
application recovery.

The trigger definer is a non-runtime executor for the three contract-pinned
billing triggers. Its complete privilege set is table-level `SELECT, TRIGGER`
on `billing_outbox` plus table-level `SELECT, UPDATE, TRIGGER` on
`billing_scheduler_tenants`. It has no rights on any other table and does not
have `INSERT`, `DELETE`, DDL, a schema/global privilege or grant option. Never
add `TRIGGER` to either application runtime. Keep the separate legacy
billing-trigger definer and credit migration/credit-object definer on their
exact contract-pinned grants; change either definer only through a reviewed
migration and reprobe.

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
explicit definer in one reviewed maintenance transition. Keep the
pre-migration runtime at its exact legacy grants only until the final 0018
runtime principal is staged and proven; do not reuse the credit migration
principal as an application runtime or as the separate legacy billing-trigger
definer. MySQL account locking blocks login but does not disable execution of
stored objects that name the locked account as definer.

After the transition, privately prove that all three triggers name exactly that
one locked account and that its only effective object grants are the two exact
table-level sets above. Do not print the account name, grant output or
connection URL. Run the phase-matched runtime (`runtime` or `credit-runtime`)
and migration (`credit-expand`) schema inspections plus the runtime trigger
probe before another deploy, and retain the evidence as metadata only.
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
not enough to enable it. `apps.gateway.stateRebaseline` now records the exact
legacy Machine, image, encrypted volume, mount and region as metadata-only
evidence. The legacy release has no deployment label, so the manifest uses the
explicit `legacy_unlabeled` sentinel rather than inventing an identity. Its
three configuration hashes remain `null` together until a canonical capture is
reviewed; that unresolved state cannot advance. A later, separately reviewed
transition must fill all three hashes, bind an attested artifact built from
fully pinned inputs, pass the protected volume-copy rehearsal, and independently
review both recovery and successor identities. Until that complete transition
settles, the workflow rejects the target before production approval or any Fly
mutation and gateway quota enforcement stays off.

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
   tests `/healthz` and `/readyz`. On failure it restores and verifies the
   captured release.
5. Only after that successful deploy, record transition state
   `runtime_deployed` in a reviewed follow-up PR. The scheduled monitor then
   requires public `/readyz` and the shared Redis limiter. Keep the exact legacy
   rollback until a later attested runtime can replace it.

While the transition is `runtime_reviewed`, `reviewedImage` is the new attested
deployment candidate; it is not yet evidence of the live image. The exact
`artifactTransition.legacyImage` remains the live baseline and sole reviewed
rollback until the runtime deploy succeeds. Record only an immutable digest in
`reviewedImage`, then move to `runtime_deployed` in the reviewed follow-up after
the live checks pass.

Current metadata-only evidence from 2026-08-27 records that the Cloudflare UI
showed the dedicated credential as **Admin Read only** and exactly one bucket in
the current account, uniquely named `leaderbot-images`. No access-key or secret
value was captured. This is provider-side operator evidence only; it neither
proves which credential is installed in Fly nor replaces startup/readiness
evidence.

The protected deployment of the reviewed candidate
`sha256:d2a2be7a61d7668ec1665ab459eee2b0717020c0542a78a7faccd494a68c47cc`
failed. Its rollback completed and the restored baseline is healthy, so this
digest is not deployed-runtime evidence and the manifest must not advance to
`runtime_deployed`. Build run `33069256896` subsequently produced and attested
replacement candidate
`sha256:3f2861c2ddc373ae777122f9b6cbac0f333c7ce65c094cc5fd2dbccfdf6df1e9`
from reviewed source `16b18195646fe2db8adc70a80e60616c50b6bc7c`; the
manifest previously recorded that exact pair and retained the healthy legacy
rollback. It never became deployed-runtime evidence and is superseded by the
startup-ordering candidate below; do not dispatch the old digest.

Protected run `33080233054` stopped before production mutation because the
current Machine metadata no longer matched the recorded predecessor. The live
comparison after two releases during the 2026-08-27 credential rotation showed
the exact legacy image, reviewed configuration, region, scale and process group,
with Fly tool metadata `2026.8.27-dev.1787839287`. The temporary
`runtime_reviewed` predecessor records that exact value so the next protected
rollout can replace it with the pinned deployment tool. This does not allow
another development build and the exception no longer applies after
`runtime_deployed`.

Build run `33092823815` produced replacement candidate
`sha256:99ea65710abb9a2294dcaf02cf76f57b240cb153a69e6020b68a470278103a8d`
from reviewed startup-ordering fix
`6a7d0431e1e02076a2db7fcf12c8358d7fbf33cd`. GitHub provenance attestation
`43467733` binds that digest to the exact source and protected builder.
Protected deploy run `33101076132` proved the artifact and source but the
runtime refused startup before binding its port. The workflow restored reviewed
legacy digest
`sha256:334f78b92816a92e302a66c4d08742c28361a718b190227d3dbf7b933350cc28`,
verified its captured configuration, and public `/healthz` returned `200`.
Digest `99ea...` is not deployed-runtime evidence and must not be dispatched
again. PR #451 then added bounded metadata-only diagnostics for configuration,
Redis connection and readiness, app construction, the R2 lifecycle preflight,
and server binding. Trusted build run `33104393266`, attempt 2, produced
diagnostics runtime
`sha256:a6bb22fcdbdfa6cc211afabfae86cc2423f501e589113f2f0a7e32db0f22083d`
from reviewed main source `1da8da74f301fb368563cd094912e159d3bf6998`;
GitHub provenance attestation `43482590` binds the exact pair. Attempt 1
stopped before building because exact-source main CI was still in progress.
Protected deploy run `33105621166` admitted that exact artifact and source, then
failed closed in startup phase `r2_lifecycle_preflight`. The safe phase record
proved configuration, Redis connection and readiness, and app construction had
passed. Read-only inspection confirmed that the production bucket had only the
default multipart-abort rule and lacked all three required 30-day prefix
expiration rules. The workflow restored and verified legacy digest `334f...`;
public `/healthz` returned `200`, exact recovery run `33106363152` passed, and
completed-run reconciliation `33106369992` passed. The manifest therefore
returned to `awaiting_attested_runtime`; digest `a6bb...` remains failed rollout
evidence and is not dispatchable.

The owner subsequently approved the retention boundary. Cloudflare stored the
three enabled 30-day rules for `inbound-source/`, `generated/images/`, and
`generated/videos/`. A credential-separated, read-only
`GetBucketLifecycleConfiguration` request returned HTTP `200` with exactly
those three required rules plus the existing multipart-abort rule; every
required rule reported the exact prefix, `Enabled`, and `30` days. Trusted build
run `33107224397` then produced runtime digest
`sha256:27dd75daaa30dac5a279fc097a57c14133efb419cbdbbd1fdefba26a21ffeace`
from reviewed main source `cf099e654d289186416b00500cb8f975cbdd906b`.
GitHub provenance attestation `43489246` binds the exact pair. This manifest
first advanced to `runtime_reviewed`. Protected deploy run `33110415900`, from
main commit `19ae52f90a683b2f975823a68d785608a7d8fbec`, then deployed that exact
digest with identity `deploy-33110415900-1`. The settled live state contains
exactly one started Machine in `ams`, no drift, `/healthz` `200` with exact body
`ok`, and `/readyz` `200` with `ok=true` and `rateLimiter=shared_redis`.
Rollback and recovery were correctly skipped. This reviewed follow-up records
`runtime_deployed` while retaining legacy digest `334f...` as the sole rollback.

### Initial credit-provisioner bootstrap

The protected credit-schema workflow needs one narrowly scoped MySQL
provisioner before its first 0017/0018 run. Create it only with the reviewed
one-shot helper after the manifest is frozen at `expand_pending`, application
deployment is disabled, and the migration bridge is the sole rollback. The
operator must supply the exact clean `main` commit and the ID of a fresh
`created` snapshot of the reviewed 10 GB production database volume:

```bash
node scripts/provision-image-gen-credit-provisioner.mjs \
  --expected-head <exact-40-character-reviewed-main-sha> \
  --recovery-snapshot-id <exact-reviewed-fly-volume-snapshot-id>
```

The helper reruns `production:validate` and exact-source CI, rechecks the
reviewed database Machine, image, private address, encrypted mount, volume, and
snapshot, then holds one MySQL advisory lock across orphan recovery, account
creation, exact-grant verification, local tunnel proof, and GitHub environment
secret publication. It sends the URL to `gh secret set` only through stdin.
It never prints the database account, URL, password, grants, snapshot identity,
or command errors.

This one-shot helper requires local `flyctl v0.4.94`, the exact version used to
review its Machine, volume, and snapshot JSON contract. The later protected
schema workflow continues to install and verify its separately reviewed
`flyctl v0.4.85`; do not replace that workflow pin as part of this bootstrap.
Run `npm run image-gen:install` before the helper so its reviewed `mysql2`
client is already present. The helper never installs packages after a database
mutation has started. Use a clean checkout with the existing authenticated
`flyctl` and `gh` sessions; no token or database credential is a command-line
input.
Use the operator's existing authenticated `gh` session; the helper reads that
token only into the exact-source CI child process. Never paste, export, or add a
GitHub token to this command.

Only these fixed output markers are valid:

- `credit_provisioner_ready`: the exact account was created and reverified;
  `gh secret set` succeeded and the protected secret name is present. GitHub
  does not expose the stored value, so the protected schema workflow is the
  first consumer that proves the stored URL parses and connects;
- `credit_provisioner_bootstrap_failed`: a read-only preflight rejected the
  operation before mutation, or cleanup proved every helper-started mutation
  absent. Pre-existing state can still require review;
- `credit_provisioner_bootstrap_cleanup_incomplete`: cleanup could not prove
  both absent, or `gh secret set` did not settle so a delayed remote write
  remains possible even after immediate absence. Stop and obtain a reviewed
  recovery before dispatching the schema workflow.

A timeout, interrupt, authentication failure, tunnel failure, or ambiguous
GitHub mutation arms the same bounded cleanup. Do not paste root SQL, account
names, passwords, grants, or a database URL into a shell, GitHub field, issue,
log, or chat. Do not create the secret manually and do not dispatch the schema
workflow after either failure marker.

### Image-gen database migration gate

Production currently runs `0016_expand`. The only reviewed successor is the
ordered credit transition through `0017_credit_wallet_expand` to the exact
`0018_credit_checkout_reservation` runtime. The protected schema workflow may
apply those two checked-in migrations only; no application deploy, shell
command, or ad-hoc Machine may change the production schema.

Use this exact sequence:

1. **Open the reviewed transition.** In a dedicated manifest PR, set the
   transition to `0016_expand -> 0018_credit_checkout_reservation`, state
   `awaiting_attested_bridge`, keep the exact settled 0016 runtime as
   `legacyBaseImage`, disable deploys, and retain only that image as rollback.
2. **Build the bridge.** After that PR is green and merged, dispatch `Build
trusted production artifact` with `image-gen-bridge`. The workflow proves
   that the bridge keeps the exact settled application runtime, carries only
   the reviewed 0017/0018 migration material and reversible billing-trigger
   preflight, supports all three declared phases, and attests its source plus
   exact base digest.
3. **Review and deploy the bridge.** In a separate manifest PR, record the
   bridge digest and its build-source commit with state `bridge_reviewed`.
   After green CI, deploy that exact digest through `Deploy production` and
   prove every app and worker Machine runs it. Commercial, paid-credit, and
   Mollie exposure flags remain off.
4. **Freeze deploys.** In another reviewed manifest PR, set state
   `expand_pending`, disable application deploys, and retain only the bridge as
   recovery image.
5. **Bootstrap the initial provisioner.** Create a fresh snapshot of the exact
   reviewed production database volume, wait until Fly reports `created`, and
   select its exact ID only while it is less than one hour old. Run the
   one-shot helper above from exact clean reviewed `main` with that snapshot
   ID. Accept only `credit_provisioner_ready`; either other fixed marker stops
   the transition. Do not paste a secret or execute manual SQL. This bootstrap
   snapshot provides a fresh recovery point before account creation; the helper
   does not restore-test it. It is separate from the workflow's own pre-DDL
   restore-tested snapshot in the next step.
6. **Back up and prove recovery.** Only after the bootstrap is ready, dispatch
   `Apply reviewed image-gen credit schema`. The protected workflow first
   proves every Machine is the attested
   bridge and the live database is the exact 0016 base. It creates a fresh
   encrypted snapshot, restores it into an isolated encrypted volume, runs
   MySQL integrity checks, uploads metadata-only recovery evidence, and removes
   the temporary restore Machine and volume.
7. **Apply only 0017 then 0018.** The same protected workflow applies only the
   reviewed credit migrations and verifies the exact final 0018 contract from
   the bridge. A resume must name the exact earlier recovery run and attempt;
   the snapshot, database, migration manifest, schema contract, bridge digest,
   and bridge source must all still match. Unknown or partial shapes fail
   closed.
8. **Build the final runtime.** In a reviewed manifest PR, record the successful
   schema phase and state `runtime_build_pending`, leaving deploys frozen on the
   bridge. Then dispatch `Build trusted production artifact` with
   `image-gen-runtime`. The image must reject pre-0018 schemas, accept only the
   exact 0018 contract, and receive trusted provenance for its immutable digest
   and build-source commit.
9. **Review the immutable runtime before staging credentials.** In a separate
   manifest PR, record that digest and its artifact build-source commit, set
   state `runtime_principal_pending`, keep deployment disabled, and retain the
   bridge as rollback. This manifest-review commit is expected to be later than
   the artifact build-source commit; they must not be forced to the same Git
   SHA. The protected staging workflow requires green CI for both commits,
   verifies the immutable image label and attestation against the recorded
   artifact source, runs the exact trigger/runtime privilege probe through the
   newly created restricted principal, and stages `DATABASE_URL` without
   restarting a Machine.
10. **Review and deploy the staged principal.** Record the metadata-only staged
    principal fingerprint in another reviewed manifest PR, set state
    `runtime_reviewed`, enable deployment, and keep the bridge as the only
    application rollback. `Deploy production` must prove the exact candidate
    image, configuration, and deployment identity, then run the reviewed probe
    through the staged principal on every desired app and worker Machine before
    `/healthz` and `/readyz` may complete the rollout. A failed rollout restores
    the bridge and its captured configuration; the 0018 schema remains in place.
11. **Settle the final runtime before principal cleanup.** Record a healthy
    final-schema runtime predecessor and move to `complete` only in a later reviewed
    manifest PR that removes the bridge from the rollback allowlist and retains
    at least one exact 0018 runtime rollback. Do not expose a Mollie checkout
    while the only rollback is the migration bridge. This settled manifest is a
    prerequisite for the protected obsolete-principal cleanup workflow; moving
    to `complete` does not itself enable paid credits or checkout.
12. **Retire the obsolete broad runtime principal.** Only after every desired
    Machine reproves the restricted principal under the settled deployment
    identity, run the protected cleanup workflow to lock the exact obsolete
    broad principal. Preserve its protected unlock path for at least 24 hours,
    then use that exact lock evidence for a separately approved drop. Keep
    `IMAGE_GEN_DATABASE_PROVISIONER_URL` present through the successful drop,
    because the protected cleanup workflow still requires it.
13. **Retire the bootstrap provisioner.** After the obsolete runtime principal
    is absent, use a separate reviewed bounded root/admin retirement path to
    lock every reserved `lbcp_*` account under an explicit recovery path,
    preserve that recovery window for at least 24 hours, then drop the accounts
    and prove the managed inventory empty. Only then delete
    `IMAGE_GEN_DATABASE_PROVISIONER_URL` and prove the protected secret remains
    absent over a stabilization window. That retirement path is not part of the
    bootstrap helper and must be reviewed before use; do not replace it with
    manual SQL or a secret-field edit.
14. **Keep Test Mode exposure separate.** Until both cleanup paths have
    metadata-only success evidence, the commercial cutover is incomplete and
    no Mollie Test Mode checkout may be exposed. Continue only through the
    separately reviewed Test Mode activation gates; schema state `complete` is
    not payment-readiness evidence.

Before paid-credit exposure, set the non-secret
`CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID=k1` beside the dedicated Fly secret. A later
rotation must deploy the new active ID/key together with every still-required
predecessor in `CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS`. Readiness rejects a
malformed or duplicate keyring entry, but does not impose a fixed predecessor
count because purchased credits do not expire. The runtime resolves an existing
wallet by its exact persisted Messenger subject before selecting the retained
key. Never remove a predecessor until no non-erased wallet or
provider-resolution proof uses it; removal is a fail-closed incident, not a
wallet migration.

Test Mode exposure is additionally limited to one approved pseudonymous
Messenger subject on one exact Page binding. In the reviewed activation change,
set `MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID`,
`MOLLIE_CREDIT_TEST_BINDING_EPOCH` and `MOLLIE_CREDIT_TEST_PRIVACY_EPOCH` to the
current non-secret database boundary. Compute
`MOLLIE_CREDIT_TEST_USER_KEY_HASH` only in the protected operator environment as
SHA-256 over the UTF-8 domain `leaderbot.credit-checkout-test-user.v1\0`
followed by the canonical pseudonymous user key. Retain only the hash; never
place the source user key or PSID in config, documentation, evidence, chat or
logs. `/readyz` must fail before database access when any part is absent or
stale. A different user in the same owner workspace remains on the ordinary
free-quota response and cannot create a wallet, intent or provider operation.

Set the non-secret `MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD=1.00` in the same
reviewed Test Mode activation. This is a conservative reservation against the
global, monthly and per-user provider spend caps before a paid image request
starts, not the provider's final invoice cost. Re-review the value whenever the
model, quality, size or source-image policy changes; readiness fails closed if
paid credits are enabled without a positive finite value.

Do not type migration commands into a production shell and do not start an
ad-hoc migration Machine. Normal releases use the image's compatibility check;
the protected schema workflow is the only production path that changes this
database.

Application rollback after step 6 leaves the successfully applied 0018 schema
in place and may use only the reviewed migration bridge or a runtime explicitly
reviewed for 0018. Never blindly restore the pre-migration snapshot after
production writers continued: that would silently discard later writes. A
production restore requires point-in-time recovery to a verified boundary, or
a coordinated writer pause with a durable buffer and a proven replay plan.
Otherwise preserve the database and recover forward.

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

The manifest contract has four stages:

1. `awaiting_rehearsal` binds the observed legacy Machine/image/volume tuple,
   keeps configuration hashes unresolved together, and permits no reviewed
   recovery or successor.
2. `rehearsal_approved` requires all configuration hashes and exact trusted
   artifact provenance, but still permits no rehearsal success claim. Only this
   state may start the protected volume-copy rehearsal.
3. `rehearsed` additionally requires an encrypted `/data` restore in `ams` and
   metadata-only evidence that startup, isolation and rollback checks passed.
4. `settled` additionally requires separately reviewed recovery and successor
   identities and configs. Even this state does not enable deployment in the
   current transition; that needs a later reviewed manifest/validator change.

The current protected workflow intentionally does not satisfy stage 3. It
records only that an encrypted clone was mounted, the reviewed image started
and restarted with a credential-scrubbed production-shaped Facebook
configuration, disabled transports, empty config/shell credential sources, no
cloud-worker profiles and an empty temporary runtime state, while the live
baseline remained unchanged. The artifact therefore keeps `startupPassed`,
`tenantIsolationPassed`, and `rollbackPassed` false. It does not exercise
the loaded Facebook plugin runtime plus `/readyz`, route isolation identities,
or start a reviewed recovery image. Without an explicit egress control it also
makes no claim that provider calls were absent. A later complete rehearsal must
prove those separate requirements before the manifest may move to `rehearsed`.

At every stage `historicalResources` forbids automatic deletion and preserves
unlisted Machines and volumes. Cleanup is a separate, human-reviewed operation
after the canonical state is proven; it is never an implicit side effect of
rebaseline, deploy, rollback or reconciliation.

Longer term, move gateway state into tenant-scoped durable storage so two or
more interchangeable gateway Machines can run without shared customer-content
paths or host-bound state. Terraform may own stable infrastructure resources,
but it must not co-own Machines that `fly deploy` manages.
