# Codex Security Scan Report

Repository: `openclaw-facebook`

Scan id: `dc658e1_20260529T091956`

Scope: repository-wide, with deep review focused on high-impact runtime and security surfaces.

## Summary

The scan found five reportable issues:

- High: WhatsApp webhook deliveries bypass replay protection.
- Medium: Single-target Facebook webhook target resolution accepts signed events for an unmatched Page.
- Medium: Concurrent WhatsApp generation requests can bypass daily quota.
- Medium: User data deletion can lose retry state after storage delete failure.
- Medium: WhatsApp media download buffers the full response without local size or timeout limits.

No critical unauthenticated RCE, direct secret disclosure, SQL injection, tRPC cross-user data exposure, or Messenger source-image SSRF was validated in the reviewed shards.

Coverage note: the generated worklist contains 281 source-like rows. The scan completed deep review for the primary runtime/security shards and explicitly deferred the remaining rows outside those shard receipts.

## Findings

### High: WhatsApp Webhook Deliveries Bypass Replay Protection

Affected locations:

- `apps/image-gen/server/_core/meta/webhookRoutes.ts:163`
- `apps/image-gen/server/_core/whatsappWebhook.ts:134`
- `apps/image-gen/server/_core/whatsappWebhook.ts:146`

WhatsApp webhook payloads are HMAC-verified, then normalized and dispatched without the replay key claim used by the Facebook event path. Facebook handling calls `claimEventReplayOrLog` before processing, which reaches `claimWebhookReplayKey`; WhatsApp handling loops through normalized events directly.

Attack path: a previously valid signed WhatsApp webhook body/header is replayed unchanged to `/webhook/whatsapp` or a shared webhook route. The signature still validates, and the event can repeat outbound replies, state transitions, media downloads, source-image persistence, or image generation.

Recommendation: derive a stable WhatsApp event/message replay key and call `claimWebhookReplayKey` before `safelyProcessSingleWhatsAppEvent`. Add tests that replay the same signed WhatsApp event and assert only one processing pass.

### Medium: Single-Target Facebook Webhook Fallback Accepts Unmatched Page Events

Affected locations:

- `src/monitor.ts:704`
- `src/monitor.ts:713`
- `src/monitor.ts:1277`

`resolveMessengerEventTarget` falls back to the only configured target even when the webhook event includes a `recipient.id` that does not match that target's configured `pageId`.

Attack path: a Meta-signed event for another Page handled by the same app/callback is accepted under the configured OpenClaw account in a single-target deployment.

Recommendation: if `recipient.id` is present and no target matches, return `null` even when there is only one target. Keep the fallback only for events with no recipient page id.

### Medium: Concurrent WhatsApp Generation Requests Can Bypass Daily Quota

Affected locations:

- `apps/image-gen/server/_core/whatsappFlows/styleGenerationFlow.ts:261`
- `apps/image-gen/server/_core/whatsappFlows/styleGenerationFlow.ts:276`
- `apps/image-gen/server/_core/whatsappFlows/styleGenerationFlow.ts:284`
- `apps/image-gen/server/_core/whatsappFlows/styleGenerationFlow.ts:142`

The WhatsApp generation path checks quota, runs generation, and increments quota only after success. It is not wrapped in the per-sender `runGuardedGeneration` lock used by Messenger generation.

Attack path: a user sends concurrent style/image events. Several requests can pass `canGenerate` before any one increments quota, starting more paid generation jobs than intended.

Recommendation: serialize WhatsApp generation per sender using the same guard as Messenger, or atomically reserve quota before generation and release on failure.

### Medium: Data Deletion Loses Retry State After Storage Delete Failure

Affected locations:

- `apps/image-gen/server/_core/dataDeletionService.ts:25`
- `apps/image-gen/server/_core/dataDeletionService.ts:31`
- `apps/image-gen/server/_core/dataDeletionService.ts:71`
- `apps/image-gen/server/_core/faceMemory.ts:45`

Storage deletion failures are logged and swallowed, then `deleteUserData` clears the user state unconditionally. This can erase the pending-delete marker used by face-memory cleanup.

Attack path: a user requests deletion during a transient storage failure. The database/state reference is cleared, but private media can remain in object storage without retry state.

Recommendation: make deletion failure durable. Either fail the deletion flow until object deletes succeed, or persist pending deletion keys outside the state being cleared and retry them.

### Medium: WhatsApp Media Download Buffers Full Response Without Local Limits

Affected locations:

- `apps/image-gen/server/_core/whatsappHandlers/imageHandler.ts:34`
- `apps/image-gen/server/_core/whatsappApi.ts:192`
- `apps/image-gen/server/_core/whatsappApi.ts:221`
- `apps/image-gen/server/_core/whatsappHandlers/imageHandler.ts:42`

`downloadWhatsAppMedia` calls `arrayBuffer()` on the media response without a local content-length check, streaming byte cap, or timeout. The handler then persists the full buffer.

Attack path: an oversized or slow media response causes memory pressure, worker delay, and storage/upload cost before downstream generation controls apply.

Recommendation: mirror `sourceImageFetcher` controls for WhatsApp media: timeout, content-length precheck, streaming byte cap, allowed content types, and early body cancellation.

## Suppressed Rows

- Meta POST signature bypass: raw-body HMAC verification fails closed before route handling.
- Facebook webhook replay: event handling calls `claimWebhookReplayKey`.
- Messenger source-image SSRF/path traversal: HTTPS, exact host allowlist, no redirects, public DNS precheck, path checks, and streaming size limits are present.
- Internal route unauthenticated access: internal routes require bearer token.
- Admin debug unauthenticated access: debug route requires admin token and rate limiting.
- tRPC privileged action auth bypass: privileged mutation uses `adminProcedure`.
- Reviewed SQL injection: Drizzle builders and parameter interpolation are used.
- Reviewed client XSS: no current unsafe rendering sink found.

## Deferred Coverage

The scan generated `rank_input.csv` and `deep_review_input.csv` with 281 source-like rows. Four high-impact runtime/security shards were reviewed and receipted. Rows outside those completed shard receipts are deferred, especially ancillary scripts, docs/tests, static UI support files, and less central server modules.

Artifacts:

- Threat model: `artifacts/01_context/threat_model.md`
- Discovery: `artifacts/02_discovery/finding_discovery_report.md`
- Coverage ledger: `artifacts/03_coverage/repository_coverage_ledger.md`
- Validation summary: `artifacts/05_findings/validation_summary.md`
- Attack-path summary: `artifacts/05_findings/attack_path_analysis_report.md`
