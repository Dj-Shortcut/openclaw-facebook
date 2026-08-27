# Leaderbot Messenger Image Bot

Leaderbot is an owner-operated commercial image bot for Facebook Messenger.
People can create and edit images through natural-language messages. Each user
receives a bounded free daily allowance; the product is being migrated toward
optional one-time purchases of premium image credits.

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

The paid path is implemented behind default-off rollout flags and is not yet
approved for production. The current code still contains legacy workspace
billing, a tenant portal, subscriptions, and an OpenClaw plugin while the
migration is completed. See
[`docs/operations/todo.md`](docs/operations/todo.md) for the only active plan.

## Repository layout

- `apps/image-gen`: active Messenger runtime, image pipeline, state, quota,
  privacy, storage, Mollie foundations, and web surfaces.
- `apps/image-gen/storage-proxy`: bounded Cloudflare R2 storage service.
- `docs`: current architecture, setup, security, operations, and legal runbooks.
- `deploy/production`: reviewed production manifest and rollback metadata.
- `src`: legacy OpenClaw Facebook plugin; frozen pending removal.
- `deploy/fly-gateway`: legacy OpenClaw deployment; retirement-only.
- `apps/customer-app`: legacy multi-tenant customer portal; pending removal.

New product work belongs in `apps/image-gen`. Do not route Messenger traffic
through OpenClaw or add features to the legacy gateway.

## Core guarantees

- Meta webhook verification and request signatures are validated.
- Replay protection and queue deduplication prevent duplicate work.
- Conversation, quota, media, purchases, and deletion are scoped to a
  pseudonymous Messenger user and exact Page binding.
- Raw PSIDs, prompts, customer messages, access tokens, and payment credentials
  are not logged.
- Image generation remains behind user quota/credits and global spend controls.
- `delete-my-data` cancels or fences late work and removes eligible user data.
- Paid credits will be granted only after trusted Mollie payment verification,
  never from a browser return alone.

## Current user experience

- prompt-first text-to-image;
- natural-language source-photo editing;
- multi-photo composition;
- consent and deletion flows;
- free image quota with balance notices;
- Messenger-native rendering of channel-neutral conversation actions.

The next commercial milestone is to prove the implemented quota-exhaustion CTA,
one-time Mollie checkout and exact-user premium accounting in Mollie Test Mode.
Recurring billing is explicitly outside the target product.

## Local development

Requirements:

- Node.js 24 or newer;
- pnpm 10.28.1 for `apps/image-gen`;
- production-equivalent Redis for queue, replay, and quota integration tests;
- MySQL only for the paths whose tests or migration checks require it.

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

## Documentation

- [Architecture](docs/architecture.md)
- [Active production outcomes](docs/operations/todo.md)
- [Direct Messenger setup](docs/setup.md)
- [Meta App Review](docs/operations/meta-app-review.md)
- [Production deployment and rollback](docs/operations/production-deployments.md)
- [Production readiness](docs/production-readiness.md)
- [One-time billing runbook](docs/BILLING_RUNBOOK.md)
- [Cancellation and refund policy](docs/CANCELLATION_REFUND_POLICY.md)
- [Security](docs/security/SECURITY.md)
- [Storage and retention](docs/storage-proxy-r2.md)

Documentation is intentionally current-state only. Git history is the archive
for removed product plans.

## Production changes

Production releases use reviewed immutable artifacts and the protected workflow
described in
[`docs/operations/production-deployments.md`](docs/operations/production-deployments.md).
Do not use an ad-hoc Fly deploy or database migration as the normal release
path.

OpenClaw and its gateway remain present only until their traffic, state, and
rollback obligations have been safely retired. Their presence is not evidence
that they remain part of the product.
