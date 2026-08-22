# Meta App Review notes

Last reviewed: 2026-08-22.

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

| Capability                    | User-visible behavior                                                                                                                                                                                                      | Review/demo notes                                                                                                                                    | Permission impact                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Text replies                  | User sends a Page DM and receives a normal assistant reply. Gateway-owned operational/fallback copy, attachment context, and bridged image responses use the account-configured Dutch or English default language.         | Demo with a user-initiated DM and response within the Messenger response window; verify one `defaultLang: "nl"` and one `defaultLang: "en"` account. | No extra permission beyond Page messaging; the language is static account configuration and does not require profile lookup. |
| Processing consent            | Image and assistant-content processing is gated on either an unambiguous explicit typed grant or a delivered consent notice followed by a positive postback/text reply. The notice uses persistent `Ik ga akkoord` / `Nee bedankt` postbacks; if Messenger rejects that template, Leaderbot immediately attempts the typed-consent notice as plain text. Questions, refusals, uncertain wording, and ordinary typo-neighbour words never grant consent. | Demo the `Ik ga akkoord` and `Nee bedankt` postbacks plus typed consent. Verify the prompt-delivery marker is written only after Messenger accepts either the controls or plain-text fallback, short replies expire after 15 minutes, consent postbacks remain eligible for a fallback after handler failure, and refusal stays blocked without presenting the consent actions again. | No extra permission or webhook field; uses the existing Page messaging and `messaging_postbacks` surface.                     |
| Prompt-first image generation | User sends a natural-language image prompt and receives a generated image.                                                                                                                                                 | Demo one text-to-image prompt, quota exhaustion copy, and Graph API send failure handling.                                                           | No extra Meta permission beyond Page messaging; provider cost is controlled by runtime quotas/budgets.                       |
| Source-photo edit             | User sends an image and asks for an edit/restyle.                                                                                                                                                                          | Demo a user-uploaded image, retained source-image handling, and generated output delivery.                                                           | Uses Messenger media payload URLs delivered by the webhook; no profile/photo-library permission requested.                   |
| Multi-photo composition       | User sends two to four photos, sees a channel-neutral `Samenvoegen` action rendered as a Messenger pill, and describes how the photos should become one image.                                                             | Demo both one-message and sequential uploads, the instruction prompt, the four-photo cap, quota exhaustion before provider work, and deletion of every stored source. | Uses the same Messenger media attachment payloads and Page messaging permission as a single-photo edit; no new permission is requested. |
| Optional photo memory         | Disabled by default. If enabled later, user must explicitly consent before retaining a source photo for reuse.                                                                                                             | Keep disabled until consent copy, privacy copy, and deletion proof are approved. Demo opt-in, withdrawal, and retention expiry before enabling.      | No additional Meta permission expected; do not infer consent from upload alone.                                              |
| Audio transcription           | User voice/audio attachments can be transcribed when enabled and budgeted.                                                                                                                                                 | Demo quota/budget exhaustion before provider call and privacy-safe logs.                                                                             | Uses Messenger media attachment payloads from Page DMs only.                                                                 |
| Shared gateway safety state   | No new user-facing feature. An optional Redis backend shares message deduplication and daily gateway caps; unavailable state blocks ordinary processing with localized retry copy while `delete-my-data` remains routable. | Demo duplicate delivery, cap exhaustion, Redis outage, and deletion routing. Redis keys are HMAC-only and contain no message content.                | Operational implementation only; no additional Meta permission or webhook field is required.                                 |
| Generated video output        | Future/flagged generated output only; uploaded Messenger videos remain unsupported input.                                                                                                                                  | Review feature flag, quota reservation before provider call, durable delivery URL, and failure copy before enabling.                                 | No uploaded-video input review scope for the current implementation.                                                         |
| Delete my data                | User can send `delete my data` or `verwijder mijn data`; deletion also remains available by email.                                                                                                                         | Demo cost ledger, generated assets, retained source images, face-memory state, and completion marker deletion in production-equivalent state.        | Supports Meta data-deletion expectations; Meta-controlled Messenger history remains managed by Meta.                         |

## Review demo checklist

Before requesting review or changing public access, record:

1. Webhook verification and signed POST delivery.
2. A user-initiated text reply.
3. Persistent consent postbacks on Messenger Android, iOS, and Web, plus the
   explicit typed fallback when controls are unavailable.
4. Conservative typed-consent variants, questions, refusals, uncertainty, a
   stale short reply, and a rejected Messenger control delivery.
5. A GDPR postback handler failure that still produces the normal safe
   fallback instead of being classified as an intentionally silent payload.
6. Prompt-first text-to-image generation.
7. Source-photo edit with durable image delivery.
8. Multi-photo composition from both a single multi-attachment message and
   sequential uploads, including the `Samenvoegen` pill and four-photo cap.
9. Localized, plan-neutral quota or spend-cap exhaustion copy before an
   expensive provider call.
10. Delete-my-data behavior with production-equivalent state.
11. Public `/privacy`, `/terms`, and `/data-deletion` routes.
12. Confirmation that the pre-redaction inbound logger receives metadata only:
    no raw PSIDs, prompts, tokens, customer messages, payload values, attachment
    URLs, message ids, referrals, or uploaded/generated content.

## Change policy

For every new Messenger capability:

- Document the user-visible behavior and demo steps here.
- State whether new Meta permissions are required.
- Keep the implementation behind feature flags or tenant controls until review
  and legal/privacy copy are ready.
- Preserve webhook verification, request signatures, response-window behavior,
  quota enforcement, GDPR deletion, and privacy-safe observability.
