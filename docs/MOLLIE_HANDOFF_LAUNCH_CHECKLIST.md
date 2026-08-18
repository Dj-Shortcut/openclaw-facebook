# Mollie + Messenger handoff launch checklist

Status on 2026-08-18: **NO-GO** for live billing.

This is the single release checklist for the combined Luna payment-readiness
work from PR #374 and Terra handoff-readiness work from PR #373. It does not
authorize a production deployment, a live Mollie secret, or a real charge.
Live secret injection and the first real payment remain explicit human actions
after every blocker below is closed.

## Integrated contract

The release candidate must preserve this chain:

`Messenger inbound -> Page-bound portal handoff -> Facebook portal login ->`
`one-use claim -> workspace membership -> Mollie checkout -> authenticated`
`payment fetch/webhook -> paid entitlement -> billing outbox -> Page-scoped`
`Messenger delivery or auditable recovery`

The boundary between the two inputs is:

- Luna owns payment truth and emits one `send_portal_handoff` outbox item with
  the stable payment intent ID, privacy-peppered Messenger sender key, and Page
  ID.
- Terra consumes that operation without changing payment truth. It validates
  Page/workspace state, reuses one delivery capability across bounded transient
  retries, and atomically revalidates the Page before claim and membership.
- A delivery failure must never reopen checkout, change paid state, or create a
  second charge.

## Release test matrix

The local automated result below is component/integration evidence with fakes;
it is not Mollie-provider or real-MySQL evidence.

| Scenario                             | Local result                                                                                                        | Remaining release evidence                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Happy path                           | PASS: paid Startpilot state emits one outbox item; delivery, claim, membership, and billing continuation tests pass | Run one production-like Test Mode E2E through the real webhook and Page                     |
| Duplicate or delayed webhook         | PASS: deduplication, replay, and reconciliation contracts pass                                                      | Repeat with Mollie Test Mode and real MySQL                                                 |
| Failed, canceled, or expired payment | PASS: terminal states do not activate the paid path                                                                 | Record provider Test Mode outcomes                                                          |
| Repeated checkout                    | PASS: checkout intent/idempotency guards pass                                                                       | Exercise concurrent requests against real MySQL and Mollie Test Mode                        |
| Token replay or second claim         | PASS: consumed, expired, revoked, and inactive capabilities fail closed                                             | Exercise the portal against the production-like database                                    |
| Wrong authenticated user             | PASS: another user cannot reuse a consumed handoff as billing context because `claimedByUserId` must match          | Exercise two Facebook Test Users end to end                                                 |
| Wrong/cross-tenant/disconnected Page | PASS: send and claim fail closed for missing, ambiguous, changed, disconnected, or cross-workspace Page bindings    | Exercise two test workspaces/Pages in a production-like environment                         |
| Closed Messenger response window     | PASS for containment: no token is created and no send occurs                                                        | **BLOCKED:** there is no authenticated human re-drive; the outbox failure is terminal       |
| Transient Messenger send failure     | PASS: the capability is revoked and a bounded retry reuses only the same delivery identity                          | Exercise a controlled transient Graph failure with a test Page                              |
| Recovery without second charge       | PASS for automatic transient retry; payment truth is not reopened                                                   | **BLOCKED:** paid users with terminal delivery failure have no approved human recovery path |

## Remaining blockers

