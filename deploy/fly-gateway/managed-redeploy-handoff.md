# Managed Redeploy Handoff

This design covers future dashboard-initiated OpenClaw runtime updates for the
Fly/Docker gateway. The running machine is image-managed, so updates must create
and deploy a new image. Do not edit, reinstall, or replace
`/app/node_modules/openclaw` inside a running Fly machine.

## Goals

- Require explicit operator approval before any production redeploy.
- Use scoped deploy credentials that cannot read tenant content or mutate
  unrelated Fly apps.
- Keep audit records redacted and metadata-only.
- Make rollback instructions available before the deploy starts.
- Preserve webhook, consent, delete-my-data, quota, and public route guard
  behavior during rollout.

## Non-Goals

- No in-container package mutation.
- No dashboard action that directly runs `npm install` or writes under `/app`.
- No broad operator token that can inspect customer conversations, workspace
  memory, uploaded knowledge, generated prompts, or private channel identifiers.
- No automatic production deployment without an approval artifact.

## Handoff Contract

The dashboard update action should produce a redeploy request, not execute an
in-place update. The request must be reviewed and approved by an operator before
the scoped deploy credential is used.

Required request fields:

- `request_id`: unique opaque id for audit correlation.
- `requested_by`: dashboard user id or service actor id.
- `target_app`: expected value is `leaderbot-openclaw-gateway`.
- `current_openclaw_version`: detected package version.
- `target_openclaw_version`: requested package version.
- `current_image`: image reference from `fly releases --image`.
- `rollback_image`: previous known-good image reference.
- `repo_ref`: commit or PR that changes `OPENCLAW_VERSION`.
- `verification_plan`: commands/checks to run after deploy.
- `approval_status`: `pending`, `approved`, `rejected`, or `expired`.
- `approved_by`: operator id, present only after approval.
- `approved_at`: timestamp, present only after approval.
- `expires_at`: approval expiry timestamp.

Redact request data before persistence. Store package versions, image refs,
commit ids, app names, approval metadata, and check outcomes. Do not store
access tokens, raw PSIDs, webhook payloads, customer messages, workspace memory,
knowledge content, generated prompts, generated image URLs tied to users, or
secret values.

## Credential Scope

Use a deploy credential dedicated to this handoff. It should be issued outside
the customer runtime and injected only into the deploy runner.

Minimum scope:

- Deploy only the Fly app `leaderbot-openclaw-gateway`.
- Read release metadata for `leaderbot-openclaw-gateway`.
- No access to Fly secrets unless the redeploy explicitly requires secret
  rotation and that is approved as a separate operation.
- No database, Redis, storage bucket, Messenger, WhatsApp, or OpenAI access.
- No shell access to running machines for normal updates.

The deploy runner should receive the token as an ephemeral secret, use it for
one request, then discard it. Do not write the token to logs, audit tables, PR
comments, or dashboard-visible status details.

## Approval Flow

1. Dashboard detects that the Fly/Docker install is image-managed and cannot be
   updated in place.
2. Dashboard creates a redeploy request with the fields above and marks it
   `pending`.
3. Automation opens or updates a PR that bumps `OPENCLAW_VERSION` in
   `deploy/fly-gateway/Dockerfile` and keeps the Facebook plugin peer range
   compatible with that OpenClaw release.
4. CI verifies the PR with the gateway checks and any targeted compatibility
   tests.
5. Operator reviews the diff, Meta/webhook impact, rollback image, and
   verification plan.
6. Operator approves the request. Approval must be explicit and time-limited.
7. The deploy runner verifies the approved `repo_ref`, target app, target
   version, and expiry before using the scoped deploy credential.
8. The deploy runner performs a normal image deploy:

   ```bash
   fly deploy -a leaderbot-openclaw-gateway
   ```

9. The deploy runner records metadata-only audit events for deploy start,
   release id/image, health check outcome, and operator-visible completion
   status.

## Audit Events

Recommended event names:

- `openclaw_redeploy_requested`
- `openclaw_redeploy_approved`
- `openclaw_redeploy_rejected`
- `openclaw_redeploy_started`
- `openclaw_redeploy_succeeded`
- `openclaw_redeploy_failed`
- `openclaw_redeploy_rollback_started`
- `openclaw_redeploy_rollback_succeeded`
- `openclaw_redeploy_rollback_failed`

Each event should include only:

- request id
- target app
- current and target OpenClaw versions
- repo ref
- release id when available
- image ref when available
- operator/service actor ids
- redacted failure class
- timestamps

Failure details should be normalized to classes such as `build_failed`,
`health_check_failed`, `deploy_timeout`, or `permission_denied`. Do not persist
raw command output if it can include environment values, tokens, webhook
payloads, or customer content.

## Verification

After deploy:

```bash
fly releases --image -a leaderbot-openclaw-gateway
curl -fsS https://leaderbot-openclaw-gateway.fly.dev/healthz
```

Then verify:

- Public routes still expose only `/facebook/webhook`, `/messenger/webhook`, and
  `/healthz` unless a reviewed change intentionally expands the set.
- Dashboard/admin/API access still requires `OPENCLAW_ADMIN_TOKEN` and an
  allowed admin host.
- Messenger webhook verification still succeeds.
- Existing state remains on `/data`, not in the image layer.
- Logs contain request ids and health metadata, not raw customer content or
  secrets.

## Rollback

Capture the previous good image before deployment:

```bash
fly releases --image -a leaderbot-openclaw-gateway
```

If the new release fails verification, redeploy the previous image recorded in
the approved request:

```bash
fly deploy --image <previous-good-image> -a leaderbot-openclaw-gateway
```

Rollback should use the same approval and audit path unless production is
already degraded and the operator invokes an incident rollback. Incident
rollback still needs metadata-only audit events with the incident id, approving
operator, previous image, restored image, and verification outcome.

Do not roll back by shelling into a machine and editing `/app/node_modules`,
`/app/package.json`, or `/app/package-lock.json`. If state migration is ever
required for an OpenClaw runtime bump, the PR must include explicit forward and
rollback notes before production approval.

## Dashboard Copy

When an image-managed install requests an OpenClaw update, show:

> This Fly/Docker gateway is managed by immutable deploy images. OpenClaw cannot
> be safely updated inside the running machine. This action will request an
> operator-approved redeploy that bumps the pinned OpenClaw version in the repo,
> builds a new image, records redacted audit metadata, and keeps the previous
> image available for rollback.

