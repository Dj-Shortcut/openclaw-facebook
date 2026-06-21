# Environment Shortlist

This is the operational env list for getting the bot working. Read this before the larger `.env.example` or README env inventory.

## 1. Messenger bot runtime

These variables are the first things to verify when the bot does not reply or Meta webhooks fail.

| Variable | Required for | Notes |
| --- | --- | --- |
| `FB_VERIFY_TOKEN` | Webhook verification | Must match the token configured in Meta. |
| `FB_PAGE_ACCESS_TOKEN` | Sending Messenger replies | If wrong or expired, outbound replies fail. |
| `FB_APP_SECRET` | Webhook signature verification | Required for signed webhook validation. |
| `MESSENGER_PAGE_ID` | Canonical `m.me` share links | Needed for share/invite flows. |
| `APP_BASE_URL` | Public links and generated image URLs | Must be `https://` in production. |
| `ENABLE_FACE_MEMORY` | Optional Messenger source-photo reuse | Keep `false` until legal approves consent, privacy, and deletion copy. |
| `FACE_MEMORY_RETENTION_DAYS` | Optional face-memory retention window | Defaults to `30`; positive whole numbers only. Invalid values fall back to `30`; values above `30` are capped at `30`. |

## 2. WhatsApp runtime

These variables are required for the public Leaderbot WhatsApp number. See
`whatsapp-setup.md` for the full verification checklist.

| Variable | Required for | Notes |
| --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp Cloud API sends and media downloads | If wrong or expired, outbound replies and media downloads fail. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API `/messages` endpoint | Must be the public number's phone-number ID, not the display number. |
| `META_VERIFY_TOKEN` | Shared Meta webhook verification | Accepted on Messenger and WhatsApp routes. |
| `WHATSAPP_VERIFY_TOKEN` | Dedicated WhatsApp webhook verification | Accepted only on `/webhook/whatsapp`; useful when Meta's WhatsApp setup uses a channel-specific token. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta Business diagnostics | Not required by runtime sends, but useful for setup checks. |

## 3. OpenAI paths

These variables control whether the OpenAI-backed parts of the bot actually run.

| Variable | Required for | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Image generation and conversational edit interpretation | If missing, image generation fails closed and edit interpretation is skipped. |
| `IMAGE_PROVIDER` | Image provider boundary | Optional; currently only `openai-images` is supported. |
| `OPENAI_EDIT_INTERPRETER_MODEL` | Conversational edit classifier | Optional; free text still stays deterministic and does not use an OpenAI chat brain. |
| `SOURCE_IMAGE_ALLOWED_HOSTS` | Downloading inbound images before generation | If the exact host is not allowlisted, generation fails before OpenAI is called. |
| `MESSENGER_GLOBAL_DAILY_IMAGE_CAP` | Optional global Messenger image provider-attempt cap | Set for public smoke so one account cannot burn the whole OpenAI image budget. |
| `MESSENGER_GLOBAL_DAILY_AUDIO_CAP` | Optional global Messenger audio transcription provider-attempt cap | Set for public smoke if audio messages are enabled; blocks before OpenAI transcription. |
| `MESSENGER_GLOBAL_DAILY_VIDEO_CAP` | Optional global Messenger video provider-attempt cap | Set before video generation is exposed to public Messenger traffic. |

## 4. Optional but easy to confuse

These show up in the repo and can be mistaken for the main OpenAI path.

| Variable | Used by | Notes |
| --- | --- | --- |
| `BUILT_IN_FORGE_API_URL` | Storage proxy | Separate from OpenAI; used for durable generated/source image URLs. |
| `BUILT_IN_FORGE_API_KEY` | Storage proxy | Separate from `OPENAI_API_KEY`. |
| `PUBLIC_BASE_URL` | Storage delete key derivation | Only needed in the main app when the storage public URL has a path prefix. |
| `REDIS_URL` | Replay protection, rate limiting, state storage | Required in production for replay protection. |
| `ADMIN_TOKEN` | Debug/admin endpoints | Required for `/admin/disable-face-memory` and `/debug/build`; those endpoints also have a stricter admin-auth rate limit. |

## 5. Fast triage

When the bot seems broken, check in this order:

1. `OPENAI_API_KEY`
2. `FB_PAGE_ACCESS_TOKEN`
3. `FB_APP_SECRET`
4. `APP_BASE_URL`
5. `IMAGE_PROVIDER`
6. `SOURCE_IMAGE_ALLOWED_HOSTS`
7. `MESSENGER_GLOBAL_DAILY_IMAGE_CAP`
8. `MESSENGER_GLOBAL_DAILY_AUDIO_CAP`

If face memory is involved, also check:

9. `ENABLE_FACE_MEMORY`
10. `FACE_MEMORY_RETENTION_DAYS`
11. `ADMIN_TOKEN`
12. Storage proxy delete support: `DELETE /v1/storage/object`

If WhatsApp is involved, also check:

1. `WHATSAPP_ACCESS_TOKEN`
2. `WHATSAPP_PHONE_NUMBER_ID`
3. `META_VERIFY_TOKEN` or `WHATSAPP_VERIFY_TOKEN`
4. Meta callback URL: `https://leaderbot-fb-image-gen.fly.dev/webhook/whatsapp`

## 6. Current local-dev gotchas

Based on the current local `.env` in this repo:

- `OPENAI_API_KEY` is blank, so OpenAI-backed paths are not actually configured.
- Free text is deterministic; there is no Messenger OpenAI text rollout to enable.
- `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY` are blank, so storage proxy features are unavailable.
- `ENABLE_FACE_MEMORY=false`, so photo uploads skip the explicit face-memory consent prompt and ask for a natural-language edit prompt.

## 7. What to ignore at first

Do not start debugging with these unless you are working on those specific subsystems:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`, `ADMIN_GITHUB_USERS`
- `DATABASE_URL`, `OWNER_OPEN_ID`, `VITE_APP_ID`, `OAUTH_SERVER_URL`
- Fine-tuning knobs like retry counts, timeout overrides, quota bypass ids, and debug flags
