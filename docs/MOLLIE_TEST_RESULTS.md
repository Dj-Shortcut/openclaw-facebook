# Mollie test results

Release candidate: current PR #375 Sol draft branch on 2026-08-18. The exact
reviewed head is recorded in the PR body and GitHub checks.

No Mollie, Facebook or OpenAI provider test was run. No credential was
requested or used. Automated rows prove local/CI contracts only; provider rows
remain `NOT RUN` until an operator injects test credentials out of band.

## Automated evidence

- Image-gen Vitest: **1,429 passed, 31 skipped** across 154 files.
- Focused subscription cancellation and notification delivery: **38/38**.
- Billing execution on MySQL 8.4: **10/10**, including two-connection
  disable/exposure, lease-loss and safety-cancellation boundaries.
- Portal handoff on MySQL 8.4: **4/4**, including concurrent claim and
  capability-generation rotation.
- Payment/checkout chain on MySQL 8.4: **5/5**, including twelve concurrent
  repeated checkouts with one fake-provider create, twelve concurrent paid
  snapshots with one ledger/entitlement/handoff effect, monotone delayed
  snapshots, terminal states without access, and one claim-to-paid-to-recovery
  chain without a second checkout.
- TypeScript, release ESLint/Prettier, production build, Drizzle schema check,
  final `0015` rehearsal, product-boundary checks and diff check: PASS.
- Final GitHub head: main checks, MySQL/Drizzle migration smoke, validate,
  CodeQL, secret scan, codebase-health and ClawHub dry-run: PASS.
- Migration evidence covers fresh install and exact `0014` to final `0015` on
  pinned MySQL 8.4.11, exact schema/history fingerprints, partial-state refusal,
  backfills, negative constraints and recovery. It is not a production backup
  rehearsal or deployment authorization.
- Real Redis integration lanes exercise spend Lua reservation and generation
  queue/completion tombstone, TTL and race contracts in CI.

## Combined release matrix

| Scenario                                    | Automated contract                                                          | Provider evidence             |
| ------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| One-time payment succeeds                   | PASS: one paid ledger effect, entitlement and handoff outbox                | NOT RUN                       |
| Failed/canceled/expired payment             | PASS: no entitlement or handoff                                             | NOT RUN                       |
| Duplicate/delayed webhook                   | PASS: monotone snapshot and exactly-once effects                            | NOT RUN                       |
| Repeated/concurrent checkout                | PASS: one intent/provider-create boundary                                   | NOT RUN                       |
| Profile revoke/expiry or commercial disable | PASS: URL/exposure fenced; exact safety reconciliation/cancellation         | NOT RUN                       |
| Token replay/second claim                   | PASS: one membership/audit winner; old capability stays invalid             | NOT RUN                       |
| Wrong user/workspace/Page                   | PASS: fail closed at immutable ownership/privacy boundary                   | NOT RUN                       |
| Disconnect/rebind                           | PASS: binding epoch blocks stale job/send/provider effects                  | NOT RUN                       |
| Closed Messenger window                     | PASS: no paid send; fresh verified inbound may rearm the same row           | NOT RUN                       |
| Transient/ambiguous send                    | PASS: bounded identity, no second charge/capability                         | NOT RUN                       |
| Privacy deletion race                       | PASS: tombstone/CAS prevents queue/state/completion/send resurrection       | NOT RUN                       |
| Spend and AI-answer quota                   | PASS: distributed reservation and durable commit/release recovery           | NOT RUN OpenAI smoke          |
| Notification failure                        | PASS: signed idempotent receipt, retry, dead letter and key-free escalation | NOT RUN receiver operations   |
| Accounting export/import                    | PASS: bounded stream and GET-only fake reader/quarantine contracts          | NOT RUN live read-only Mollie |

## Mollie Test Mode matrix

Each row needs a dated, redacted artifact. Use one isolated test workspace and
never record a key, PSID, Page token, customer message or full provider payload.

| Provider scenario                | Status  | Required observation                                         |
| -------------------------------- | ------- | ------------------------------------------------------------ |
| Bancontact method available      | NOT RUN | One-time Startpilot method is enabled in Test Mode           |
| Paid checkout                    | NOT RUN | Authenticated fetch, one entitlement/outbox, no subscription |
| Failed/canceled/expired checkout | NOT RUN | Terminal state, no entitlement/outbox                        |
| Webhook before/after redirect    | NOT RUN | Redirect is non-authoritative; provider fetch wins           |
| Duplicate/delayed webhook        | NOT RUN | One ledger/entitlement/outbox identity                       |
| Unknown/mismatched payment       | NOT RUN | Redacted retry/review, no entitlement                        |
| Concurrent repeated checkout     | NOT RUN | One remote create and one intent                             |
| Refund/chargeback                | NOT RUN | Containment/manual review and exact notification             |
| Missed webhook                   | NOT RUN | Reconciliation applies the snapshot once                     |
| Disable after provider start     | NOT RUN | Known resource recorded then exactly contained               |

## Facebook/OpenAI Test Mode matrix

| Scenario                            | Status  | Required observation                                                      |
| ----------------------------------- | ------- | ------------------------------------------------------------------------- |
| Page-scoped paid handoff and claim  | NOT RUN | One delivery/capability/claim/membership                                  |
| Two Pages/workspaces and wrong user | NOT RUN | Exact isolation; zero cross-tenant effects                                |
| Disconnect/rebind and closed window | NOT RUN | Fail closed, then same-row verified recovery                              |
| Transient Graph failure             | NOT RUN | Bounded attempts; no second charge/capability                             |
| GPT Image generation/edit           | NOT RUN | Admission before provider; estimate/caps remain positive and conservative |
| Delete during slow provider/send    | NOT RUN | No persisted output/state/send after tombstone                            |

Overall result: **repository code/CI PASS; provider sandbox and live launch
NO-GO**.
