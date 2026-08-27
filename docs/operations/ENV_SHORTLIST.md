# Environment Shortlist

This is the operational env list for getting the bot working. Read this before the larger `.env.example` or README env inventory.

## 1. Messenger bot runtime

These variables are the first things to verify when the bot does not reply or Meta webhooks fail.

| Variable                                    | Required for                                               | Notes                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FB_VERIFY_TOKEN`                           | Webhook verification                                       | Must match the token configured in Meta.                                                                                                                                                                                                                                      |
| `FB_PAGE_ACCESS_TOKEN`                      | Sending Messenger replies                                  | If wrong or expired, outbound replies fail.                                                                                                                                                                                                                                   |
| `FB_APP_SECRET`                             | Webhook signature verification                             | Required for signed webhook validation.                                                                                                                                                                                                                                       |
| `CONVERSATION_SCOPE_HMAC_KEY_ID`            | Versioned tenant/workspace identity derivation             | Required by gateway and workers. Start with `k1`; changing it requires an explicit offline identity/state migration.                                                                                                                                                          |
| `CONVERSATION_SCOPE_HMAC_SECRET`            | Tenant/workspace identity derivation                       | Required by gateway and workers. Must be exactly 64 lowercase hex characters (`openssl rand -hex 32`), shared unchanged by every process, and must not reuse another application secret.                                                                                      |
| `MESSENGER_GENERATION_PARTITION_SECRET`     | Stable opaque Page boundaries for the Redis image queue    | Prefer a dedicated random secret shared unchanged by gateway and worker processes. Runtime falls back to `FB_APP_SECRET`, but rotating the effective secret creates new partition keys and splits dedupe continuity; rotate only through a deliberate queue-empty migration.  |
| `MESSENGER_GENERATION_ACCEPTED_TTL_SECONDS` | Redis image-queue request dedupe retention                 | Defaults to `604800` seconds (7 days) and is clamped to at least lease duration multiplied by max attempts. Secret rotation must wait this long after the final accepted enqueue, after producers stop and queues drain, or duplicate protection can split across namespaces. |
| `MESSENGER_SHARED_STATE_REDIS_URL`          | Root OpenClaw Facebook gateway shared dedupe and audio cap | Required only when `channels.facebook.sharedStateStore` is `redis`; use `redis://` or `rediss://`. Selection is root-only and startup fails when Redis is unavailable.                                                                                                        |
| `MESSENGER_SHARED_STATE_HMAC_SECRET`        | Opaque root-gateway Redis keys                             | Required with the Redis shared-state mode. Must be a dedicated 64-character lowercase hex secret (`openssl rand -hex 32`); never reuse a Meta, Redis, or app secret.                                                                                                          |
| `MESSENGER_SHARED_STATE_HMAC_KEY_ID`        | Versioned root-gateway Redis namespace                     | Optional, defaults to `k1`. Rotate only with paused ingress at a UTC-day boundary because changing the key id or secret resets active dedupe and daily-cap continuity.                                                                                                        |
| `MESSENGER_PAGE_ID`                         | Canonical `m.me` share links                               | Needed for share/invite flows.                                                                                                                                                                                                                                                |
| `APP_BASE_URL`                              | Public links and generated image URLs                      | Must be `https://` in production.                                                                                                                                                                                                                                             |
| `ENABLE_FACE_MEMORY`                        | Optional Messenger source-photo reuse                      | Keep `false` until legal approves consent, privacy, and deletion copy.                                                                                                                                                                                                        |
| `FACE_MEMORY_RETENTION_DAYS`                | Optional face-memory retention window                      | Defaults to `30`; positive whole numbers only. Invalid values fall back to `30`; values above `30` are capped at `30`.                                                                                                                                                        |

## 2. WhatsApp runtime

These variables are required for the public Leaderbot WhatsApp number. See
`whatsapp-setup.md` for the full verification checklist.

| Variable                       | Required for                                          | Notes                                                                                                              |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `WHATSAPP_ACCESS_TOKEN`        | Bootstrap input and sealed WhatsApp tenant credential | Must exactly match the sealed tenant binding; rotate it only through the protected provisioning action.            |
| `WHATSAPP_PHONE_NUMBER_ID`     | Exact WhatsApp tenant-binding phone identity          | Must be the public number's phone-number ID, not the display number.                                               |
| `META_VERIFY_TOKEN`            | Shared Meta webhook verification                      | Accepted on Messenger and WhatsApp routes.                                                                         |
| `WHATSAPP_VERIFY_TOKEN`        | Dedicated WhatsApp webhook verification               | Accepted only on `/webhook/whatsapp`; useful when Meta's WhatsApp setup uses a channel-specific token.             |
| `WHATSAPP_APP_SECRET`          | Optional dedicated WhatsApp POST signature validation | Set this when WhatsApp is configured under a different Meta app than Messenger; otherwise `FB_APP_SECRET` is used. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Exact WhatsApp provider-account identity              | Required for provisioning, boot readiness, and WABA + phone tenant binding.                                        |

