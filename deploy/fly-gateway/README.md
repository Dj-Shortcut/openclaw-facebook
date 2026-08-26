# Leaderbot OpenClaw Fly Gateway

This plugin repo owns the Fly deployment source for Andy's personal-only
OpenClaw gateway. Multi-tenant Messenger customers terminate directly in
image-gen and must never enter this workspace.
OpenClaw and the official Codex harness plugin are installed as pinned package dependencies during the Docker build; the Facebook plugin is built from this repository in the same image.

## Update OpenClaw

Use the single supported workflow in
[`../../docs/openclaw-update.md`](../../docs/openclaw-update.md). Do not edit
`OPENCLAW_VERSION` by hand except through `npm run openclaw:update -- <version>`.
That script keeps package metadata, tests, and the Fly gateway build arg aligned.

The OpenClaw dashboard update action is not the update path for this Fly/Docker
gateway. This image installs OpenClaw during Docker build, so a dashboard
`not-git-install` or package-root update skip means the runtime cannot safely
mutate `/app/node_modules/openclaw` in place. Treat the running Fly machine as
read-only: update the pinned package version in this repository, merge the PR,
then redeploy the image.

Future managed dashboard updates for Fly/Docker should hand off to an explicit
redeploy workflow with operator approval, scoped credentials, audit logging, and
rollback guidance. They should not edit runtime files inside the running
container.

See [`managed-redeploy-handoff.md`](managed-redeploy-handoff.md) for future
dashboard handoff design. The current authoritative operator workflow is
[`../../docs/openclaw-update.md`](../../docs/openclaw-update.md).

## Deploy

Dispatch the `Deploy production` GitHub Actions workflow, select `gateway`, and
approve the protected `production` environment. The workflow runs this one
canonical command from the repository root:

```bash
npm run deploy:gateway
```

Direct invocation is reserved for an explicitly approved emergency. Do not use
`fly machine run`; detached Machines are rejected by the deployment drift gate.

### Gateway deployment remains blocked

The 2026-08-01 production upgrade to OpenClaw 2026.7.1 was rolled back because
the mounted state contains conflicting legacy and canonical Memory Core index
rows. Do not run the standard gateway deploy against that volume until the
state migration has been rehearsed on a copy, backed up, and explicitly
approved. Do not run `openclaw doctor --fix` against production state as an
unreviewed deploy step.

The former direct `fly deploy --config fly.toml` containment command is retired.
The current config hard-blocks both Facebook webhook paths, so deploying it
before Meta's canonical callback is proven to reach image-gen would interrupt
Messenger delivery. A direct Fly command would also bypass the protected
workflow's pre-deploy callback check. Do not deploy this gateway while the
production manifest keeps it disabled, and do not use a direct command as a
temporary hotfix.

The isolation port requires a reviewed immutable image built from the standard
`deploy/fly-gateway/Dockerfile`. The production manifest currently blocks that
deployment. Keep it blocked until the mounted-state migration has been rehearsed
on a volume copy and both the rollout image and a rollback image contain the
same isolation controls. Rolling back to an older startup script would recreate
shared `MEMORY.md` and re-enable shared memory, so such an image is not an
acceptable rollback target.

Only the protected deployment workflow may deploy the gateway after all of
those prerequisites are recorded and the canonical image-gen Facebook callback
and direct delivery have been proven. Until then there is no approved gateway
deployment command.

Verify `/healthz` and protected route near-misses after every deployment. Portal,
legal and Mollie routes belong to `app.leaderbot.live`/image-gen and must return
`404` on this personal gateway. Both `/facebook/webhook` and the legacy
`/messenger/webhook` must also return `404`; the multi-tenant Page callback
belongs to image-gen.

## Safety Defaults

The container preserves `/data/openclaw.json` and normally seeds non-secret
defaults only when missing. The reviewed safer `pairing` and bridge-disabled
values are deliberately authoritative over stale public values.

### Reviewed model and memory settings

`OPENCLAW_AGENT_MODEL=openai/gpt-5.4-mini` is intentional, not a placeholder.
OpenAI documents `gpt-5.4-mini` as a supported current alias; OpenClaw uses the
provider-qualified `openai/` prefix. Do not silently replace it with a `latest`
alias during dependency updates. Re-evaluate model quality, cost, latency, tool
support, and rollback behavior in a dedicated review before changing it.

The 4 GiB Fly VM deliberately caps the V8 old-space heap at 1536 MiB. The
remaining memory is reserved for Node/native allocations, OpenClaw runtime
overhead, buffers, and the operating system. Increase the heap only after
production memory/GC evidence, a canary, and rollback approval; increasing it
speculatively can turn recoverable pressure into a machine-level OOM.

The checked-in values and the non-deploying update boundary are enforced by:

```bash
npm run gateway:deployment-safety
```

