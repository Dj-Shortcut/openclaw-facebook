# Mollie test results

Environment: Mollie Test Mode only. Live credentials and real payments are
prohibited until `LAUNCH_READINESS.md` records a live GO.

No Mollie provider scenario that calls Mollie has been run for this release.
The provider-silent offline preflight has passed. Never mark any other row
passed without dated, metadata-only evidence that contains no secret, customer
content or personal identifier.

## Production offline preflight evidence (2026-08-25)

Evidence is for reviewed main commit
`0b4a9c66b57a9d6fdbd9dde49b778cba36fca17d` and protected production deploy
[run 32820475232](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32820475232):

- the protected inspection and deployment completed successfully for exact
  identity `deploy-32820475232-1`;
- production kept immutable image digest
  `sha256:33390bc580305a8549667633a9a2f9eac30dcd34262d11f75270a40aaf5bfd1e`;
- `/healthz` returned `ok` and `/readyz` returned HTTP 200 with
  `phase: "offline"` and every reported check green;
- `MOLLIE_MODE=test` and only the provider-silent preflight were enabled; all
  commercial, live, drain, entitlement, notification, quota/finalization and
  accounting execution flags remained disabled;
- no Mollie API, checkout or payment call was made.

## Credential-free automated evidence (2026-08-24)

Evidence is for PR #400 credential-free code commit
`ee59b09cbbaec76ebacf6eb8faa36ca3a94122bb`:

- Image Gen CI [run 32740281414](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32740281414):
  TypeScript, release lint/format, production build and tests passed; 184 test
  files and 1,993 tests passed, with 17 files/98 tests intentionally skipped in
  the ordinary pass.
- The same CI run executed the real Redis privacy/queue suites and a separate
  MySQL 8.4.11 billing/privacy integration lane: 31/31 targeted MySQL tests
  passed after the exact test bootstrap verified `0017_contract`. This test
  schema is not the authorized production phase.
- Image-gen migration smoke
  [run 32740281430](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32740281430)
  passed the canonical migration/rehearsal contract on MySQL 8.4.11.
- CodeQL, Gitleaks, package validation, Fallow and production dependency/uptime
  checks passed on the same commit.
- No Mollie Methods, Payment, Customer, webhook, refund, chargeback, Balance or
  Settlement API call was made by this evidence pass.

These results validate code contracts only. They do not convert a provider
scenario below from **NOT RUN** to **PASS**.

## Startpilot sandbox scenarios

| Scenario                            | Status  | Required evidence                                                                                                                                       |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-silent offline preflight   | PASS    | 2026-08-25 protected deploy run 32820475232: production `/readyz` green with `phase: "offline"` and every commercial/provider flag off                  |
| Bancontact launch check             | NOT RUN | Test profile exposes Bancontact for Belgium/EUR without enabling a live flag                                                                            |
| Belgian consumer profile            | NOT RUN | Audited, unexpired BE-consumer profile is eligible; business/Peppol buyer profiles remain blocked                                                       |
| One-time payment succeeds           | NOT RUN | Test Payment, authenticated webhook fetch, one 30-day Startpilot entitlement and no Subscription                                                        |
| One-time payment fails              | NOT RUN | Failed state; no entitlement                                                                                                                            |
| One-time payment canceled           | NOT RUN | Canceled state; no entitlement                                                                                                                          |
| One-time payment expires            | NOT RUN | Expired state; no entitlement                                                                                                                           |
| Webhook before redirect             | NOT RUN | Paid state independent of redirect                                                                                                                      |
| Redirect before webhook             | NOT RUN | Return remains non-authoritative/open                                                                                                                   |
| Duplicate webhook                   | NOT RUN | One snapshot side effect                                                                                                                                |
| Unknown Payment ID                  | NOT RUN | Generic 200 and no disclosure; transient failures return redacted 503                                                                                   |
| Amount mismatch                     | NOT RUN | Manual review; no activation                                                                                                                            |
| Currency mismatch                   | NOT RUN | Manual review; no activation                                                                                                                            |
| Duplicate Startpilot purchase       | NOT RUN | At most one paid pilot entitlement for the workspace; no automatic top-up                                                                               |
| Startpilot limits                   | NOT RUN | Guided image controls, 20 workspace-wide image attempts, max five/day and one workspace/Page are enforced before provider transport; replays count once |
| 30-day expiry                       | NOT RUN | Entitlement expires without renewal, collection, Subscription or mandate                                                                                |
| Full refund                         | NOT RUN | Entitlement withdrawn per approved policy; no future collection exists                                                                                  |
| Partial refund                      | NOT RUN | Human-visible manual review                                                                                                                             |
| Chargeback                          | NOT RUN | Access blocked and a human-visible operator incident is created                                                                                         |
| Missed webhook recovery             | NOT RUN | Reconciliation applies the exact snapshot once                                                                                                          |
| Billing disabled after URL exposure | NOT RUN | New checkout is blocked while webhook, reconciliation and exact safety drain still process the exposed Payment                                          |
| No secrets/customer data in logs    | NOT RUN | Captured logs and serialized error/redaction assertions                                                                                                 |
| B2B buyer request                   | NOT RUN | Business/Peppol buyer profile is rejected; seller Peppol identity does not change buyer eligibility                                                     |
| Paid image quota                    | NOT RUN | Provider smoke proves workspace-scoped limits of 5/day and 20/period, idempotent replay, and the separately verified provider-account hard limit        |

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
