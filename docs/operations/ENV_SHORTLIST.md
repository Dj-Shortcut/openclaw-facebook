# Environment shortlist

This is the operational starting point for the active `apps/image-gen` runtime.
The complete current inventory remains in `apps/image-gen/.env.example` while
legacy portal and billing code is being removed.

Never commit real values. Production secrets belong in the approved secret
store and must not appear in logs, screenshots, issues, or smoke evidence.

## Direct Messenger runtime

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode | `production` on deployed Machines |
| `APP_BASE_URL` | Public app origin | Exact reviewed HTTPS origin |
| `FB_VERIFY_TOKEN` | Meta callback verification | Random secret matching Meta |
| `FB_PAGE_ACCESS_TOKEN` | Messenger Send API | Exact owner Page token |
| `FB_APP_SECRET` | POST signature validation | Required; never disable signatures |
| `MESSENGER_PAGE_ID` | Optional Page links | Exact owner Page only |
| `REDIS_URL` | Replay, queue, state, rate limits, free quota | Required and fail-closed in production |
| `DATABASE_URL` | Current durable privacy/payment state | Required while MySQL-backed paths remain |
| `JWT_SECRET` | Current signed web/session state | Minimum 32 random characters while web routes require it |

## Privacy and identity

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `PRIVACY_PEPPER` | Pseudonymous legacy user keys | Dedicated secret; rotate only through migration |
| `CONVERSATION_SCOPE_HMAC_KEY_ID` | Versioned subject identity | Stable id such as `k1` |
| `CONVERSATION_SCOPE_HMAC_SECRET` | Page/user scope derivation | Dedicated 64-character lowercase hex secret |
| `MESSENGER_GENERATION_PARTITION_SECRET` | Opaque queue partitions | Dedicated stable secret shared by app and workers |
| `MESSENGER_GENERATION_QUEUE_WRITE_VERSION` | Queue migration phase | Use only the reviewed manifest value |
| `MESSENGER_GENERATION_CONTENT_TTL_SECONDS` | Maximum queued content retention | Never above the reviewed 24-hour ceiling |
| `WEBHOOK_INGRESS_CONTENT_TTL_SECONDS` | Raw ingress recovery window | Bounded and no longer than 24 hours |

Changing an identity or partition secret without a drain/migration can split
deduplication, state, quota, deletion, and future wallet continuity.

## Image generation and cost

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `OPENAI_API_KEY` | Image generation/editing | Provider secret |
| `OPENAI_IMAGE_MAX_RETRIES` | Billable retry control | Exactly `0` unless a reviewed idempotent policy says otherwise |
| `MESSENGER_FREE_DAILY_LIMIT` | Free daily allowance | Product-configured bounded integer |
| `MESSENGER_FREE_MONTHLY_LIMIT` | Transitional monthly ceiling | Keep until the new free policy deliberately removes it |
| `MESSENGER_IMAGE_QUOTA_TIME_ZONE` | User-visible reset calendar | `Europe/Brussels` for the current product |
| `MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD` | Provider safety cap | Required before public generation |
| `MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD` | Provider safety cap | Required before public generation |
| `MESSENGER_USER_DAILY_SPEND_CAP_USD` | Per-user safety cap | Required before paid premium rollout |
| `SOURCE_IMAGE_ALLOWED_HOSTS` | Source image fetch allowlist | Exact trusted hosts only |

Also configure the provider-account hard limit. An application credit balance
is never permission to exceed provider budgets.

## Queue and delivery

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `MESSENGER_GENERATION_QUEUE_ENABLED` | Durable image work | Enabled for production app and workers |
| `MESSENGER_GENERATION_WORKER_ONLY` | Worker process mode | Set only on worker process group |
| `MESSENGER_GENERATION_INLINE_FALLBACK` | Inline fallback | Disabled in production |
| `MESSENGER_GENERATION_ACCEPTED_TTL_SECONDS` | Request dedupe retention | Cover the full retry/recovery horizon |
| `MESSENGER_GENERATION_LEASE_HEARTBEAT_MS` | Worker ownership | Below the effective lease ceiling |
| `GRAPH_API_REQUEST_TIMEOUT_MS` | Messenger request deadline | Bounded |
| `STORAGE_REQUEST_TIMEOUT_MS` | Storage request deadline | Bounded |

## Storage

| Variable | Purpose | Production rule |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Trusted public asset base | Exact HTTPS R2/custom-domain base |
| `STORAGE_PUBLIC_BASE_URLS` | Temporary domain aliases | Migration only; remove after drain |
| `BUILT_IN_FORGE_API_URL` | Storage proxy API | Reviewed trusted origin |
| `BUILT_IN_FORGE_API_KEY` | Storage proxy authentication | Separate from OpenAI and Meta secrets |
| `STORAGE_ALLOW_LEGACY_KEYS` | Old object-key bridge | Temporary and default-off target |
| `STORAGE_ALLOW_LEGACY_BEARER_AUTH` | Old proxy-auth bridge | Proxy-only temporary rollout flag |
| `STORAGE_RATE_LIMIT_REDIS_URL` | Shared proxy rate limiting | Required private Redis URL; fail closed |
| `STORAGE_RATE_LIMIT_KEY_SECRET` | Private rate-limit keys | At least 32 random bytes |
| `R2_LIFECYCLE_ACCESS_KEY_ID` | Retention-policy inspection | Separate Cloudflare R2 Admin Read only key |
| `R2_LIFECYCLE_SECRET_ACCESS_KEY` | Retention-policy inspection | Fly secret paired with the lifecycle key |
| `STORAGE_TRUST_FLY_CLIENT_IP` | Edge-client address trust | Enable only for the reviewed Fly-Proxy path |

The proxy can prove that lifecycle inspection succeeds and that its lifecycle
key differs from its object key. It cannot prove the provider-side permission
level. Verify **Admin Read only** in Cloudflare and never record either key in
smoke evidence.

Storage-proxy-specific Redis and signing variables are documented in
[`../storage-proxy-r2.md`](../storage-proxy-r2.md).

## One-time Mollie payments

The current variable set was built for the legacy Startpilot/subscription
system. Do not enable it as the new consumer wallet merely because the variables
exist.

During migration:

- keep `MOLLIE_MODE=test`;
- keep `MOLLIE_LIVE_BILLING_ENABLED=false`;
- keep new checkout creation disabled;
- keep subscription, mandate, recurring, notification, and accounting workers
  disabled unless they are required to safely drain a previously created
  provider object;
- preserve webhook/status recovery for any already-created Test Mode payment;
- follow [`../BILLING_RUNBOOK.md`](../BILLING_RUNBOOK.md) before introducing
  wallet-specific configuration.

The new paid-credit implementation must add explicit, reviewed configuration
for offer exposure and wallet enforcement. Do not overload a legacy workspace
entitlement flag without a migration contract.

## Optional features

- `ENABLE_FACE_MEMORY=false` until consent, retention, deletion, and legal copy
  are approved.
- Audio and video provider caps must be configured before those features are
  exposed; they are not part of the premium-credit MVP.
- WhatsApp remains outside the initial commercial flow. Its existing secrets
  and binding runbook are transitional until the owner decides to retain or
  remove that channel.

## Legacy variables

OpenClaw gateway variables, portal OAuth/Page-provisioning variables, tenant
scheduler settings, recurring Mollie settings, and customer notification-plane
settings are not part of the target product. Keep only the exact values required
by the currently deployed transition; do not add them to new environments.

Remove them together with their code, secrets, workflow checks, and rollback
obligations during P5 in [`todo.md`](todo.md).
