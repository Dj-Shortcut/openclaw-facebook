# Operator Prompt Routing

This note documents the production Messenger routing behavior for operators. It
is intentionally separate from customer-facing bot instructions: customers need
simple prompt guidance, while operators need to know which runtime owns a turn
and which fallback path is expected.

## Runtime Ownership

- The root OpenClaw Facebook plugin owns Meta webhook verification, request
  signature validation, sender access checks, fast acknowledgement, and ordinary
  Messenger conversation turns.
- The Leaderbot image-generation runtime owns prompt-first image generation,
  source-photo edits, image quotas, provider spend gates, generated asset
  storage, and GDPR deletion for generated assets it stores.
- The bridge between the two runtimes is opt-in per account through
  `channels.facebook.leaderbotBridgeEnabled`. Host-level Leaderbot tokens alone
  must not cause private or ClawHub installs to forward Messenger content.

## Routing Order

For each accepted Messenger event, the gateway resolves the configured account
and sender policy first.

1. If the sender is blocked or still in pairing mode, the event stops unless
   the account is explicitly configured for the Leaderbot free-tier unknown
   sender flow.
2. If the message is a `delete my data` request and the Leaderbot bridge is
   enabled, the raw Messenger event is forwarded to the Leaderbot webhook-event
   endpoint so the image-generation runtime can process its deletion flow. If
   that forward fails, the user receives a privacy contact fallback.
3. Unknown senders in `unknownSenderMode: "leaderbot_free_tier"` are forwarded
   only for image-generation intents, attachments, interactive payloads, or
   delete-data requests. Ordinary non-image conversation is kept on the OpenClaw
   turn instead of being converted into image-generation help copy.
4. Interactive payloads that are not OpenClaw action payloads are forwarded to
   Leaderbot only when the bridge is enabled.
5. Source-photo edits, image-only uploads, media with image prompts, remembered
   assistant prompt references, and text-only image-generation intents are routed
   to Leaderbot when the bridge is enabled and the gateway budget reservation
   succeeds.
6. Greetings, help, status, ordinary text, image analysis, prompt-writing
   requests, unsupported media, and audio after transcription continue through
   OpenClaw.

## Budget And Fallback Behavior

The gateway has host-level caps before it forwards expensive work to Leaderbot:

- `MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP`
- `MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP`
- `MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP`

When a cap is exceeded, the gateway sends a short Messenger fallback reply and
does not forward the event. These caps protect the root gateway before the
image-generation runtime applies its own quota, spend, queue, and provider
attempt controls.

If the Leaderbot bridge is disabled, image-generation-looking events are logged
as skipped with `reason=disabled_by_config` and then fall back to the normal
OpenClaw turn where appropriate. If the bridge is enabled but the Leaderbot
request fails, the user receives a temporary image-generator-unavailable reply
instead of silently losing the request.

## OpenClaw Turn Safety

Untrusted Facebook-originated turns are passed into OpenClaw with a default-deny
tool policy unless the sender is command-authorized. The deny list includes
high-cost generation tools, browser/canvas/runtime/file-system tool groups, and
editing or process execution tools. This keeps ordinary Messenger conversation
useful without exposing expensive or operational tools to untrusted senders.

Messenger attachments are downloaded only from allowed Meta media hosts, with
bounded redirects, size limits, and content-type checks. Audio attachments may
be transcribed before the OpenClaw turn; if an audio-only message cannot be
transcribed, the user is asked to type the message instead.

## Metadata-Only Observability

Routing diagnostics use `messenger_trace` stages with a request id, hashed PSID,
account id, route/reason metadata, durations, and selected cap counters. Operators
should use these stages to debug routing without logging raw PSIDs, user messages,
access tokens, prompts, generated outputs, or uploaded media.

Useful stages include:

- `intent_classified`
- `messenger_event_forward_started`
- `messenger_event_forward_skipped`
- `image_gen_request_started`
- `image_gen_request_skipped`
- `audio_transcription_skipped`
- `openclaw_call_started`
- `openclaw_call_completed`
- `request_completed`

## Smoke-Test Expectations

After a deploy, operator smoke evidence should distinguish these paths:

- canonical Meta webhook verification on `/facebook/webhook`
- signed POST delivery and fast acknowledgement
- ordinary text reply through OpenClaw
- text-to-image forward through Leaderbot
- source-photo edit forward through Leaderbot
- quota or gateway-cap exhaustion fallback
- Leaderbot forward failure fallback
- `delete my data` forwarding or privacy fallback

Record only metadata-only evidence: commit/release id, route outcome, trace
stage names, cap status, and rollback target.
