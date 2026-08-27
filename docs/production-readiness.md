# Production Readiness

Status: **NO-GO for broad Leaderbot customer launch** until the direct customer
journey in `apps/image-gen` has production evidence. Personal OpenClaw health is
tracked separately and is not a customer launch gate.

Canonical priorities and remaining work live in
[`operations/todo.md`](operations/todo.md). This document defines the final
deploy and smoke evidence, not a second backlog.

## Runtime split

### Leaderbot customers

```text
Customer Page -> Meta webhook -> apps/image-gen -> tenant runtime -> Messenger
```

`apps/image-gen` owns webhook verification, workspace resolution, conversation
state, image generation, storage, consent, quota, billing, deletion, portal and
customer delivery. No customer request traverses OpenClaw or its legacy bridge.

### Personal OpenClaw

```text
Owner Page -> Meta webhook -> OpenClaw Facebook plugin -> personal OpenClaw
```

The checked-in gateway stays pairing-only, has the Leaderbot bridge disabled,
and exposes only `/facebook/webhook` and `/healthz`. It does not proxy portal or
legal routes and does not participate in customer quota or billing. Its owner
Page uses a different Meta app and credentials from the Leaderbot customer app.

## Leaderbot release evidence

Before a customer release:

- deploy only an approved immutable `apps/image-gen` and storage-proxy digest;
- record the exact rollback digests;
- verify the approved database schema and a recent restore rehearsal;
- verify direct Meta callback configuration points to `apps/image-gen`;
- verify each receiving Page resolves to exactly one active workspace;
- verify tenant queue, storage, usage and deletion readiness;
- verify portal, legal, health, readiness and required webhook routes;
- confirm no internal/admin/debug or personal OpenClaw surface is exposed;
- confirm logs and monitoring contain metadata only.

Production smoke with an approved test workspace/Page:

1. portal login, workspace load and Messenger connect/disconnect;
2. ordinary text response from the Leaderbot conversation runtime;
3. consent button, typed grant, refusal and repeated-prompt protection;
4. prompt-first image generation;
5. source-photo edit;
6. multi-photo composition for one-message and sequential uploads;
7. daily/monthly quota exhaustion before a provider call;
8. provider/delivery failure and dead-letter visibility;
9. `delete-my-data`, queued-work cancellation and late-output suppression;
10. rollback to the recorded image without tenant or schema drift.

Store only commit/digest, random request id, workspace-safe outcome codes,
bounded counts, durations and rollback metadata. Never store customer content,
raw PSIDs, prompts, tokens, media URLs or generated images as smoke evidence.

## Personal gateway evidence

Personal OpenClaw releases use their own low-priority checklist:

- pairing or explicit owner allowlist remains active;
- the Leaderbot bridge remains disabled;
- no customer portal/image-gen origin is configured;
- `/healthz` and the owner Messenger text turn work;
- gateway UI/API remain shielded;
- rollback is recorded.

Failure here blocks only that personal release unless a shared security or
data-loss regression also affects Leaderbot.

## Commands

Use only the approval-protected GitHub workflows documented in
[`operations/production-deployments.md`](operations/production-deployments.md).
Do not run local `fly deploy`, ad-hoc migrations or manual rollback commands for
normal production releases.
