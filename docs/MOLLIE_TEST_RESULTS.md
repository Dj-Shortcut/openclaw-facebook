# Mollie test results

Environment: Mollie Test Mode only. Live credentials and real payments are
prohibited until `LAUNCH_READINESS.md` records a live GO.

No Mollie provider scenario below has been run for this release. Never mark a
row passed without dated, metadata-only evidence that contains no secret,
customer content or personal identifier.

## Credential-free automated evidence (2026-08-24)

Evidence is for PR #400 commit
`276bab2ac4f1d8396dedb055fa3f26c3c2e7360a`:

- Image Gen CI [run 32716890384](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32716890384):
  TypeScript, lint, production build and tests passed; 178 test files and 1,902
  tests passed, with 15 files/83 tests intentionally skipped in the ordinary
  unit pass.
- The same CI run executed the real Redis privacy/queue suites and a separate
  MySQL 8.4.11 billing/privacy integration lane: 25/25 targeted MySQL tests
  passed after the exact test bootstrap verified `0017_contract`. This test
  schema is not the authorized production phase.
- Image-gen migration smoke
  [run 32716890277](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32716890277)
  passed the canonical migration/rehearsal contract on MySQL 8.4.11.
- CodeQL, Gitleaks, package validation, Fallow and production dependency/uptime
  checks passed on the same commit.
- Production MySQL is recorded as 8.4.11 and recent snapshots exist, but the
  protected restore rehearsal and production `0015_base` to `0016_expand`
  transition are **NOT RUN**.
- Production currently returns HTTP 200 for `/healthz` and core `/readyz`.
  Because `MOLLIE_BILLING_PREFLIGHT_ENABLED=false`, this is **not** billing
  schema/readiness evidence and does not report `phase: "offline"`.
- No Mollie Methods, Payment, Customer, webhook, refund, chargeback, Balance or
  Settlement API call was made by this evidence pass.

These results validate code contracts only. They do not convert a provider
scenario below from **NOT RUN** to **PASS**.

## Startpilot sandbox scenarios

| Scenario                            | Status  | Required evidence                                                                                                   |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| Provider-silent offline preflight   | NOT RUN | Production `/readyz` is green with `phase: "offline"`, schema `0016_expand`, and every commercial/provider flag off |
| Bancontact launch check             | NOT RUN | Test profile exposes Bancontact for Belgium/EUR without enabling a live flag                                        |
| Belgian consumer profile            | NOT RUN | Audited, unexpired BE-consumer profile is eligible; business/Peppol buyer profiles remain blocked                   |
| One-time payment succeeds           | NOT RUN | Test Payment, authenticated webhook fetch, one 30-day Startpilot entitlement and no Subscription                    |
| First payment fails                 | NOT RUN | Failed state; no entitlement                                                                                        |
| First payment canceled              | NOT RUN | Canceled state; no entitlement                                                                                      |
| First payment expires               | NOT RUN | Expired state; no entitlement                                                                                       |
| Webhook before redirect             | NOT RUN | Paid state independent of redirect                                                                                  |
| Redirect before webhook             | NOT RUN | Return remains non-authoritative/open                                                                               |
| Duplicate webhook                   | NOT RUN | One snapshot side effect                                                                                            |
| Unknown Payment ID                  | NOT RUN | Generic 200 and no disclosure; transient failures return redacted 503                                               |
| Amount mismatch                     | NOT RUN | Manual review; no activation                                                                                        |
| Currency mismatch                   | NOT RUN | Manual review; no activation                                                                                        |
| Duplicate Startpilot purchase       | NOT RUN | At most one paid pilot entitlement for the workspace; no automatic top-up                                           |
| Startpilot limits                   | NOT RUN | 300 AI answers, 20 image generations, max five images/day and one workspace/Page are enforced before provider calls |
| 30-day expiry                       | NOT RUN | Entitlement expires without renewal, collection, Subscription or mandate                                            |
| Full refund                         | NOT RUN | Entitlement withdrawn per approved policy; no future collection exists                                              |
| Partial refund                      | NOT RUN | Human-visible manual review                                                                                         |
| Chargeback                          | NOT RUN | Access blocked and a human-visible operator incident is created                                                     |
| Missed webhook recovery             | NOT RUN | Reconciliation applies the exact snapshot once                                                                      |
| Billing disabled after URL exposure | NOT RUN | New checkout is blocked while webhook, reconciliation and exact safety drain still process the exposed Payment      |
| No secrets/customer data in logs    | NOT RUN | Captured logs and serialized error/redaction assertions                                                             |
| B2B buyer request                   | NOT RUN | Business/Peppol buyer profile is rejected; seller Peppol identity does not change buyer eligibility                 |
| Paid image quota                    | NOT RUN | Provider smoke respects 5/day and 20/period customer counters plus separately verified provider-account hard limit  |

## Dormant subscription regression scenarios

The public catalog does not expose a recurring offer. These cases protect
unpublished foundation code and do not authorize advertising, creating or
collecting a Subscription.

| Scenario                        | Status   | Required evidence                              |
| ------------------------------- | -------- | ---------------------------------------------- |
| Mandate pending then valid      | DEFERRED | Bounded outbox retries and one Subscription    |
| Bancontact then SEPA collection | DEFERRED | Direct-debit mandate and recurring Payment     |
| Duplicate subscription request  | DEFERRED | Exactly one remote/local Subscription          |
| Recurring payment succeeds      | DEFERRED | `paid_through` advances once                   |
| Recurring payment fails/retries | DEFERRED | Grace state; no custom money retry             |
| Cancel with paid access         | DEFERRED | Remote canceled; access ends at `paid_through` |
| New payment method              | DEFERRED | New first Payment; no overlapping Subscription |

Use only Mollie's documented Test Mode controls when these cases are eventually
approved. Recurring test Payments do not have a checkout link.

Overall result: **NO-GO**.