## 3. OpenAI paths

These variables control whether the OpenAI-backed parts of the bot actually run.

| Variable                                          | Required for                                                       | Notes                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                  | Image generation and conversational edit interpretation            | If missing, image generation fails closed and edit interpretation is skipped.                                                                                             |
| `IMAGE_PROVIDER`                                  | Image provider boundary                                            | Optional; currently only `openai-images` is supported.                                                                                                                    |
| `OPENAI_EDIT_INTERPRETER_MODEL`                   | Conversational edit classifier                                     | Optional; free text still stays deterministic and does not use an OpenAI chat brain.                                                                                      |
| `OPENAI_IMAGE_MAX_RETRIES`                        | Image-provider retry count                                         | Must be explicitly `0` in production so one provider invocation cannot automatically start a second billable OpenAI image request.                                        |
| `MESSENGER_FREE_DAILY_LIMIT`                      | Customer Messenger photo quota                                     | Must be `5` in production; counts only usable, durably recorded results in the configured local calendar.                                                                 |
| `MESSENGER_FREE_MONTHLY_LIMIT`                    | Customer Messenger photo quota                                     | Must be `20` in production; scoped to the same tenant-bound privacy subject as the daily counter.                                                                         |
| `MESSENGER_IMAGE_QUOTA_TIME_ZONE`                 | Day/month reset calendar                                           | Must be `Europe/Brussels` in production so displayed balances and resets agree, including daylight-saving changes.                                                        |
| OpenAI account hard limit                         | Final provider-side spending safeguard                             | Configure this in the OpenAI account. The app does not calculate image prices; it admits images only through the 5/day and 20/month customer counters.                    |
| `SOURCE_IMAGE_ALLOWED_HOSTS`                      | Downloading inbound images before generation                       | If the exact host is not allowlisted, generation fails before OpenAI is called.                                                                                           |
| `MESSENGER_ADMIN_IDS`                             | Exact comma-separated owner PSIDs                                  | Keeps the existing owner-only customer-quota/entitlement behavior. Owner attempts remain in aggregate cost reporting. Keep the list minimal and never log its raw values. |
| `MESSENGER_GLOBAL_DAILY_AUDIO_CAP`                | Optional global Messenger audio transcription provider-attempt cap | Set for public smoke if audio messages are enabled; blocks before OpenAI transcription.                                                                                   |
| `MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP` | Optional root-gateway audio transcription cap                      | Host-level safety valve before the OpenClaw Facebook plugin downloads/transcribes Messenger voice attachments.                                                            |
| `OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD`   | Optional audio transcription cost estimate                         | Enables priced audio spend-cap checks and final-cost ledger reconciliation per OpenAI transcription attempt.                                                              |
| `MESSENGER_GLOBAL_DAILY_VIDEO_CAP`                | Optional global Messenger video provider-attempt cap               | Set before video generation is exposed to public Messenger traffic.                                                                                                       |
| `OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD`      | Optional video generation cost estimate                            | Enables priced video spend-cap checks and final-cost ledger reconciliation per generated-video attempt.                                                                   |
| `MESSENGER_OWNER_COST_ALERTS`                     | Optional owner notification for spend-cap blocks                   | Set to `1` only when `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY` are configured; alerts include metadata-only budget details.                                   |

## 4. Optional but easy to confuse

These show up in the repo and can be mistaken for the main OpenAI path.

