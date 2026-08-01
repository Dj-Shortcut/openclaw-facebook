# Mollie Test Results

Environment: Mollie Test Mode only. Live credentials are prohibited.

No Mollie sandbox test was run as part of this local implementation because no
test account/key or profile activation evidence was provided. Never mark a row
passed without a dated artifact that contains no secret or customer data.

## Local automated evidence (2026-08-01)

- Image-gen `tsc --noEmit`: PASS.
- Full image-gen Vitest suite: PASS, 120 files / 1,017 tests.
- Root Vitest suite: PASS, 17 files / 197 tests.
- Exact public gateway route suite: PASS, 1 file / 16 tests.
- Image-gen ESLint: PASS.
- Image-gen production build and root TypeScript build: PASS.
- Offline `drizzle-kit check`: PASS with the cumulative `0010` snapshot (a
  local dummy connection string was supplied because the config requires URL
  syntax; no database connection or migration was performed).
- Fresh MySQL 8.4 migration through the current guarded cumulative migration
  `0010`: PASS in GitHub CI run `30715666890`, job `91410691295` on
  2026-08-01. This is fresh-database CI evidence only; it is not Mollie
  provider, existing-schema upgrade, or production migration evidence.
- `git diff --check`: PASS.
- Existing-schema upgrade migration through `0010`: NOT RUN.
- Production migration through `0010`: NOT RUN.

These local results validate code contracts only; they do not convert any
provider scenario below from NOT RUN to PASS.

### Startpilot launch scenarios

| Scenario                         | Status  | Required evidence                                                                                                     |
| -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| One-time payment succeeds        | NOT RUN | Test Payment, authenticated webhook fetch, one 30-day Startpilot entitlement and no subscription                      |
| First payment fails              | NOT RUN | Failed state; no entitlement                                                                                          |
| First payment canceled           | NOT RUN | Canceled state; no entitlement                                                                                        |
| First payment expires            | NOT RUN | Expired state; no entitlement                                                                                         |
| Webhook before redirect          | NOT RUN | Paid state independent of redirect                                                                                    |
| Redirect before webhook          | NOT RUN | Return remains non-authoritative/open                                                                                 |
| Duplicate webhook                | NOT RUN | One snapshot side effect                                                                                              |
| Unknown Payment ID               | NOT RUN | Generic 200 and no disclosure; transient failures return redacted 503                                                 |
| Amount mismatch                  | NOT RUN | Manual review; no activation                                                                                          |
| Currency mismatch                | NOT RUN | Manual review; no activation                                                                                          |
| Duplicate Startpilot purchase    | NOT RUN | At most one paid pilot entitlement for the workspace; no automatic top-up                                             |
| Startpilot limits                | NOT RUN | 300 AI answers, 20 Images 2.0 generations, max five images/day, one workspace/Page are enforced before provider calls |
| 30-day expiry                    | NOT RUN | Entitlement expires without renewal, collection, subscription, or direct-debit mandate                                |
| Full refund                      | NOT RUN | Entitlement withdrawn; no future collection exists                                                                    |
| Partial refund                   | NOT RUN | Manual review                                                                                                         |
| Chargeback                       | NOT RUN | Access blocked and escalated                                                                                          |
| Missed webhook recovery          | NOT RUN | Daily reconciliation applies snapshot once                                                                            |
| No secrets/customer data in logs | NOT RUN | Captured logs/redaction assertions                                                                                    |
| Belgium-only checkout            | NOT RUN | Non-BE request rejected                                                                                               |
| B2B without Peppol               | NOT RUN | B2B request rejected                                                                                                  |

### Unpublished subscription regression scenarios

These do not authorize or advertise a monthly offer. They remain deferred while
`premium_monthly_v1` is not publicly available.

| Scenario                        | Status   | Required evidence                              |
| ------------------------------- | -------- | ---------------------------------------------- |
| Mandate pending then valid      | DEFERRED | Bounded outbox retries, one Subscription       |
| Bancontact then SEPA collection | DEFERRED | Direct-debit mandate and recurring Payment     |
| Duplicate subscription request  | DEFERRED | Exactly one remote/local Subscription          |
| Recurring payment succeeds      | DEFERRED | `paid_through` advances once                   |
| Recurring payment fails/retries | DEFERRED | Grace state; no custom money retry             |
| Cancel with paid access         | DEFERRED | Remote canceled; access ends at `paid_through` |
| New payment method              | DEFERRED | New first Payment; no overlapping Subscription |

Use Mollie's hosted `changePaymentState` link in Test Mode for realistic final
states, refunds and chargebacks. Recurring test Payments do not have a checkout
link; their `changePaymentState` link is the intended test control.

Overall result: **NO-GO**.
