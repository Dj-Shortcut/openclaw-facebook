## Production outcome

Choose exactly one:

- [ ] P1 direct tenant flow
- [ ] P2 customer portal
- [ ] P3 Messenger customer journey
- [ ] P4 Startpilot Test Mode
- [ ] P5 release and rollback
- [ ] Non-blocking maintenance
- [ ] Personal OpenClaw (low priority)

## What becomes demonstrably closer to done?

Describe the runnable user/production outcome. “Foundation”, “hardening”,
“readiness”, “review artifact” or “follow-up” is not an outcome by itself.

## Evidence

- Before:
- After:
- Tests/smoke:
- Production evidence or reason this PR cannot provide it yet:

## Scope control

- [ ] This does not route Leaderbot customers through OpenClaw.
- [ ] This does not create a duplicate backlog item or second source of truth.
- [ ] Any discovered subproblem was added to the selected P outcome instead of
      becoming another recurring PR theme.
- [ ] Customer data remains tenant/workspace-scoped and logs remain
      metadata-only.
- [ ] Provider quota and spend checks still happen before billable calls.

## Rollback

State the exact rollback or explain why no runtime/data state changes.