| Severity | Owner        | Blocker                                                                                                                                                        | Smallest next action                                                                                                                                                      |
| -------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Sol          | Mollie Test Mode and production-like Page/token/outbox E2E evidence is absent                                                                                  | Use an isolated test workspace, test key, Facebook Test Users/Page, and redacted dated artifacts to run every row in `MOLLIE_TEST_RESULTS.md` plus the matrix above       |
| Critical | Luna + Terra | Real-MySQL concurrency and integrity evidence is absent for checkout/webhook/outbox deduplication, delivery-key uniqueness, claim locking, and membership      | Add a MySQL 8.4 integration job that runs concurrent duplicate checkout/webhook/delivery/claim attempts and asserts one paid effect, one active capability, and one claim |
| Critical | Sol          | The supported existing-schema upgrade, partial-failure recovery, and rollback rehearsal through migrations `0013` and `0014` is absent                         | Restore a redacted production-like backup into disposable MySQL, rehearse the ordered migration and recovery procedure, and retain the artifact                           |
| High     | Terra        | Human recovery is deliberately fail-closed, so a paid user with a terminal closed-window or Page-state failure cannot be re-driven                             | Bind recovery to one failed `send_portal_handoff` outbox ID and an authenticated, non-forgeable support principal; audit it and prove no checkout/charge occurs           |
| Critical | Luna         | Existing paid-runtime gates remain open: atomic spend reservation, durable AI-answer finalization, tenant-partitioned queue/scheduler, and full Page/quota E2E | Close and concurrency-test each gate already listed in `LAUNCH_READINESS.md`; do not enable paid enforcement before then                                                  |
| Critical | Sol          | Legal, privacy, accounting, refund/withdrawal, retention, monitoring, and operator approvals remain incomplete                                                 | Obtain written approvals and attach redacted operational evidence before changing any live flag                                                                           |

## Ordered launch procedure

Do not proceed past the preparation section while the verdict is NO-GO.

### 1. Preparation and migration rehearsal

- Keep `MOLLIE_BILLING_ENABLED=false`,
  `MOLLIE_LIVE_BILLING_ENABLED=false`,
  `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=false`, and
  `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED=false` in production.
- Pause checkout and billing/outbox workers, drain in-flight work, take a
  verified database backup, and record the current application and schema
  versions.
- Run the duplicate Page-binding preflight from `LAUNCH_READINESS.md`; the
  result must be empty.
- Apply the full Drizzle chain in numeric order. For this combined change,
  `0013_purple_greymalkin.sql` must precede
  `0014_portal_handoff_delivery_idempotency.sql`.
- Verify after `0013` that `billing_outbox.event_type` accepts
  `send_portal_handoff`. Verify after `0014` that
  `portalHandoffTokens.deliveryIdempotencyKeyHash` exists and has the unique
  index `portalHandoffTokens_delivery_key_hash_unique`.
- Re-run schema checks and the real-MySQL concurrency suite before starting any
  worker.

Rollback is application-first: disable billing and workers, roll the app back,
and preserve financial/outbox/audit rows. Prefer a forward-fix over destructive
DDL. Do not drop `0014` while any delivery row can be retried; doing so removes
the idempotency invariant. Do not remove the `0013` enum member while any
`send_portal_handoff` row exists. Restore the verified backup only under the
approved incident procedure.

### 2. Fly configuration and secrets

- Keep the image-gen `app` and `worker` processes on the same release and give
  both the same database, Redis, privacy, Page-delivery, and handoff-secret
  configuration. Keep at least the HTTP app machine running for webhook health.
- Verify HTTPS, `/healthz`, the guarded customer portal/handoff routes, and the
  exact public `POST /api/webhooks/mollie/payments` route. Reject GET,
  trailing-slash, singular, and lookalike webhook paths.
- Set `APP_BASE_URL` and `PORTAL_BASE_URL` to HTTPS origins only. Set
  `MOLLIE_PAYMENT_WEBHOOK_URL` to the exact HTTPS webhook URL. Bind
  `MOLLIE_BILLING_WORKER_WORKSPACE_ID` to the one isolated pilot workspace.
- Verify non-secret flags and settings:
  `MOLLIE_MODE`, `MOLLIE_BILLING_ENABLED`,
  `MOLLIE_LIVE_BILLING_ENABLED`,
  `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED`,
  `MOLLIE_RECONCILIATION_ENABLED`,
  `MOLLIE_WEBHOOK_RATE_LIMIT_PER_MINUTE`, `BILLING_SUPPORT_EMAIL`, and the
  gateway's `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED`.
