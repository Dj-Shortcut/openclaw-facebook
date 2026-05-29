# CAND-002 Validation

Facebook handling calls `claimEventReplayOrLog` at `apps/image-gen/server/_core/webhookHandlers.ts:435`, reaching `claimWebhookReplayKey` at `:1827`. WhatsApp handling at `apps/image-gen/server/_core/whatsappWebhook.ts:134-146` normalizes events and dispatches them without an equivalent replay claim.