- `OPENCLAW_WORKSPACE_DIR` defaults to `/data/workspace` for static instruction files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, and `IDENTITY.md`). Messenger memory plugins, session-memory hooks, compaction memory flushes, memory search, and memory tools remain disabled so legacy customer data cannot enter Andy's personal workspace.
- Startup moves any legacy shared `USER.md`, `MEMORY.md`, or `memory/` content to the recoverable, operator-only `/data/private-memory-quarantine-v1` directory before accepting traffic. If shared memory reappears after a prior quarantine, startup fails closed instead of overwriting either copy.
- `session.dmScope` is forced to `per-account-channel-peer`, keeping direct-message history isolated by Page account, channel, and sender. Startup rejects an explicit Facebook `agentId` other than `main`; when a binding omits `agentId`, the public plugin still rejects an inherited secondary default agent at runtime before transcript dispatch.
- `attachments.ttlHours` is capped at 24 hours as crash-recovery cleanup; normal Messenger turns delete their downloaded temporary media immediately after completion or failure.
- On startup, missing static workspace instruction files are copied once from the legacy `/home/node/.openclaw/workspace` fallback into `/data/workspace`; legacy user or memory content is never copied into the public workspace.
- `plugins.load.paths` includes `/app/node_modules/@dj-shortcut/facebook`.
- The optional Codex plugin path/allow entry is removed and its plugin entry is disabled.
- `plugins.entries.facebook.enabled` defaults to `true`.
- `channels.facebook.dmPolicy` defaults to `pairing`; persisted account-level
  `open` overrides are also reduced to `pairing` unless public-open mode was
  explicitly authorized.
- `channels.facebook.unknownSenderMode` is seeded from `OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE` when missing. A reviewed `pairing` value is authoritative over stale persisted top-level and account-level public modes on this personal-only gateway.
- `channels.facebook.leaderbotBridgeEnabled` is seeded from `OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED` when missing. A reviewed `false` value is authoritative over stale persisted top-level and account-level `true` values, preventing the mounted volume from silently restoring customer forwarding.
- `agents.defaults.model.primary` defaults to `OPENCLAW_AGENT_MODEL` when set.
- `agents.defaults.thinkingDefault` defaults to `OPENCLAW_AGENT_THINKING_DEFAULT` when set.
- Every untrusted public Messenger turn replaces persisted tool profiles and provider overrides with a positive minimal allowlist containing only `session_status`; code mode is disabled and memory, cross-session, messaging, automation, plugin, node, web/UI, runtime, filesystem, and billable generation tools remain explicitly denied. The multi-tenant customer image-generation path does not use this gateway.
- The Fly startup always puts OpenClaw behind its public route guard and binds the OpenClaw target to loopback. Only `/healthz` is public; stale `OPENCLAW_PUBLIC_GATEWAY_GUARD`, `OPENCLAW_PUBLIC_GATEWAY_PATHS`, `LEADERBOT_PORTAL_ORIGIN` and `OPENCLAW_PUBLIC_PORTAL_ORIGIN` values cannot reopen webhook, portal, legal or Mollie routes. The canonical customer endpoints belong to image-gen. Dashboard/UI/API access requires `OPENCLAW_ADMIN_TOKEN` and a request host listed in `OPENCLAW_ADMIN_HOSTS`; after that, OpenClaw's own device pairing/auth still applies.

The container changes `channels.facebook.dmPolicy: "open"` back to `"pairing"` unless `OPENCLAW_FACEBOOK_ALLOW_OPEN=1` is intentionally set.
Secrets must remain in Fly secrets or the mounted state, never in this repo.

### Personal gateway state/privacy rollout gate

Before enabling the standard gateway deployment, independently of the
multi-tenant image-gen release:

1. Keep `deploy/production/apps.json` at
   `apps.gateway.stateRebaseline.state=awaiting_rehearsal` and
   `deploymentEnabled=false` while the three configuration fingerprints remain
   unresolved. Keep `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=false`; do not
   enable it yet.
2. Compute and review all three configuration fingerprints and the exact
   artifact provenance, then move only to `rehearsal_approved`. This is the only
   state from which the protected rehearsal may start; it still claims no
   rehearsal success.
3. Snapshot or clone the mounted volume and rehearse startup on the copy. Do not
   inspect quarantined customer content without an approved, auditable support
   or break-glass flow.
4. Prove the generated non-secret config has
   `session.dmScope=per-account-channel-peer`, memory slot `none`, disabled
   `memory-core` and `session-memory`, disabled compaction memory flush, and an
   attachment TTL no greater than 24 hours.
5. Prove `/data/workspace` has no `USER.md`, `MEMORY.md`, or `memory/` entry and
   that any prior content is present only in the protected quarantine. A
   quarantine collision is a stop condition, not permission to delete or
   overwrite either copy.
6. Build and review matching rollout and rollback artifacts containing these
   controls. Then use the protected production workflow; do not source-deploy or
   use the route-guard hotfix as evidence.
7. Record exact artifact provenance, protected rehearsal evidence, the recovery
   identity/config and the successor identity/config in `stateRebaseline`. All
   historical Machines and volumes remain preserved; this transition never
   deletes them automatically.
8. Smoke two senders on one Page and one sender identity across two test Page
   accounts; their resolved session keys must all differ. Verify successful and
   failed attachment turns leave no downloaded media behind, and verify logs
   contain no raw session key, PSID, message text, or attachment URL.

### WhatsApp requires a separate active-channel proof

This port covers the root Facebook/Messenger gateway only. The image-gen runtime
currently treats WhatsApp as operational: startup unconditionally requires
`WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`, registers
`/webhook/whatsapp`, and the production manifest records that callback as
canonical. Secret presence is therefore not evidence that the channel is safely
isolated.

Do not deploy or advertise WhatsApp under this Messenger proof. Because the live
channel is intentionally active, its fail-closed release requirement is an exact
inbound WABA plus phone-number binding to workspace, channel connection, binding
epoch, and privacy epoch. Every production Graph send must use only the encrypted
token on that exact connected database row; global `WHATSAPP_*` transport
fallbacks are development/test-only and a contextless production send must fail
before transport. Text, image, and audio provider attempts must be fenced and
rechecked so wrong-tenant, rebind, disconnect, or privacy denial makes zero
provider calls. Keep the image-gen deployment blocked until those boundaries and
their production-equivalent tests are green.
