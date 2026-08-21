# Leaderbot Mollie launch readiness

Status on 2026-08-22, current Sol draft branch: **the last published savepoint
passed the credential-free code gate; the current privacy/cost hardening batch
is pending its final full matrix and GitHub CI; live launch remains NO-GO**.
The exact last-green head is recorded in PR #375 and its checks.

Commercial billing, live billing, deployment and real charges remain disabled.
No API key is required to run the preflight described here.

## Implemented contract and evidence state

The published contracts below were locally/CI verified at the last green
savepoint. Additions in the current privacy/cost hardening batch do not become
final-head evidence until its full local matrix and GitHub CI pass.

- Server-authoritative `EUR 19.00` one-time Startpilot catalog: 30 days, one
  workspace/Page, 300 AI answers, 20 image generations and five images/day.
- Server-owned billing profile attestation with version, expiry, revocation,
  evidence HMAC and admin audit. Client country/business input is not trusted.
- Tenant/mode-scoped checkout, provider-operation state, webhook routes,
  ledger, entitlement, outbox and exact Page handoff identity.
- Atomic Redis spend reservation and durable MySQL AI-answer finalization with
  restart recovery and conservative handling only after transport starts.
- Workspace/connection/binding/privacy-scoped ingress, generation queues,
  state, completions, Page credentials and image/audio/video/Graph effects.
- Durable erasure for application-owned Messenger/WhatsApp state, assets,
  queues and provider fences, replay receipts, bounded PII TTLs and
  legacy-queue readiness refusal. Exact host-owned OpenClaw transcript erasure
  remains the external blocker listed below.
- DB-driven tenant scheduler with execution epochs, leases, fairness,
  heartbeats, commercial-disable fencing and an always-available safety drain.
- Signed, idempotent, provider-key-free customer/operator notification receiver
  with durable delivery, dead-letter readiness and scope-mismatch escalation.
- Bounded tenant/mode/date accounting CSV export and GET-only account-level
  import state machine with quarantine for unknown/conflicting events.
- Exact production migration runner for the single supported `0014` to final
  `0015` transition: MySQL 8.4.11 runtime contract, singleton lock, manifest and
  schema fingerprints, partial-state refusal, backfill preflights and rehearsal.
- `/healthz` remains liveness; `/readyz` validates Redis, schema, scheduler,
  notification, accounting, quota/finalization and configured exposure state.

Published evidence and the current validation status are recorded in
`docs/MOLLIE_TEST_RESULTS.md`.

## Credential-free gate classification

### A — repository work

The current privacy/cost hardening batch remains an open repository gate until
its final full local matrix and GitHub CI pass on one exact head. Repository GO
has not yet been reissued for those uncommitted changes. Any new repository
finding also keeps A open until it is fixed and the same gates are green again.

### B — external or human evidence

- Mollie Test Mode: externally inject a `test_` key, verify Bancontact and run
  the complete provider matrix. Never paste the key into chat, logs or a PR.
- Facebook: isolated Test Page/User evidence for Page delivery, claim,
  disconnect/rebind, response-window recovery and cross-tenant refusal.
- OpenAI: controlled image generation/edit smoke proving configured estimates
  and caps block before the provider boundary.
- OpenClaw host: provide and verify an exact non-archiving erasure API for an
  ordinary session transcript. OpenClaw 2026.7.2-beta.7 only exposes deletion
  behavior that retains an archive, so Leaderbot deliberately keeps deletion
  pending/fails closed when such a transcript exists.
- Deployment: restore a redacted production-like backup, run the canonical
  migration/recovery procedure, verify Fly process/image/config parity and
  retain metadata-only evidence. The separate gateway Memory Core volume repair
  must be rehearsed on a copy before the new gateway image is deployed.
- Human: product, legal, privacy, accounting, refund/withdrawal, retention,
  notification receiver, monitoring, incident-response and first-payment
  approvals.
- Live-read-only Mollie Balances/Settlements reconciliation and accountant
  approval; Test Mode cannot supply this evidence.

## Credential-free preflight

Keep `MOLLIE_BILLING_ENABLED=false`, `MOLLIE_MODE=test` and
`MOLLIE_LIVE_BILLING_ENABLED=false`. Set
`MOLLIE_BILLING_PREFLIGHT_ENABLED=true` only in a safe test environment after
the final `0015` migration. The preflight makes no Mollie provider call.

It requires:

- `DATABASE_URL`, `REDIS_URL`, `PORTAL_HANDOFF_TOKEN_SECRET`,
  `BILLING_PROFILE_EVIDENCE_HMAC_SECRET` and
  `MOLLIE_CREDENTIAL_GENERATION_ID`;
- explicit `MOLLIE_BILLING_SCHEDULER_MODE=pilot_pin|multi_tenant`; pilot mode
  also requires `MOLLIE_BILLING_WORKER_WORKSPACE_ID`;
- positive finite `MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD`,
  `MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD`,
  `MESSENGER_USER_DAILY_SPEND_CAP_USD`,
  `OPENAI_IMAGE_ESTIMATED_COST_USD` and positive integer
  `MESSENGER_GLOBAL_DAILY_IMAGE_CAP`;
- `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=true`,
  `AI_ANSWER_FINALIZATION_DRAIN_ENABLED=true` and
  `BILLING_NOTIFICATION_PLANE_ENABLED=true` for the full paid readiness chain;
- the notification URL/key/source/allowlist/receiver-ACK settings listed in
  `.env.example`, with distinct customer/operator keys and no secret in URLs.

Readiness must remain red for stale schema, disabled required lane, missing
heartbeat, overdue backlog, dead letter, legacy queue content, invalid cap or
missing finalization/notification contract.

## Decision rule

- **Repository GO:** all A items closed and required CI green.
- **Sandbox GO:** repository GO plus all Mollie/Facebook/OpenAI Test Mode rows
  passed with redacted evidence.
- **Live GO:** sandbox GO plus migration/backup/operations/legal/accounting
  approvals and an explicitly authorized human launch window.

Current decision: **repository revalidation pending for the current batch; full
privacy, sandbox and live NO-GO until that validation, the external OpenClaw
transcript capability and the remaining provider/human evidence are complete**.
