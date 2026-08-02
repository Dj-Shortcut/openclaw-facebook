# Environment Shortlist

This is the operational env list for getting the bot working. Read this before the larger `.env.example` or README env inventory.

## 1. Messenger bot runtime

These variables are the first things to verify when the bot does not reply or Meta webhooks fail.

| Variable | Required for | Notes |
| --- | --- | --- |
| `FB_VERIFY_TOKEN` | Webhook verification | Must match the token configured in Meta. |
| `FB_PAGE_ACCESS_TOKEN` | Sending Messenger replies | If wrong or expired, outbound replies fail. |
| `FB_APP_SECRET` | Webhook signature verification | Required for signed webhook validation. |
| `CONVERSATION_SCOPE_HMAC_KEY_ID` | Versioned tenant/workspace identity derivation | Required by gateway and workers. Start with `k1`; changing it requires an explicit offline identity/state migration. |
| `CONVERSATION_SCOPE_HMAC_SECRET` | Tenant/workspace identity derivation | Required by gateway and workers. Must be exactly 64 lowercase hex characters (`openssl rand -hex 32`), shared unchanged by every process, and must not reuse another application secret. |
| `MESSENGER_GENERATION_PARTITION_SECRET` | Stable opaque Page boundaries for the Redis image queue | Prefer a dedicated random secret shared unchanged by gateway and worker processes. Runtime falls back to `FB_APP_SECRET`, but rotating the effective secret creates new partition keys and splits dedupe continuity; rotate only through a deliberate queue-empty migration. |
| `MESSENGER_GENERATION_ACCEPTED_TTL_SECONDS` | Redis image-queue request dedupe retention | Defaults to `604800` seconds (7 days) and is clamped to at least lease duration multiplied by max attempts. Secret rotation must wait this long after the final accepted enqueue, after producers stop and queues drain, or duplicate protection can split across namespaces. |
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
| `WHATSAPP_APP_SECRET` | Optional dedicated WhatsApp POST signature validation | Set this when WhatsApp is configured under a different Meta app than Messenger; otherwise `FB_APP_SECRET` is used. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta Business diagnostics | Not required by runtime sends, but useful for setup checks. |

## 3. OpenAI paths

These variables control whether the OpenAI-backed parts of the bot actually run.

| Variable | Required for | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Image generation and conversational edit interpretation | If missing, image generation fails closed and edit interpretation is skipped. |
| `IMAGE_PROVIDER` | Image provider boundary | Optional; currently only `openai-images` is supported. |
| `OPENAI_EDIT_INTERPRETER_MODEL` | Conversational edit classifier | Optional; free text still stays deterministic and does not use an OpenAI chat brain. |
| `OPENAI_IMAGE_ESTIMATED_COST_USD` | Conservative per-attempt image budget estimate | Required before paid Images 2.0 activation and whenever `MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD`, `MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD`, or `MESSENGER_USER_DAILY_SPEND_CAP_USD` is enabled. Without it, GPT Image 2 generations and edits are intentionally blocked as incomplete-cost attempts because prompt input—and edit-image input—are not covered by the output-only table. Set it from current official GPT Image 2 pricing plus measured prompt and high-fidelity edit-input usage. Alert on `messenger_*_spend_budget_unpriced_attempt_blocked` before customer traffic is enabled. |
| `SOURCE_IMAGE_ALLOWED_HOSTS` | Downloading inbound images before generation | If the exact host is not allowlisted, generation fails before OpenAI is called. |
| `MESSENGER_GLOBAL_DAILY_IMAGE_CAP` | Optional global Messenger image provider-attempt cap | Set for public smoke so one account cannot burn the whole OpenAI image budget. |
| `MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP` | Optional root-gateway image forward cap | Host-level safety valve before the OpenClaw Facebook plugin forwards image intents to Leaderbot image-gen. |
| `MESSENGER_GLOBAL_DAILY_AUDIO_CAP` | Optional global Messenger audio transcription provider-attempt cap | Set for public smoke if audio messages are enabled; blocks before OpenAI transcription. |
| `MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP` | Optional root-gateway audio transcription cap | Host-level safety valve before the OpenClaw Facebook plugin downloads/transcribes Messenger voice attachments. |
| `OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD` | Optional audio transcription cost estimate | Enables priced audio spend-cap checks and final-cost ledger reconciliation per OpenAI transcription attempt. |
| `MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP` | Optional root-gateway Leaderbot event forward cap | Host-level safety valve before generic free-tier/interactive Messenger events are forwarded to Leaderbot image-gen. Does not block delete-data forwards. |
| `MESSENGER_GLOBAL_DAILY_VIDEO_CAP` | Optional global Messenger video provider-attempt cap | Set before video generation is exposed to public Messenger traffic. |
| `OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD` | Optional video generation cost estimate | Enables priced video spend-cap checks and final-cost ledger reconciliation per generated-video attempt. |
| `MESSENGER_OWNER_COST_ALERTS` | Optional owner notification for spend-cap blocks | Set to `1` only when `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY` are configured; alerts include metadata-only budget details. |

## 4. Optional but easy to confuse

These show up in the repo and can be mistaken for the main OpenAI path.

