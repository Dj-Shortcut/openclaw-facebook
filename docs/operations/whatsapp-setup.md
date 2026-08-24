# WhatsApp Setup

Last verified: 2026-08-24

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
signature with `WHATSAPP_APP_SECRET` when configured, falling back to
`FB_APP_SECRET` for deployments where Messenger and WhatsApp use the same Meta
app.

## Required Runtime Env Vars

These must be deployed as Fly secrets:

| Variable                                       | Required for                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `WHATSAPP_ACCESS_TOKEN`                        | Bootstrap input for the sealed tenant binding; never a production transport fallback |
| `WHATSAPP_PHONE_NUMBER_ID`                     | Bootstrap identity for the exact WhatsApp phone binding                              |
| `WHATSAPP_BUSINESS_ACCOUNT_ID`                 | Exact provider-account identity for provisioning and readiness                       |
| `WHATSAPP_APP_SECRET` or `FB_APP_SECRET`       | Meta webhook POST signature verification                                             |
| `META_VERIFY_TOKEN` or `WHATSAPP_VERIFY_TOKEN` | Meta webhook GET verification                                                        |
| `APP_BASE_URL`                                 | Public generated/source image URLs                                                   |
| `SOURCE_IMAGE_ALLOWED_HOSTS`                   | Source-image fetch allowlist                                                         |
| `OPENAI_API_KEY`                               | Image generation                                                                     |
| `REDIS_URL`                                    | Replay protection, state store, queue/rate limits                                    |
| `PRIVACY_PEPPER`                               | Stable redacted user identifiers                                                     |

Operationally useful:

| Variable    | Used for             |
| ----------- | -------------------- |
| `FB_APP_ID` | Meta app diagnostics |

Use `WHATSAPP_APP_SECRET` when the WhatsApp Business Account / phone number is
configured under a different Meta app than the Messenger Page integration. A
wrong app secret causes real POST deliveries to fail signature validation even
when webhook GET verification succeeds.

Current Fly secret-name check on 2026-06-11 found all required WhatsApp runtime
secret names present. Secret values were not printed or copied.

## One-time tenant binding provisioning

Production transport does not read the global WhatsApp token as a fallback. A
trusted infrastructure operator must first bind the WhatsApp Business Account
and phone number to the exact customer workspace. This CLI is an operator tool,
not customer authentication: `WHATSAPP_PROVISION_ACTOR_USER_ID` identifies the
owner/admin who approved the action, but does not authenticate the shell user.
Before running it, the operator must verify and retain a durable approval record
from that exact owner/admin for the workspace, WABA and phone-number tuple. Put
only the record identifier in `WHATSAPP_PROVISION_APPROVAL_REFERENCE`; the CLI
stores only its SHA-256 digest in the metadata-only audit event.

The provisioning command performs no Meta/Graph request. It reads the token
only from the process environment, seals it with `JWT_SECRET`, and stores the
sealed value and audit event atomically through the tenant-safe
channel-connection claim.

Set the following values outside chat in the operator shell or protected job:

```text
WHATSAPP_PROVISION_CONFIRM=provision
WHATSAPP_PROVISION_WORKSPACE_ID=<workspace numeric id>
WHATSAPP_PROVISION_ACTOR_USER_ID=<workspace owner/admin numeric user id>
WHATSAPP_PROVISION_APPROVAL_REFERENCE=<durable approval record id>
WHATSAPP_BUSINESS_ACCOUNT_ID=<numeric WABA id>
WHATSAPP_PHONE_NUMBER_ID=<numeric phone-number id>
WHATSAPP_ACCESS_TOKEN=<secret from the protected environment>
JWT_SECRET=<existing application sealing secret>
DATABASE_URL=<production MySQL URL>
```

During development, run from `apps/image-gen`:

```bash
pnpm run whatsapp:provision-binding
```

For production, use the exact reviewed immutable runtime image in a protected
one-off process before exposing the new runtime, and run:

```bash
node /app/dist/provision-whatsapp-binding.cjs
```

The runtime image contains this bundled command, so the existing Fly secrets do
not need to be printed, copied into chat, or exported to an untrusted checkout.
Do not set the `WHATSAPP_PROVISION_*` controls as permanent app-wide secrets;
inject them only into the protected one-off process. A failed provisioning run
must block the runtime rollout.

