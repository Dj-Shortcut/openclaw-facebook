# CAND-003 Validation

`apps/image-gen/server/_core/whatsappFlows/styleGenerationFlow.ts:276` checks quota, `:284` starts generation, and `:142` increments quota only after success. Messenger generation is guarded by `runGuardedGeneration` at `apps/image-gen/server/_core/webhookHandlers.ts:1469`, but the WhatsApp path lacks that same per-sender serialization.
