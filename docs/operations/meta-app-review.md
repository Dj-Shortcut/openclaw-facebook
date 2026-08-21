# Meta App Review notes

Last reviewed: 2026-08-21.

This note records the current Meta App Review impact for the public
Leaderbot/OpenClaw Messenger surface. Keep this file aligned with Messenger
runtime behavior before enabling broader public traffic or adding capabilities.

## Permission posture

- Required Messenger/Page capability: Facebook Page Messenger direct messages.
- Expected permission family: Page messaging access such as `pages_messaging`.
- Do not request Facebook Login, `user_posts`, `user_friends`, social graph
  access, or profile scraping permissions for the current bot.
- Do not expand Meta permission scope without explicit product and policy
  approval.

## Current Messenger capabilities

| Capability | User-visible behavior | Review/demo notes | Permission impact |
| --- | --- | --- | --- |
| Text replies | User sends a Page DM and receives a normal assistant reply. Gateway-owned operational/fallback copy, attachment context, and bridged image responses use the account-configured Dutch or English default language. | Demo with a user-initiated DM and response within the Messenger response window; verify one `defaultLang: "nl"` and one `defaultLang: "en"` account. | No extra permission beyond Page messaging; the language is static account configuration and does not require profile lookup. |
| Prompt-first image generation | User sends a natural-language image prompt and receives a generated image. | Demo one text-to-image prompt, quota exhaustion copy, and Graph API send failure handling. | No extra Meta permission beyond Page messaging; provider cost is controlled by runtime quotas/budgets. |
| Source-photo edit | User sends an image and asks for an edit/restyle. | Demo a user-uploaded image, retained source-image handling, and generated output delivery. | Uses Messenger media payload URLs delivered by the webhook; no profile/photo-library permission requested. |
| Optional photo memory | Disabled by default. If enabled later, user must explicitly consent before retaining a source photo for reuse. | Keep disabled until consent copy, privacy copy, and deletion proof are approved. Demo opt-in, withdrawal, and retention expiry before enabling. | No additional Meta permission expected; do not infer consent from upload alone. |
| Audio transcription | User voice/audio attachments can be transcribed when enabled and budgeted. | Demo quota/budget exhaustion before provider call and privacy-safe logs. | Uses Messenger media attachment payloads from Page DMs only. |
| Shared gateway safety state | No new user-facing feature. An optional Redis backend shares message deduplication and daily gateway caps; unavailable state blocks ordinary processing with localized retry copy while `delete-my-data` remains routable. | Demo duplicate delivery, cap exhaustion, Redis outage, and deletion routing. Redis keys are HMAC-only and contain no message content. | Operational implementation only; no additional Meta permission or webhook field is required. |
| Generated video output | Future/flagged generated output only; uploaded Messenger videos remain unsupported input. | Review feature flag, quota reservation before provider call, durable delivery URL, and failure copy before enabling. | No uploaded-video input review scope for the current implementation. |
| Delete my data | User can send `delete my data` or `verwijder mijn data`; deletion also remains available by email. | Demo cost ledger, generated assets, retained source images, face-memory state, and completion marker deletion in production-equivalent state. | Supports Meta data-deletion expectations; Meta-controlled Messenger history remains managed by Meta. |

## Review demo checklist

Before requesting review or changing public access, record:

1. Webhook verification and signed POST delivery.
2. A user-initiated text reply.
3. Prompt-first text-to-image generation.
4. Source-photo edit with durable image delivery.
5. Localized, plan-neutral quota or spend-cap exhaustion copy before an
   expensive provider call.
6. Delete-my-data behavior with production-equivalent state.
7. Public `/privacy`, `/terms`, and `/data-deletion` routes.
8. Confirmation that no raw PSIDs, prompts, tokens, customer messages, or
   uploaded/generated content appear in logs.

## Change policy

For every new Messenger capability:

- Document the user-visible behavior and demo steps here.
- State whether new Meta permissions are required.
- Keep the implementation behind feature flags or tenant controls until review
  and legal/privacy copy are ready.
- Preserve webhook verification, request signatures, response-window behavior,
  quota enforcement, GDPR deletion, and privacy-safe observability.
