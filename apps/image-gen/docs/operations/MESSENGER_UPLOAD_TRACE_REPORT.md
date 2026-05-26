# Messenger image upload trace report (no functional changes)

## 1) Send API code paths

### Core Send API wrapper
- **`sendMessage(psid, message)`** in `server/_core/messengerApi.ts` sends all outbound Messenger messages to:
  - `POST https://graph.facebook.com/v21.0/me/messages?access_token=...`
  - body shape:
    ```json
    {
      "recipient": { "id": "<PSID>" },
      "message": { ... }
    }
    ```

### Message-type helpers using `sendMessage`
- **`sendText(psid, text)`**
  - message payload:
    ```json
    { "text": "..." }
    ```
- **`sendQuickReplies(psid, text, replies)`**
  - message payload:
    ```json
    {
      "text": "...",
      "quick_replies": [
        { "content_type": "text", "title": "...", "payload": "..." }
      ]
    }
    ```
- **`sendGenericTemplate(psid, elements)`**
  - message payload:
    ```json
    {
      "attachment": {
        "type": "template",
        "payload": {
          "template_type": "generic",
          "elements": [ ... ]
        }
      }
    }
    ```
- **`sendImage(psid, imageUrl)`**
  - message payload:
    ```json
    {
      "attachment": {
        "type": "image",
        "payload": {
          "url": "<imageUrl>",
          "is_reusable": false
        }
      }
    }
    ```

### Where `sendImage` is called
- In generation success path: `runStyleGeneration(...)` after `OPENAI_CALL_SUCCESS`.
- In `handlePayload(...)` when payload is `DOWNLOAD_HD` and `state.lastImageUrl` exists.

## 2) Image-send / attachment-upload method used

Only one image-send method is implemented for Messenger output:

- ✅ **Method (a) Send API with `attachment.payload.url`** is used via `sendImage`.
- ❌ **Method (b) `me/message_attachments` upload endpoint** is **not present** in server code.
- ❌ **Method (c) direct binary multipart upload to Messenger** is **not present** in server code.

So this app currently depends on Messenger fetching a URL (`payload.url`) from the internet.

## 3) Happy-path call chain to first generated-image send

From webhook event to generated image send:

1. `POST /webhook/facebook` route receives payload and schedules async processing.
2. `processFacebookWebhookPayload(payload)` iterates entries/events.
3. `handleEvent(event)` routes message/postback.
4. `handleMessage(...)` or `handlePayload(...)` resolves selected style.
5. `handleStyleSelection(...)` logs `STYLE_SELECTED`.
6. `runStyleGeneration(...)` logs `STATE_BEFORE_GENERATE`, `OPENAI_CALL_START`.
7. `generator.generate(...)` returns image URL, then logs `OPENAI_CALL_SUCCESS`.
8. `safeLog("generation_success", { mode, ... })`.
9. **First Messenger image send call:** `sendImage(psid, imageUrl)`.
10. `sendImage` -> `sendMessage` -> `POST /me/messages` with image attachment URL payload.

## 4) Image provider boundary

- `mode: "openai-images"` is produced by `createImageGenerator(...)` through the current image provider boundary.
- `IMAGE_PROVIDER` is optional; when unset, `getImageProvider()` defaults to `openai-images`.
- Any other `IMAGE_PROVIDER` value fails fast during generator creation.
- The image service no longer produces localhost `/demo/<style-file>.png` fallback URLs.

Reachability implications:
- The current `openai-images` provider depends on normal app/storage configuration.
- `APP_BASE_URL` must be a valid public URL for generated image delivery.
- Troubleshooting should treat localhost/demo URLs as obsolete legacy/mock evidence, not as output from the current image service.

## 5) Most likely root causes for Messenger 400 "Bijlage uploaden is mislukt"

Based on current code and payload shape:

1. **Generated image URL not publicly reachable from Meta**
   - Code always sends by URL (`payload.url`) and never uploads binary.
   - Confirm `APP_BASE_URL` and storage proxy configuration before debugging generated URL delivery.

2. **OpenAI returned URL may be temporary/expired or inaccessible at send time**
   - OpenAI path takes `result.data[0].url` and immediately forwards that URL to Messenger with no persistence/proxying.
   - If URL expiry/access policy blocks Meta crawler, Messenger attachment fetch/upload can fail.

3. **Resource at URL not acceptable as Messenger image fetch target (content-type/auth/redirect constraints)**
   - Since app does not use `message_attachments` upload nor binary upload, success depends entirely on Meta being able to fetch `payload.url` as a valid image.
   - Any non-image response, blocked redirect, signed URL policy, or inaccessible host can trigger upload failure.

---

## Exact line likely triggering the failure

The first send attempt for the generated image is:
- `await sendImage(psid, imageUrl);` in `runStyleGeneration(...)`.
- That delegates to `sendMessage(...)` with `attachment.type="image"` and `payload.url=imageUrl`.
