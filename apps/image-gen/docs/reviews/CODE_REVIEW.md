# Code Review – leaderbot-fb-image-gen

## Scope
- Reviewed current Messenger bot/server implementation with focus on reliability, security, and deployment readiness.
- Files reviewed include webhook handling, server bootstrap/health routes, messenger API wrapper, state/quota modules, and deployment config.

## Findings

### 1) Critical – Fly health check path mismatch can cause failing health checks
- `fly.toml` checks `GET /health`, but the server only exposes `GET /healthz`.
- Impact: instances may be marked unhealthy and restarted/never routed correctly in production.
- Evidence:
  - `fly.toml` uses `path = "/health"`.
  - `server/_core/index.ts` registers only `app.get("/healthz", ...)`.
- Recommendation:
  - Either change Fly check path back to `/healthz` **or** add a compatible `/health` endpoint (best: support both for backward compatibility).

### 2) High – Missing Meta webhook signature verification (integrity/authenticity risk)
- The webhook POST endpoint processes incoming payloads without validating `X-Hub-Signature-256` using `FB_APP_SECRET`.
- Impact: anyone who can reach the endpoint can forge webhook events, trigger bot actions, and pollute state/logs.
- Evidence:
  - `server/_core/messengerWebhook.ts` accepts and processes `req.body` directly.
  - `server/_core/index.ts` indicates `FB_APP_SECRET` exists in env flags but no validation middleware is wired.
- Recommendation:
  - Capture raw body and validate HMAC SHA-256 signature before acknowledging/processing events.
  - Reject invalid signatures with 401/403 and structured security logging.

### 3) Medium – Verification endpoint behavior when token is unset
- Webhook verification compares `token === verifyToken` where `verifyToken` may be `undefined`.
- With an omitted `hub.verify_token`, the comparison can evaluate true if both values are `undefined`.
- Impact: inconsistent/unsafe verification semantics; accidental acceptance paths if upstream sends malformed requests.
- Evidence:
  - `server/_core/messengerWebhook.ts` uses `const verifyToken = process.env.FB_VERIFY_TOKEN;` and then `token === verifyToken` without requiring `verifyToken` to be non-empty.
- Recommendation:
  - Fail closed when `FB_VERIFY_TOKEN` is missing or blank.
  - Require `typeof token === "string"` and strict equality against a non-empty configured token.

### 4) Medium – PII leakage risk in request logging
- Global request logger logs every request path/method/status and includes webhook event types.
- While payload body is not logged, there is no explicit guard for future additions, and `safeLog` redacts only keys containing `token`.
- Impact: accidental sensitive data leakage risk if logging expands (PSIDs, message text, URLs).
- Evidence:
  - `server/_core/index.ts` request logger logs all requests.
  - `server/_core/messengerApi.ts` `safeLog` only filters key names containing `token`.
- Recommendation:
  - Introduce explicit allowlist logging for webhook events.
  - Extend redaction to PSID/user IDs/message text/URLs or avoid logging user-content fields entirely.

## Positive notes
- Webhook handler responds `200` quickly and processes asynchronously, reducing timeout pressure.
- State pruning and simple quota/day-key reset logic are straightforward and testable.
- Messenger API wrapper centralizes Graph API posting and basic error handling.

## Suggested next PR plan
1. Fix health endpoint compatibility (`/health` and `/healthz`) and add regression test/check.
2. Add Meta signature verification middleware with raw-body capture and tests for valid/invalid signatures.
3. Harden verification-token logic (fail closed if missing).
4. Add structured security logs with redaction helpers and unit tests for redaction behavior.
