# Leaderbot OpenClaw Fly Gateway

This plugin repo now owns the Fly deployment source for the public Messenger gateway.
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

Run from the `openclaw-facebook` repository root:

```bash
npm run deploy:gateway
```

### Gateway runtime migration gate

The 2026-08-01 production upgrade to OpenClaw 2026.7.1 was rolled back because
the mounted state contains conflicting legacy and canonical Memory Core index
rows. Do not run the standard gateway deploy against that volume until the
state migration has been rehearsed on a copy, backed up, and explicitly
approved. Do not run `openclaw doctor --fix` against production state as an
unreviewed deploy step.

The release image is built by `deploy/fly-gateway/Dockerfile`: it compiles the
Facebook plugin from this exact workspace and installs the single pinned
OpenClaw version declared by that Dockerfile. The former route-guard-only image
must not be used because it omitted quota/finalization changes from the plugin.

Do not deploy this image against the production volume until the state
migration has been rehearsed on a copy, backed up, and explicitly approved:

```bash
fly deploy --config fly.toml
```

The Docker build runs the runtime validator before and after dependency pruning
and records runtime/plugin provenance as OCI labels. Verify `/healthz`, `/readyz`,
`/facebook/webhook`, `/messenger/webhook`, all portal/legal routes, quota
reserve/heartbeat/delivery-start/finalize, and protected route near-misses after
every controlled test deployment.

## Safety Defaults

The container preserves `/data/openclaw.json` and only seeds non-secret defaults when missing:

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

- `OPENCLAW_WORKSPACE_DIR` defaults to `/data/workspace` for static instruction files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, and `IDENTITY.md`). Public Messenger memory plugins, session-memory hooks, compaction memory flushes, and memory tools are disabled because this gateway serves multiple tenant Pages.
- Startup moves any legacy shared `USER.md`, `MEMORY.md`, or `memory/` content to the recoverable, operator-only `/data/private-memory-quarantine-v1` directory before accepting traffic. If shared memory reappears after a prior quarantine, startup fails closed instead of overwriting either copy.
- `session.dmScope` is forced to `per-account-channel-peer`, keeping direct-message history isolated by Page account, channel, and sender even when an older persisted config used OpenClaw's shared `main` default.
- `attachments.ttlHours` is capped at 24 hours as crash-recovery cleanup; normal Messenger turns delete their downloaded temporary media immediately after completion or failure.
- On startup, missing static workspace bootstrap files are copied once from the legacy `/home/node/.openclaw/workspace` fallback into `/data/workspace`; legacy user or memory content is never copied into the public workspace.
- `plugins.load.paths` includes `/app/node_modules/@dj-shortcut/facebook`.
- `plugins.load.paths` includes `/app/node_modules/@openclaw/codex`.
- `plugins.entries.facebook.enabled` defaults to `true`.
- `channels.facebook.dmPolicy` defaults to `pairing`.
- `channels.facebook.unknownSenderMode` is seeded from `OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE` when missing. The public Leaderbot gateway sets this to `leaderbot_free_tier` so new Page senders enter the free-tier image flow while private installs can keep or set `pairing`.
- `channels.facebook.leaderbotBridgeEnabled` is seeded from `OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED` when missing. Keep it unset/false for ClawHub and private installs; set it only for the intentional public Leaderbot gateway where Messenger content and identifiers are disclosed as being processed by the separate image-generation service.
- `agents.defaults.model.primary` defaults to `OPENCLAW_AGENT_MODEL` when set.
- `agents.defaults.thinkingDefault` defaults to `OPENCLAW_AGENT_THINKING_DEFAULT` when set.
- `tools.deny` includes `image_generate` so this public Messenger gateway cannot invoke OpenClaw's built-in image-generation tool; Messenger image generation is routed through the separate Leaderbot image-gen service.
- `OPENCLAW_PUBLIC_GATEWAY_GUARD=1` puts OpenClaw behind a small public route guard. Fly exposes `/facebook/webhook`, `/healthz`, and `/readyz` publicly by default, and can proxy customer portal/legal routes to `LEADERBOT_PORTAL_ORIGIN`. A deployment whose persisted channel config still uses the legacy `/messenger/webhook` path must opt in with `OPENCLAW_PUBLIC_GATEWAY_PATHS`; do not expose an unregistered webhook path because OpenClaw may otherwise serve its UI fallback there. Dashboard/UI/API access requires `OPENCLAW_ADMIN_TOKEN` and a request host listed in `OPENCLAW_ADMIN_HOSTS`; after that, OpenClaw's own device pairing/auth still applies.
- `/healthz` remains the gateway liveness signal. `/readyz` additionally performs the authenticated, metadata-only image-gen AI-answer quota handshake whenever `LEADERBOT_AI_ANSWER_PREFLIGHT_ENABLED=true` or paid AI-answer enforcement is enabled. The exposure-off rehearsal requires the image-gen finalization drain and `AI_ANSWER_QUOTA_PREFLIGHT_ENABLED=true`, but does not reserve quota, call a provider, or expose checkout.

The container changes `channels.facebook.dmPolicy: "open"` back to `"pairing"` unless `OPENCLAW_FACEBOOK_ALLOW_OPEN=1` is intentionally set.
Secrets must remain in Fly secrets or the mounted state, never in this repo.
