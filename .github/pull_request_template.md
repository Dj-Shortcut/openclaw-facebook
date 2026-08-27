## Production outcome

Choose exactly one:

- [ ] P1 direct owner bot and OpenClaw retirement
- [ ] P2 user-scoped purchased-credit ledger
- [ ] P3 quota-exhaustion CTA and one-time checkout
- [ ] P4 premium quality and Mollie Test Mode journey
- [ ] P5 bounded live pilot and legacy removal
- [ ] Non-blocking maintenance
- [ ] Standalone OpenClaw Facebook channel

## What becomes demonstrably closer to done?

Describe the runnable user/production outcome. “Foundation”, “hardening”,
“readiness”, “review artifact” or “follow-up” is not an outcome by itself.

## Evidence

- Before:
- After:
- Tests/smoke:
- Production evidence or reason this PR cannot provide it yet:

## Scope control

- [ ] This does not route the Leaderbot owner bot through OpenClaw.
- [ ] This does not create a duplicate backlog item or second source of truth.
- [ ] Any discovered subproblem was added to the selected P outcome instead of
      becoming another recurring PR theme.
- [ ] Messenger state remains scoped to the exact owner/workspace, Page binding,
      privacy epoch, and pseudonymous user; logs remain metadata-only.
- [ ] This does not add or enable subscriptions, mandates, renewals, automatic
      top-ups, or usage overages.
- [ ] Provider quota and spend checks still happen before billable calls.

## Rollback

State the exact rollback or explain why no runtime/data state changes.
