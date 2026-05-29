# CAND-005 Validation

`apps/image-gen/server/_core/whatsappApi.ts:192-223` downloads WhatsApp media and returns `Buffer.from(await mediaResponse.arrayBuffer())` without a local content-length cap, streaming byte cap, or timeout. `whatsappHandlers/imageHandler.ts:42` persists the buffer.
