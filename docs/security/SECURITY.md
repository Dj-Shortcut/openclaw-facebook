# Security & Production Hardening

This project follows a defense-in-depth approach for running a Messenger AI service in production.

## 1. Secret management

Secrets are **never committed to the repository**.

Development:

* `.env` for local development
* `.env.example` provides the required variables

Production:

* secrets are injected via Fly.io

Future improvements:

* automatic secret rotation
* scoped API keys where supported
* automated secret scanning

Recommended tools:

* GitHub Secret Scanning
* Gitleaks
* TruffleHog

## 2. Messenger webhook security

Messenger webhooks are authenticated using Meta's signature mechanism.

Protection mechanisms:

* `X-Hub-Signature-256` verification
* HMAC-SHA256 signature validation
* raw request body comparison
* `crypto.timingSafeEqual` to avoid timing attacks

Additional protections:

* rate limiting
* per-user quota
* request body size limits
* webhook replay protection with temporary event-key storage

Replay protection:

* primary dedupe key: `message.mid`
* fallback key: `entry.id + sender + timestamp`
* duplicate webhook events are ignored for a short TTL window
* Redis-backed `SET NX EX` is recommended in production to survive restarts and multi-instance deploys
* in Leaderbot production, `REDIS_URL` is required so replay protection cannot silently fall back to in-memory storage

Example strategy:

```ts
const claimed = await redis.set(`webhook-replay:${message.mid}`, "1", "EX", 300, "NX");

if (claimed !== "OK") {
  return res.sendStatus(200);
}
```

## 3. Rate limiting & abuse protection

AI endpoints must be protected against abuse.

Implemented / planned protections:

* global HTTP rate limiting
* Redis-backed rate limiting
* per user quota
* daily usage limits
* prevention of token drain attacks

Typical abuse patterns:

* prompt farming
* automated image generation abuse
* API cost draining

## 4. Input validation

All user input is treated as untrusted.

Typical protections include:

* prompt length limits
* control character stripping
* request size limits
* JSON body validation
* schema validation with Zod for webhook payloads and typed server inputs

## 5. Observability

Production systems require monitoring and structured logging.

Goals:

* structured logs
* Prometheus-style metrics
* request tracing
* alerting

Recommended metrics / alerts:

* alert on sustained `5xx` rate spikes
* alert on elevated `429` rates
* alert on latency regressions for `/webhook/facebook`
* use `X-Request-Id` to correlate logs across retries and downstream calls
* propagate W3C `traceparent` headers so the service is OpenTelemetry-ready for distributed tracing

Important rule:
Secrets must never appear in logs.

## 6. External API resilience

External services such as OpenAI can be slow or temporarily unavailable.

Production systems should implement:

* request timeout
* retry strategy
* exponential backoff
* graceful fallback

Example retry strategy:

```ts
retry({
  retries: 3,
  factor: 2,
});
```

## 7. Dependency security

Node.js dependencies are a common attack surface.

Recommended safeguards:

* `pnpm audit`
* GitHub Dependabot
* optional tools like Snyk

## 8. Container hardening

Production containers should follow minimal-privilege principles.

Best practices:

* run containers as non-root user
* minimal base image
* read-only filesystem where possible

## 9. Network architecture

Recommended production architecture:

```text
Internet
↓
Fly Edge
↓
Webhook Server
↓
Redis (private network)
↓
OpenAI API
```

Key principles:

* Redis not publicly accessible
* only internal services communicate with Redis

## 10. AI abuse protection

AI applications require additional safeguards against misuse.

Typical protections:

* per-user quotas
* rate limiting
* abuse detection
* cost control mechanisms