| Variable | Used by | Notes |
| --- | --- | --- |
| `BUILT_IN_FORGE_API_URL` | Storage proxy | Separate from OpenAI; used for durable generated/source image URLs. |
| `BUILT_IN_FORGE_API_KEY` | Storage proxy | Separate from `OPENAI_API_KEY`. |
| `PUBLIC_BASE_URL` | Storage delete key derivation | Only needed in the main app when the storage public URL has a path prefix. |
| `REDIS_URL` | Replay protection, rate limiting, state storage | Required in production for replay protection. |
| `HTTP_RATE_LIMIT_REDIS_GUARD_MAX_REQUESTS` | Global HTTP rate limiting | Optional pre-Redis guard cap per window; defaults to `max(1000, HTTP_RATE_LIMIT_MAX_REQUESTS * 10)`. |
| `ADMIN_TOKEN` | Debug/admin endpoints | Required for `/admin/disable-face-memory` and `/debug/build`; those endpoints also have a stricter admin-auth rate limit. |

## 5. Portal authentication

| Variable | Required for | Notes |
| --- | --- | --- |
| `OAUTH_PORTAL_URL` | Public Manus WebDev OAuth authorization origin | Optional only when browser authorization and token exchange intentionally share the `OAUTH_SERVER_URL` origin. Returned through `/api/public/config`; HTTPS required except localhost. Never infer it from Meta URLs or include credentials, query secrets, or fragments. |
| `OAUTH_SERVER_URL` | Manus WebDev OAuth token exchange origin | Separate from Meta/Facebook Graph and callback URLs; also used as the public portal fallback when `OAUTH_PORTAL_URL` is deliberately absent. |
| `VITE_APP_ID` | Public Manus WebDev OAuth project id | Read at server runtime and returned through `/api/public/config`; it is not a client secret and is not `FB_APP_ID`. |
| `VITE_OAUTH_PORTAL_URL` | Optional browser build fallback | Used only when `/api/public/config` is unavailable during local development or a build that deliberately embeds public OAuth configuration. Production should use `OAUTH_PORTAL_URL` through the runtime endpoint. HTTPS is required except localhost; never include credentials, query secrets, or fragments. |
| `PORTAL_BASE_URL` | Public Leaderbot portal origin | Controls generated `/handoff/:token` links and takes precedence over `APP_BASE_URL`. Use the correct public HTTPS origin in production. |

## 6. Mollie billing (live remains disabled)

| Variable | Required for | Notes |
| --- | --- | --- |
| `MOLLIE_BILLING_ENABLED` | Master billing feature switch | Defaults off. When false, checkout, public paid plans, Mollie webhooks, billing workers and reconciliation are not started. Enable only in an approved test or launch environment. |
| `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED` | Existing paid quota enforcement | Defaults off before migration. Must be enabled and verified before checkout can start, then kept on even if billing is paused so paid quotas cannot fall back to free behavior. |
| `LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED` | Gateway preflight for the finite 300-answer Startpilot quota | Defaults off, so ordinary free OpenClaw chat has no image-gen dependency. Enable on the gateway only after migration and together with verified image-gen `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED=true`; once enabled, transport or quota lookup failures intentionally fail closed. |
| `MOLLIE_API_KEY` | Mollie API calls | Use only a `test_` key until launch approval; never log or commit it. |
| `MOLLIE_MODE` | Mode guard | Must be exactly `test` or `live` and match the key prefix. |
| `MOLLIE_PAYMENT_WEBHOOK_URL` | Classic payment updates | Exact HTTPS production path: `/api/webhooks/mollie/payments`. |
| `APP_BASE_URL` | Billing redirect and trusted Origin | HTTPS in production/live mode. |
| `BILLING_SUPPORT_EMAIL` | Customer billing support | Public support address, not a secret. |
| `MOLLIE_LIVE_BILLING_ENABLED` | Independent live kill switch | Defaults off; may be `true` only with `MOLLIE_MODE=live` after GO. |
| `MOLLIE_RECONCILIATION_ENABLED` | Daily state reconciliation | Defaults enabled; disabling requires an incident/change record. |
| `MOLLIE_BILLING_WORKER_WORKSPACE_ID` | Tenant-bound outbox/reconciliation worker | Required for checkout in the isolated Test Mode foundation. Must be one positive workspace ID; this is not the final multi-tenant scheduler. |
| `MOLLIE_WEBHOOK_RATE_LIMIT_PER_MINUTE` | Dedicated classic-webhook protection | Defaults to 6000 per source IP/minute so the shared app limiter cannot suppress Mollie delivery. |

## 7. Fast triage

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

1. `ENABLE_FACE_MEMORY`
2. `FACE_MEMORY_RETENTION_DAYS`
3. `ADMIN_TOKEN`
4. Storage proxy delete support: `DELETE /v1/storage/object`

If WhatsApp is involved, also check:

1. `WHATSAPP_ACCESS_TOKEN`
2. `WHATSAPP_PHONE_NUMBER_ID`
3. `META_VERIFY_TOKEN` or `WHATSAPP_VERIFY_TOKEN`
4. Meta callback URL: `https://leaderbot-fb-image-gen.fly.dev/webhook/whatsapp`

## 8. Current local-dev gotchas

Based on the current local `.env` in this repo:

- `OPENAI_API_KEY` is blank, so OpenAI-backed paths are not actually configured.
- Free text is deterministic; there is no Messenger OpenAI text rollout to enable.
- `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY` are blank, so storage proxy features are unavailable.
- `ENABLE_FACE_MEMORY=false`, so photo uploads skip the explicit face-memory consent prompt and ask for a natural-language edit prompt.

## 9. What to ignore at first

Do not start debugging with these unless you are working on those specific subsystems:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`, `ADMIN_GITHUB_USERS`
- `DATABASE_URL`, `OWNER_OPEN_ID`, `VITE_APP_ID`, `OAUTH_SERVER_URL`
- Fine-tuning knobs like retry counts, timeout overrides, quota bypass ids, and debug flags