The command refuses a non-owner/non-admin, invalid identifiers, a cross-tenant
provider-account claim, missing confirmation, and missing inputs. Its output
contains only the event name, workspace id, and connection status. Never pass
the access token as a command-line argument and never paste it into chat or
logs.

After provisioning, `GET /readyz` must report
`whatsapp_tenant_binding: ok`. In production, env-only credentials with no
unique connected and decryptable tenant binding deliberately keep readiness
red. Readiness also requires the stored provider-account id to match
`WHATSAPP_BUSINESS_ACCOUNT_ID` and the sealed credential to match the current
`WHATSAPP_ACCESS_TOKEN` exactly. A token rotation therefore remains fail closed
until the same protected provisioning action has atomically sealed and audited
the new credential. The boot preflight runs this check before webhook drains or
generation workers start; `/healthz` remains a liveness endpoint after a
successful boot and is not a substitute for this rollout gate.

## Inbound Flow

1. Meta calls `GET /webhook/whatsapp` for verification.
2. Meta sends signed POST deliveries to `/webhook/whatsapp`.
3. The route accepts payloads where `object` is `whatsapp_business_account`.
4. WhatsApp messages are normalized from `entry[].changes[].value.messages[]`.
5. Text and interactive reply messages run through the shared Leaderbot text handling and bot features.
6. Voice/Audio messages are normalized as `audio` (`audio`/`voice`/`ptt`) and transcribed before routing to text handling.
7. Image messages are downloaded through the WhatsApp Cloud API media endpoint,
   persisted as application-owned inbound source images, then used by the
   prompt-first image generation flow after the user sends an edit prompt.
8. Unsupported media types return a clear text reply asking for a photo.

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

1. `GET /healthz` returns `200 ok`, and `GET /readyz` reports
   `whatsapp_tenant_binding: ok`.
2. `GET /webhook/whatsapp` with the deployed verify token returns the raw
   `hub.challenge`.
3. The same route with a wrong token returns `403`.
4. Recent logs show `meta_webhook_verification_accepted` for successful Meta
   setup.
5. After sending a WhatsApp text to the public number, recent logs should show
   `whatsapp_webhook_post_delivery_received`,
   `whatsapp_inbound_payload_summary`, `whatsapp_normalized_inbound_event`, and
   `webhook_ack_sent` with channel `whatsapp`.
6. After sending a WhatsApp voice note, recent logs should show `messenger_audio_transcription_request`
   and `messenger_audio_transcription_complete`, or a fallback message such as
   `unsupportedAudio` if media download/transcription is blocked by budget/format.
7. After sending a WhatsApp photo, logs should show `whatsapp_image_downloaded`
   and `whatsapp_image_persisted`, or `whatsapp_inbound_image_processing_failed`
   followed by a user-facing retry message.

## Production smoke checklist (copy/paste)

Run this in order:

1. Health:
   - `GET https://leaderbot-fb-image-gen.fly.dev/healthz` → 200 ok
   - `GET https://leaderbot-fb-image-gen.fly.dev/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>` → challenge
   - same request with wrong token → 403
2. Webhook ingress:
   - send a WhatsApp text message
   - confirm logs include `whatsapp_webhook_post_delivery_received`, `whatsapp_normalized_inbound_event`, `webhook_ack_sent` (`channel: whatsapp`)
3. Image ingest:
   - send a WhatsApp photo
   - confirm `whatsapp_image_downloaded` and `whatsapp_image_persisted`
4. Voice ingest:
   - send a WhatsApp voice note
   - confirm `messenger_audio_transcription_request` and `messenger_audio_transcription_complete`
   - if blocked, confirm user-facing fallback key in logs (`unsupportedAudio` or budget keys)
5. Failure diagnostics:
   - inspect metadata-only errors:
     - `whatsapp_audio_media_download_failed`
     - `whatsapp_audio_event_missing_audio_id`
     - `meta_webhook_signature_validation_failed`
     - `whatsapp_send_failed`

Do not log or paste raw phone numbers, tokens, message text, media URLs, or
uploaded image contents while verifying production traffic.
