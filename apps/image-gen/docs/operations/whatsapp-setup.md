# WhatsApp Setup

Last verified: 2026-06-11

Public Leaderbot WhatsApp number:

```text
+32 469 79 26 56
```

## Meta Webhook

Configure the WhatsApp webhook callback URL in Meta as:

```text
https://leaderbot-fb-image-gen.fly.dev/webhook/whatsapp
```

The verification token must match one of these deployed secrets:

- `META_VERIFY_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`

`META_VERIFY_TOKEN` is the shared Meta verification token. `WHATSAPP_VERIFY_TOKEN`
is accepted only on `/webhook/whatsapp`, so it does not broaden Facebook webhook
verification.

Meta POST deliveries must include `X-Hub-Signature-256`. The app validates that
signature with `FB_APP_SECRET` before dispatching the payload.

## Required Runtime Env Vars

These must be deployed as Fly secrets:

| Variable | Required for |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp Cloud API sends and media download |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Cloud API `/messages` endpoint |
| `FB_APP_SECRET` | Meta webhook signature verification |
| `META_VERIFY_TOKEN` or `WHATSAPP_VERIFY_TOKEN` | Meta webhook GET verification |
| `APP_BASE_URL` | Public generated/source image URLs |
| `SOURCE_IMAGE_ALLOWED_HOSTS` | Source-image fetch allowlist |
| `OPENAI_API_KEY` | Image generation |
| `REDIS_URL` | Replay protection, state store, queue/rate limits |
| `PRIVACY_PEPPER` | Stable redacted user identifiers |

Operationally useful:

| Variable | Used for |
| --- | --- |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta Business Manager diagnostics |
| `FB_APP_ID` | Meta app diagnostics |

Current Fly secret-name check on 2026-06-11 found all required WhatsApp runtime
secret names present. Secret values were not printed or copied.

## Inbound Flow

1. Meta calls `GET /webhook/whatsapp` for verification.
2. Meta sends signed POST deliveries to `/webhook/whatsapp`.
3. The route accepts payloads where `object` is `whatsapp_business_account`.
4. WhatsApp messages are normalized from `entry[].changes[].value.messages[]`.
5. Text messages run through the shared Leaderbot text handling and bot features.
6. Image messages are downloaded through the WhatsApp Cloud API media endpoint,
   persisted as application-owned inbound source images, then used by the
   prompt-first image generation flow after the user sends an edit prompt.
7. Unsupported media types return a clear text reply asking for a photo.

## Outbound Flow

Replies are sent through the WhatsApp Cloud API:

```text
POST https://graph.facebook.com/v19.0/{WHATSAPP_PHONE_NUMBER_ID}/messages
```

Text, image, and button replies use the same `WHATSAPP_ACCESS_TOKEN`. If outbound
delivery fails, inspect redacted app logs for `whatsapp_send_failed`,
`whatsapp_image_send_failed`, or `whatsapp_buttons_send_failed` without copying
tokens, phone numbers, or message text into diagnostics.

## Verification Checklist

Use metadata-only checks:

1. `GET /healthz` returns `200 ok`.
2. `GET /webhook/whatsapp` with the deployed verify token returns the raw
   `hub.challenge`.
3. The same route with a wrong token returns `403`.
4. Recent logs show `meta_webhook_verification_accepted` for successful Meta
   setup.
5. After sending a WhatsApp text to the public number, recent logs should show
   `whatsapp_webhook_post_delivery_received`,
   `whatsapp_inbound_payload_summary`, `whatsapp_normalized_inbound_event`, and
   `webhook_ack_sent` with channel `whatsapp`.
6. After sending a WhatsApp photo, logs should show `whatsapp_image_downloaded`
   and `whatsapp_image_persisted`, or `whatsapp_inbound_image_processing_failed`
   followed by a user-facing retry message.

Do not log or paste raw phone numbers, tokens, message text, media URLs, or
uploaded image contents while verifying production traffic.