| Variable                                   | Used by                                                          | Notes                                                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT_IN_FORGE_API_URL`                   | Storage proxy                                                    | Separate from OpenAI; used for durable generated/source image URLs.                                                                                      |
| `BUILT_IN_FORGE_API_KEY`                   | Storage proxy                                                    | Separate from `OPENAI_API_KEY`.                                                                                                                          |
| `PUBLIC_BASE_URL`                          | Trusted storage public origin/base path                          | Required in production and must be HTTPS; URL-to-key conversion rejects every other origin and sibling path.                                             |
| `STORAGE_PUBLIC_BASE_URLS`                 | Temporary storage-domain aliases                                 | Optional comma-separated exact HTTPS origins/base paths during a controlled domain migration.                                                            |
| `STORAGE_ALLOW_LEGACY_KEYS`                | Staged storage rollout bridge                                    | Default `false`; enable temporarily only while old unscoped objects or non-Messenger writers are drained, then remove after the 30-day lifecycle window. |
| `STORAGE_ALLOW_LEGACY_BEARER_AUTH`         | Storage-proxy rolling bridge                                     | Proxy-only, default `false`; enable only while old app instances still send bearer-only requests, then disable immediately after that phase.             |
| `STORAGE_RATE_LIMIT_REDIS_URL`             | Storage-proxy shared rate limiting                               | Required storage-proxy secret. Use a private Redis URL; startup, `/readyz`, and storage operations fail closed when it is unavailable.                   |
| `STORAGE_RATE_LIMIT_KEY_SECRET`            | Storage-proxy rate-limit key privacy                             | Required storage-proxy secret of at least 32 random bytes; HMACs client and tenant bucket identities before Redis storage.                               |
| `STORAGE_TRUST_FLY_CLIENT_IP`              | Storage-proxy edge-client address trust                          | Defaults false. Set true only for the reviewed public Fly-Proxy path; turn it off before any direct 6PN or alternate-proxy ingress is introduced.        |
| `REDIS_URL`                                | Replay protection, rate limiting, state and customer photo quota | Required in production; the Messenger photo quota fails closed without atomic Redis storage.                                                             |
| `WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS`      | Durable WhatsApp replay/fallback phase                           | Default and maximum `86400`; must cover `WEBHOOK_INGRESS_CONTENT_TTL_SECONDS`. Stores only the opaque replay identity and phase.                         |
| `WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS`    | WhatsApp replay owner lease                                      | Default `300`; short, renewable and never longer than `WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS` (default `900`).                                          |
| `HTTP_RATE_LIMIT_REDIS_GUARD_MAX_REQUESTS` | Global HTTP rate limiting                                        | Optional pre-Redis guard cap per window; defaults to `max(1000, HTTP_RATE_LIMIT_MAX_REQUESTS * 10)`.                                                     |
| `ADMIN_TOKEN`                              | Debug/admin endpoints                                            | Required for `/admin/disable-face-memory` and `/debug/build`; those endpoints also have a stricter admin-auth rate limit.                                |

## 5. Portal authentication

| Variable                        | Required for                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FACEBOOK_CONNECT_STORAGE_MODE` | Facebook OAuth state rolling-storage protocol  | Defaults to `legacy_compat`. Use `legacy_compat` for the first dual-reader runtime deploy, `sealed_compat` only after every old instance drains, and `sealed_only` only after a further 600-second TTL wait. Invalid values fail startup. Follow [`facebook-connect-storage-rollout.md`](facebook-connect-storage-rollout.md); combining the first dual-reader runtime deploy with sealed writes is unsafe. The schema migration bridge is a separate artifact. |
| `OAUTH_PORTAL_URL`              | Public Manus WebDev OAuth authorization origin | Optional only when browser authorization and token exchange intentionally share the `OAUTH_SERVER_URL` origin. Returned through `/api/public/config`; HTTPS required except localhost. Never infer it from Meta URLs or include credentials, query secrets, or fragments.                                                                                                                                                                                       |
| `OAUTH_SERVER_URL`              | Manus WebDev OAuth token exchange origin       | Separate from Meta/Facebook Graph and callback URLs; also used as the public portal fallback when `OAUTH_PORTAL_URL` is deliberately absent.                                                                                                                                                                                                                                                                                                                    |
| `VITE_APP_ID`                   | Public Manus WebDev OAuth project id           | Read at server runtime and returned through `/api/public/config`; it is not a client secret and is not `FB_APP_ID`.                                                                                                                                                                                                                                                                                                                                             |
| `VITE_OAUTH_PORTAL_URL`         | Optional browser build fallback                | Used only when `/api/public/config` is unavailable during local development or a build that deliberately embeds public OAuth configuration. Production should use `OAUTH_PORTAL_URL` through the runtime endpoint. HTTPS is required except localhost; never include credentials, query secrets, or fragments.                                                                                                                                                  |
| `PORTAL_BASE_URL`               | Public Leaderbot portal origin                 | Controls generated `/handoff/:token` links and takes precedence over `APP_BASE_URL`. Use the correct public HTTPS origin in production.                                                                                                                                                                                                                                                                                                                         |

## 6. Mollie billing (live remains disabled)

