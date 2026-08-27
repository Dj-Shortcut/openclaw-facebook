# Direct Facebook Messenger setup

This guide connects the owner-operated Facebook Page directly to
`apps/image-gen`. Do not point the Page at the legacy OpenClaw gateway.

## Runtime flow

```text
Facebook Page -> Meta Messenger webhook -> apps/image-gen -> Messenger Send API
```

Canonical callback path:

```text
https://<public-runtime-origin>/facebook/webhook
```

Use the exact deployed origin recorded in the reviewed production manifest.

## Prerequisites

- one Meta app controlled by the owner;
- one Facebook Page controlled by the owner;
- Messenger configured for that Meta app and Page;
- public HTTPS runtime;
- Page access token;
- app secret;
- random webhook verify token;
- `pages_messaging` or the current equivalent capability approved for the
  intended audience;
- privacy, terms, and data-deletion URLs.

Do not request Facebook Login, `user_posts`, `user_friends`, social graph, or
profile-scraping permissions for this flow.

## Required runtime configuration

At minimum, configure:

```text
FB_VERIFY_TOKEN
FB_PAGE_ACCESS_TOKEN
FB_APP_SECRET
APP_BASE_URL
REDIS_URL
PRIVACY_PEPPER
CONVERSATION_SCOPE_HMAC_KEY_ID
CONVERSATION_SCOPE_HMAC_SECRET
OPENAI_API_KEY
SOURCE_IMAGE_ALLOWED_HOSTS
```

Production also requires the reviewed queue, storage, budget, database, and
readiness configuration documented in
[`operations/ENV_SHORTLIST.md`](operations/ENV_SHORTLIST.md).

Never paste secrets into documentation, issues, logs, or screenshots.

## Meta configuration

1. Add Messenger to the Meta app.
2. Connect the exact owner Page.
3. Configure the callback URL ending in `/facebook/webhook`.
4. Enter the same random verify token as `FB_VERIFY_TOKEN`.
5. Subscribe only to webhook fields used by the runtime, currently including
   messages, postbacks, deliveries, and reads as reviewed.
6. Generate the Page access token and install it as a runtime secret.
7. Complete required business verification and App Review before public access.
8. Set privacy policy, terms, and data-deletion instructions to the active
   Leaderbot web routes.

Meta's verification GET proves callback ownership. Real POST events additionally
require the request signature derived from `FB_APP_SECRET`; never disable POST
signature validation to make setup pass.

## Local verification

Start the active application:

```bash
pnpm --dir apps/image-gen dev
```

A local server is not a production callback. Use an approved temporary HTTPS
development tunnel only with test credentials and non-customer data.

Check:

- `/healthz` returns healthy;
- `/readyz` reports required dependencies ready;
- the verification GET accepts only the correct token and challenge;
- an unsigned or invalid POST is rejected;
- a valid test event reaches the intended Page binding;
- logs contain no raw sender id or message content.

## Pre-public smoke

Before enabling broad Page access:

1. Send a user-initiated text message.
2. Complete consent grant and refusal.
3. Generate one image and one source-photo edit.
4. Replay the same event and prove no duplicate generation.
5. Exhaust free quota and prove the provider is not called again.
6. Run `delete-my-data` and prove queued/late work is fenced.
7. Confirm all visible copy matches the approved language.
8. Confirm no checkout is visible while live billing is disabled.

When the one-time premium flow is later enabled, add the Test Mode checkout and
wallet smoke from [`production-readiness.md`](production-readiness.md).

## Cutover from OpenClaw

Because Meta Page webhook subscription is app-scoped, plan the cutover around
the exact Meta app and Page. Do not run two production runtimes that both assume
they own the same callback.

Required cutover proof:

- direct callback is healthy and signed events succeed;
- OpenClaw callback receives no intended traffic;
- rollback callback and credentials are recorded;
- legacy gateway data receives an explicit retain/export/delete decision;
- gateway removal happens only after the observation window in the active
  migration outcome.

## Troubleshooting

### Verification fails

- compare callback URL and verify token;
- confirm HTTPS and public reachability;
- confirm the request reaches `apps/image-gen`, not the old gateway.

### Events arrive but no reply

- verify app secret and request signature;
- verify Page access token and Page binding;
- check Redis queue/readiness and worker health;
- inspect redacted outcome codes, never raw payloads.

### Image generation fails

- verify consent and free/paid admission result;
- verify `OPENAI_API_KEY`, provider budget, and retry policy;
- verify source-image host allowlist and storage readiness;
- distinguish provider success from Messenger delivery failure.
