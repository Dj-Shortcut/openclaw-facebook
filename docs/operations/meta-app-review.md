# Meta App Review

Last reset: 2026-08-27.

This document covers the single owner-operated Leaderbot Page served directly
by `apps/image-gen`.

## Permission posture

- Request only the Page messaging capability required for Facebook Page DMs,
  such as `pages_messaging` under the current Meta review model.
- Subscribe only to reviewed Messenger webhook fields used by the runtime.
- Do not request Facebook Login, `user_posts`, `user_friends`, social graph,
  contact scraping, or broad profile permissions.
- A checkout URL opens a web purchase surface; payment credentials are handled
  by Mollie, not Messenger or Leaderbot chat.
- Re-review visible behavior and permissions before adding a channel, outbound
  messaging category, profile lookup, or new media capability.

## Reviewable capabilities

| Capability | User-visible behavior | Demo requirement | Permission impact |
| --- | --- | --- | --- |
| Text | User sends a Page DM and receives a bot reply | User-initiated message and reply inside the allowed window | Page messaging only |
| Consent | Bot asks for explicit processing consent and honors refusal | Button/postback and typed fallback | Existing messaging/postback fields |
| Text-to-image | Natural-language prompt returns an image | Success, provider failure, and quota block | No additional Page permission |
| Photo edit | User uploads a photo and describes an edit | Media ingestion, storage, output, deletion | Messenger attachment URL only |
| Multi-photo | User combines a bounded number of uploads | Bound, action rendering, cleanup | Same attachment/message fields |
| Free exhaustion | Bot states reset and does not call provider | Prove balance and no provider work | No new permission |
| One-time premium CTA | Bot offers exact bundle and web checkout after user activity | Price/credits/no-subscription copy and decline path | URL button; no payment data in chat |
| Paid confirmation | Verified payment unlocks user credits | Test Mode grant exactly once | Send only within allowed policy window |
| Delete my data | User requests erasure in chat or web instructions | Queue cancellation, asset/state deletion, late-output fence | Supports deletion obligations |

Optional face memory, audio, video, WhatsApp, and proactive messaging are not
part of the initial premium-credit review story. Keep them disabled or outside
the demo unless separately approved.

## Demo sequence

1. Show the public privacy, terms, billing, refund, and deletion pages.
2. Verify the callback and a valid signed event.
3. Send a user-initiated text message and receive a reply.
4. Show consent grant, refusal, and typed fallback.
5. Generate a standard image from a prompt.
6. Edit a user-uploaded source image and delete retained inputs as promised.
7. Exhaust the free allowance and prove no additional provider call occurs.
8. Show the exact one-time premium offer and decline option.
9. Open the checkout web page; show price, credits, quality, validity, and no
   subscription/renewal disclosure.
10. In Test Mode, complete payment and prove one grant after server verification.
11. Spend one premium credit and show the updated balance.
12. Run `delete-my-data` and show metadata-only evidence of completion.

## Messaging policy

The exhaustion CTA is a response to current user activity. Do not use it as an
unsolicited promotion. Payment completion must not trigger a Messenger message
outside the allowed window unless an explicitly approved Meta mechanism applies.
The checkout return page remains the fallback confirmation surface.

## Privacy evidence

Review artifacts and logs may include only test Page identity, opaque request
ids, bounded outcome codes, counts, timings, and redacted screenshots. Do not
capture raw production PSIDs, access tokens, webhook bodies, prompts, photos,
generated images tied to real users, checkout tokens, or Mollie credentials.

## Change policy

For every new visible capability, update this document with behavior, demo
steps, required webhook fields, permission impact, privacy impact, cost guard,
and kill switch before enabling it publicly.