| Variable                                  | Required for                          | Notes                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOLLIE_BILLING_ENABLED`                  | Commercial billing exposure           | Defaults off. When false, new paid plans, provider creates and checkout URL exposure are blocked. Webhook/reconciliation/safety drain for already exposed or ambiguous work must remain available. Enable only in an approved test or launch environment.                                                                                    |
| `MOLLIE_BILLING_DRAIN_ENABLED`            | Existing Mollie activity drain        | Must be true before the first checkout and then remain true for the retained financial-record lifetime. Keeps classic webhook, history/export, reconciliation and safety outbox active after commercial disable; boot/readiness rejects drain-off when durable provider activity exists.                                                     |
| `MOLLIE_BILLING_PREFLIGHT_ENABLED`        | Provider-silent offline readiness     | Set alone while commercial, entitlement, notification, accounting and provider execution remain off. A valid `/readyz` reports `phase: "offline"` and checks configuration/schema without a Mollie call.                                                                                                                                     |
| `MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED`  | Existing paid quota enforcement       | Defaults off before migration. Must be enabled and verified before checkout can start, then kept on even if billing is paused so paid quotas cannot fall back to free behavior.                                                                                                                                                              |
| `AI_ANSWER_FINALIZATION_DRAIN_ENABLED`    | Durable AI reservation finalization   | Keep false during the offline preflight. Set true and verify its independent worker/readiness heartbeat before enabling entitlement or answer admission; keep it true while any reservation can still require finalization.                                                                                                                  |
| `AI_ANSWER_QUOTA_PREFLIGHT_ENABLED`       | Dedicated AI quota protocol preflight | Keep false during the Mollie offline phase. Enable only for the explicit quota preflight, with commercial checkout still disabled until the preflight and finalization drain are green.                                                                                                                                                      |
| `MOLLIE_API_KEY`                          | Mollie API calls                      | Use only a `test_` key until launch approval; never log or commit it.                                                                                                                                                                                                                                                                        |
| `MOLLIE_MODE`                             | Mode guard                            | Must be exactly `test` or `live` and match the key prefix.                                                                                                                                                                                                                                                                                   |
| `MOLLIE_PAYMENT_WEBHOOK_URL`              | Classic payment updates               | Exact HTTPS production path: `/api/webhooks/mollie/payments`.                                                                                                                                                                                                                                                                                |
| `APP_BASE_URL`                            | Billing redirect and trusted Origin   | HTTPS in production/live mode.                                                                                                                                                                                                                                                                                                               |
| `BILLING_SUPPORT_EMAIL`                   | Customer billing support              | Public support address, not a secret.                                                                                                                                                                                                                                                                                                        |
| `MOLLIE_LIVE_BILLING_ENABLED`             | Independent live kill switch          | Defaults off; may be `true` only with `MOLLIE_MODE=live` after GO.                                                                                                                                                                                                                                                                           |
| `MOLLIE_RECONCILIATION_ENABLED`           | Daily state reconciliation            | Defaults enabled; disabling requires an incident/change record.                                                                                                                                                                                                                                                                              |
| `MOLLIE_BILLING_SCHEDULER_MODE`           | Tenant scheduler rollout              | Must be explicit: `pilot_pin` for one approved workspace or `multi_tenant` for the reviewed broader rollout. Readiness verifies control/lane epochs, heartbeats and dead letters.                                                                                                                                                            |
| `MOLLIE_BILLING_WORKER_WORKSPACE_ID`      | Isolated pilot workspace              | Required and positive only with `pilot_pin`; must be unset with `multi_tenant`.                                                                                                                                                                                                                                                              |
| `MOLLIE_WEBHOOK_RATE_LIMIT_PER_MINUTE`    | Dedicated classic-webhook protection  | Defaults to 6000 per source IP/minute so the shared app limiter cannot suppress Mollie delivery.                                                                                                                                                                                                                                             |

## 7. Fast triage

When the bot seems broken, check in this order:

1. `OPENAI_API_KEY`
2. `FB_PAGE_ACCESS_TOKEN`
3. `FB_APP_SECRET`
4. `APP_BASE_URL`
5. `IMAGE_PROVIDER`
6. `SOURCE_IMAGE_ALLOWED_HOSTS`
7. `OPENAI_IMAGE_MAX_RETRIES` (must be `0` in production)
8. `MESSENGER_GLOBAL_DAILY_AUDIO_CAP`

If face memory is involved, also check:

1. `ENABLE_FACE_MEMORY`
2. `FACE_MEMORY_RETENTION_DAYS`
3. `ADMIN_TOKEN`
4. Storage proxy delete support: `DELETE /v1/storage/object`

If WhatsApp is involved, also check:

1. `WHATSAPP_ACCESS_TOKEN`
2. `WHATSAPP_PHONE_NUMBER_ID`
3. `WHATSAPP_BUSINESS_ACCOUNT_ID`
4. `META_VERIFY_TOKEN` or `WHATSAPP_VERIFY_TOKEN`
5. Meta callback URL: `https://leaderbot-fb-image-gen.fly.dev/webhook/whatsapp`

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
