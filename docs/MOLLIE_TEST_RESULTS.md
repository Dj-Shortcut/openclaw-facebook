# Mollie Test Results

Environment: Mollie Test Mode only. Live credentials are prohibited.

No Mollie sandbox test was run as part of this local implementation because no
test account/key or profile activation evidence was provided. Never mark a row
passed without a dated artifact that contains no secret or customer data.

## Local automated evidence (2026-08-01)

- Image-gen `tsc --noEmit`: PASS.
- Full image-gen Vitest suite: PASS, 96 files / 842 tests.
- Root Vitest suite: PASS, 16 files / 185 tests.
- Exact public gateway route suite: PASS, 1 file / 16 tests.
- Image-gen ESLint: PASS.
- Image-gen production build and root TypeScript build: PASS.
- Offline `drizzle-kit check`: PASS with the cumulative `0009` snapshot (a
  local dummy connection string was supplied because the config requires URL
  syntax; no database connection or migration was performed).
- `git diff --check`: PASS.
- Disposable MySQL fresh/upgrade migration: NOT RUN (no database/Docker
  runtime available).

These local results validate code contracts only; they do not convert any
provider scenario below from NOT RUN to PASS.

| Scenario | Status | Required evidence |
| --- | --- | --- |
| First payment succeeds | NOT RUN | Test Payment, webhook snapshot, one entitlement after valid subscription |
| First payment fails | NOT RUN | Failed state; no entitlement |
| First payment canceled | NOT RUN | Canceled state; no entitlement |
| First payment expires | NOT RUN | Expired state; no entitlement |
| Webhook before redirect | NOT RUN | Paid state independent of redirect |
| Redirect before webhook | NOT RUN | Return remains non-authoritative/open |
| Duplicate webhook | NOT RUN | One snapshot side effect |
| Unknown Payment ID | NOT RUN | Generic 200 and no disclosure; transient failures return redacted 503 |
| Amount mismatch | NOT RUN | Manual review; no activation |
| Currency mismatch | NOT RUN | Manual review; no activation |
| Mandate pending then valid | NOT RUN | Bounded outbox retries, one Subscription |
| Bancontact then SEPA collection | NOT RUN | Direct-debit mandate and recurring Payment |
| Duplicate subscription request | NOT RUN | Exactly one remote/local Subscription |
| Recurring payment succeeds | NOT RUN | `paid_through` advances once |
| Recurring payment fails/retries | NOT RUN | Grace state; no custom money retry |
| Full refund | NOT RUN | Entitlement withdrawn; future collection canceled |
| Partial refund | NOT RUN | Manual review |
| Chargeback | NOT RUN | Access blocked and escalated |
| Cancel with paid access | NOT RUN | Remote canceled; access ends at `paid_through` |
| New payment method | NOT RUN | New first Payment; no overlapping Subscription |
| Missed webhook recovery | NOT RUN | Daily reconciliation applies snapshot once |
| No secrets/customer data in logs | NOT RUN | Captured logs/redaction assertions |
| Belgium-only checkout | NOT RUN | Non-BE request rejected |
| B2B without Peppol | NOT RUN | B2B request rejected |

Use Mollie's hosted `changePaymentState` link in Test Mode for realistic final
states, refunds and chargebacks. Recurring test Payments do not have a checkout
link; their `changePaymentState` link is the intended test control.

Overall result: **NO-GO**.
