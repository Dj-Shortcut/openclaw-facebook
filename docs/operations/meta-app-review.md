# Meta App Review notes

Last reviewed: 2026-08-21.

This note records the current Meta App Review impact for the public
Leaderbot/OpenClaw Messenger surface. Keep this file aligned with Messenger
runtime behavior before enabling broader public traffic or adding capabilities.

## Permission posture

- Required login/Page capabilities: Facebook Login plus Facebook Page Messenger
  direct messages.
- The customer approved combining portal login and Page authorization into one
  Meta OAuth prompt. The exact requested scopes are `public_profile`,
  `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, and
  `business_management`. The Business Management permission is restricted in
  Leaderbot to read-only discovery of Pages assigned through the customer's
  Business Portfolio; no Business Manager mutation is part of this flow.
- Do not request `user_posts`, `user_friends`, social graph access, or profile
  scraping permissions.
- Do not expand Meta permission scope without explicit product and policy
  approval.

## Current Messenger capabilities

| Capability                           | User-visible behavior                                                                                                                                                         | Review/demo notes                                                                                                                               | Permission impact                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Text replies                         | User sends a Page DM and receives a normal assistant reply.                                                                                                                   | Demo with a user-initiated DM and response within the Messenger response window.                                                                | No extra permission beyond Page messaging.                                                                            |
| Combined portal login and Page setup | Facebook Login also returns the Pages the customer may manage. One Page is connected automatically; multiple Pages require only a Page choice, without a second OAuth prompt. | Demo zero, one, and multiple Page results; denied scopes; an already connected workspace; and a Page already claimed by another workspace.      | Uses the three Page scopes plus `business_management` solely to discover Business Portfolio-assigned Pages read-only. |
| Prompt-first image generation        | User sends a natural-language image prompt and receives a generated image.                                                                                                    | Demo one text-to-image prompt, quota exhaustion copy, and Graph API send failure handling.                                                      | No extra Meta permission beyond Page messaging; provider cost is controlled by runtime quotas/budgets.                |
| Source-photo edit                    | User sends an image and asks for an edit/restyle.                                                                                                                             | Demo a user-uploaded image, retained source-image handling, and generated output delivery.                                                      | Uses Messenger media payload URLs delivered by the webhook; no profile/photo-library permission requested.            |
| Optional photo memory                | Disabled by default. If enabled later, user must explicitly consent before retaining a source photo for reuse.                                                                | Keep disabled until consent copy, privacy copy, and deletion proof are approved. Demo opt-in, withdrawal, and retention expiry before enabling. | No additional Meta permission expected; do not infer consent from upload alone.                                       |
| Audio transcription                  | User voice/audio attachments can be transcribed when enabled and budgeted.                                                                                                    | Demo quota/budget exhaustion before provider call and privacy-safe logs.                                                                        | Uses Messenger media attachment payloads from Page DMs only.                                                          |
| Generated video output               | Future/flagged generated output only; uploaded Messenger videos remain unsupported input.                                                                                     | Review feature flag, quota reservation before provider call, durable delivery URL, and failure copy before enabling.                            | No uploaded-video input review scope for the current implementation.                                                  |
| Delete my data                       | User can send `delete my data` or `verwijder mijn data`; deletion also remains available by email.                                                                            | Demo cost ledger, generated assets, retained source images, face-memory state, and completion marker deletion in production-equivalent state.   | Supports Meta data-deletion expectations; Meta-controlled Messenger history remains managed by Meta.                  |

## Review demo checklist

Before requesting review or changing public access, record:

1. Webhook verification and signed POST delivery.
2. Combined Facebook Login and Page setup for one Page and multiple Pages.
3. A user-initiated text reply.
4. Prompt-first text-to-image generation.
5. Source-photo edit with durable image delivery.
6. Quota or spend-cap exhaustion copy before an expensive provider call.
7. Delete-my-data behavior with production-equivalent state.
8. Public `/privacy`, `/terms`, and `/data-deletion` routes.
9. Confirmation that no raw PSIDs, prompts, tokens, customer messages, or
   uploaded/generated content appear in logs.

## Change policy

For every new Messenger capability:

- Document the user-visible behavior and demo steps here.
- State whether new Meta permissions are required.
- Keep the implementation behind feature flags or tenant controls until review
  and legal/privacy copy are ready.
- Preserve webhook verification, request signatures, response-window behavior,
  quota enforcement, GDPR deletion, and privacy-safe observability.