- Required secret **names** for the image-gen/portal/billing side of this path
  are `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PRIVACY_PEPPER`,
  `FB_PAGE_ACCESS_TOKEN`, `MOLLIE_API_KEY`,
  `PORTAL_HANDOFF_TOKEN_SECRET`, `CONVERSATION_SCOPE_HMAC_SECRET`,
  `MESSENGER_GENERATION_PARTITION_SECRET`, `OPENAI_API_KEY`, and
  `INTERNAL_IMAGE_REQUEST_TOKEN` when the gateway bridge is enabled. The
  corresponding public-gateway secret names are `FB_VERIFY_TOKEN`,
  `FB_APP_SECRET`, `FB_PAGE_ACCESS_TOKEN`, `OPENCLAW_ADMIN_TOKEN`, and
  `LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN`; deployments using the documented
  legacy aliases must map them deliberately rather than configuring two
  different values. Do not place values in source, logs, issues, PRs, prompts,
  or support notes. `PORTAL_HANDOFF_TOKEN_SECRET` must be a dedicated 32+
  character secret shared by all relevant app/worker instances; rotate it only
  after pending delivery rows drain or expire. Manual recovery must not rely on
  the shared `ADMIN_TOKEN` as operator identity.

### 3. Test Mode gate

- Use only `MOLLIE_MODE=test`, a test-key `MOLLIE_API_KEY`, and
  `MOLLIE_LIVE_BILLING_ENABLED=false`.
- Enable enforcement and billing only in the isolated test workspace after the
  migration, worker, Redis, Page connection, and quota preflights pass.
- Verify Bancontact on the Mollie Test profile, then execute every scenario in
  `MOLLIE_TEST_RESULTS.md` and the combined matrix above. Capture only redacted,
  metadata-level evidence.
- Confirm one payment effect, one entitlement, one deduplicated
  `send_portal_handoff` item, one delivery capability, one claim, and the stored
  membership role. Confirm all failure paths create no second charge.
- Rehearse automatic transient retry and the approved paid-user recovery flow.
  The current fail-closed manual route does not satisfy this step.

### 4. Monitoring and paid-user recovery

- Alert on `mollie_payment_webhook_failed_retryable`,
  `mollie_payment_webhook_rate_limited`, `billing_outbox_dispatch_failed`,
  `billing_outbox_failed`, `billing_outbox_operator_action_required`,
  `portal_handoff_send_failed`, `portal_handoff_revoke_failed`, and terminal
  `portal_handoff_send_skipped` reasons. Track queue age, retry count, terminal
  job count, webhook latency, reconciliation anomalies, and paid-without-
  entitlement or paid-without-delivery mismatches by workspace-scoped metadata.
- Never log raw PSIDs, Page access tokens, handoff tokens/URLs, Mollie secrets,
  messages, or customer content.
- For a paid user, first verify provider payment and local entitlement without
  changing either. Retry only the same failed outbox operation/delivery
  identity. Require an authenticated support principal, customer approval, and
  an audit record. Never initiate checkout or a second payment as recovery.
- Until that authenticated recovery mechanism exists, leave manual recovery
  disabled and treat the launch as NO-GO.

### 5. Human-only live switch and first smoke payment

This section may be executed only after a documented human GO.

1. An authorized operator installs the live `MOLLIE_API_KEY` out of band; no
   agent reads or prints it.
2. Set `MOLLIE_MODE=live` while all billing exposure remains off. Re-run
   readiness, HTTPS/origin, method, webhook, worker, Page, quota, and monitoring
   checks.
3. Enable entitlement/AI-answer enforcement, then billing, and finally the
   separate `MOLLIE_LIVE_BILLING_ENABLED` kill switch in the approved order.
4. A human performs one controlled low-volume real Startpilot payment in the
   designated pilot workspace.
5. Verify in order: authenticated webhook fetch, one paid ledger effect, one
   entitlement, one outbox item, Page-scoped Messenger delivery, one portal
   claim, correct membership, redacted observability, and no duplicate charge.
6. Disable the live billing kill switch immediately on any mismatch. Preserve
   financial records and follow the incident/rollback procedure; never repair a
   failed delivery by charging again.
