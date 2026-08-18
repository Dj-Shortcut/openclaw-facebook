# Leaderbot Mollie launch readiness

Status on 2026-08-18, Sol head `ed1822b`: **credential-free code gate PASS;
live launch NO-GO**.

Commercial billing, live billing, deployment and real charges remain disabled.
No API key is required to run the preflight described here.

## Implemented and locally/CI verified

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
- Durable privacy erasure, replay receipts, bounded PII TTLs and legacy-queue
  readiness refusal.
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

Final-head evidence is recorded in `docs/MOLLIE_TEST_RESULTS.md`.

## Credential-free gate classification

### A — repository work

No known P0/P1 code or test blocker remains on `ed1822b`. The release config,
checklist and evidence documents are synchronized with the final code. One P2
test-readability item remains: split the mocked epoch/tenant labels that share
the same empty-select fixture. Real MySQL scope/race coverage is authoritative;
this P2 does not weaken the release contract.

Any new repository finding reopens A and blocks credential injection until it
is fixed and CI is green again.

### B — external or human evidence

- Mollie Test Mode: externally inject a `test_` key, verify Bancontact and run
  the complete provider matrix. Never paste the key into chat, logs or a PR.
- Facebook: isolated Test Page/User evidence for Page delivery, claim,
  disconnect/rebind, response-window recovery and cross-tenant refusal.
- OpenAI: controlled image generation/edit smoke proving configured estimates
  and caps block before the provider boundary.
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

Current decision: **repository GO; sandbox and live NO-GO**.
