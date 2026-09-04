# Leaderbot Messenger Image Bot

Leaderbot is an owner-operated commercial image bot for Facebook Messenger.
People create and edit images through natural-language messages. Each user gets
a bounded free daily allowance; the commercial experiment will offer optional
one-time purchases of premium image credits after that allowance is exhausted.

There is one business owner and one controlled runtime, not a SaaS platform for
other bot owners. The target product has no subscription, automatic renewal,
mandate, automatic top-up, or usage overage.

## Product direction

```text
Owner Facebook Page
        |
        v
Meta webhook -> Leaderbot runtime -> conversation layer
                                      |            |
                                      v            v
                              free daily quota   paid wallet
                                      \            /
                                       image provider
                                             |
                                             v
                                        Messenger
```

The paid wallet and checkout are not live product claims yet. The active
runtime is the direct Messenger bot; the repository still retains only the
reviewed migration and drain paths needed to retire historical portal,
subscription, and OpenClaw state safely. See
[`docs/operations/todo.md`](docs/operations/todo.md) for the only active plan.

## Repository layout

- `apps/image-gen`: active Messenger runtime, image pipeline, state, quota,
  privacy, storage, Mollie foundations, and minimal web surfaces.
- `apps/image-gen/storage-proxy`: bounded Cloudflare R2 storage service.
- `deploy/production`: reviewed production manifest and rollback metadata.
- `docs`: architecture, setup, security, operations, and legal runbooks.
- `src` and the root npm package: transitional OpenClaw Facebook channel. It
  will move to a standalone plugin project after its package identity, channel
  index entry, install path, and ClawHub release route are proven there.
- `deploy/fly-gateway`: legacy personal OpenClaw gateway; retirement-only.

New Leaderbot product work belongs in `apps/image-gen`. Do not route the owner
bot through OpenClaw or add commercial features to the root plugin. Until the
standalone extraction is proven, the root package stays buildable so existing
OpenClaw/ClawHub users are not broken by the migration.

## Core guarantees

- Meta webhook verification and raw-body request signatures are validated.
- Replay protection and queue deduplication prevent duplicate work.
- Conversation, quota, media, purchases, and deletion are scoped to a
  pseudonymous Messenger user and exact Page binding.
- Raw PSIDs, prompts, customer messages, access tokens, and payment credentials
  are not logged.
- Image generation remains behind user admission and global spend controls.
- `delete-my-data` fences late work and removes eligible user data.
- Paid credits will be granted only after trusted Mollie payment verification,
  never from a browser return alone.

## Current user experience

- prompt-first text-to-image;
- natural-language source-photo editing;
- multi-photo composition;
- consent and deletion flows;
- free image quota with balance notices;
- Messenger rendering of channel-neutral conversation actions.

The next commercial milestone, after direct-runtime production proof, is a
quota-exhaustion action that opens a signed one-time Mollie checkout and grants
premium credits to that exact Messenger user. Recurring billing is explicitly
outside the target product.

## Local development

Requirements:

- Node.js 24 or newer;
- pnpm 10.28.1 for `apps/image-gen`;
- Redis for queue, replay, quota, and privacy-store integration tests;
- MySQL for billing and migration integration paths.

Install and validate the active application:

```bash
pnpm install --dir apps/image-gen --lockfile-dir apps/image-gen --frozen-lockfile
pnpm --dir apps/image-gen check
pnpm --dir apps/image-gen test
pnpm --dir apps/image-gen build
```

Start development:

```bash
pnpm --dir apps/image-gen dev
```

Environment configuration starts in
[`apps/image-gen/.env.example`](apps/image-gen/.env.example) and the operational
shortlist in
[`docs/operations/ENV_SHORTLIST.md`](docs/operations/ENV_SHORTLIST.md). Never
commit production secrets.

Root/plugin validation remains separate from product validation during the
extraction:

```bash
npm ci
npm run test:plugin
npm run build
npm run openclaw:validate
npm run pack:dry
```

CI classifies exact changed paths. Product contracts always run; expensive
image-gen and migration suites run only when their source boundary changes;
plugin packaging and the legacy gateway each have their own path-scoped lane.

## Documentation

- [Architecture](docs/architecture.md)
- [Active production outcomes](docs/operations/todo.md)
- [Transitional OpenClaw channel setup](docs/setup.md)
- [Meta App Review](docs/operations/meta-app-review.md)
- [Production deployment and rollback](docs/operations/production-deployments.md)
- [Production readiness](docs/production-readiness.md)
- [Billing operations](docs/BILLING_RUNBOOK.md)
- [Cancellation and refund policy](docs/CANCELLATION_REFUND_POLICY.md)
- [Security](docs/security/SECURITY.md)
- [Storage and retention](docs/storage-proxy-r2.md)

Documentation is current-state only. Git history is the archive for removed
product plans.

## Production changes

Production releases use reviewed immutable artifacts and the protected workflow
described in
[`docs/operations/production-deployments.md`](docs/operations/production-deployments.md).
Do not use an ad-hoc Fly deploy or database migration as the normal release
path.

OpenClaw and its gateway remain in this repository only until the standalone
plugin release path and the direct Leaderbot traffic migration are proven.
Their presence is not evidence that OpenClaw remains a Leaderbot dependency.
