# Security Triage (Audit-Focused)

Date: 2026-03-04
Scope: `leaderbot-fb-image-gen`

## Data sources used

Because this environment cannot query GitHub APIs from this container, I performed triage using:

1. In-repo security-related docs and workflow config.
2. Current code paths for webhook verification and signature validation.
3. Local test execution focused on the webhook auth path.

### GitHub alert/PR inspection status

- `gh` CLI is not installed in this environment.
- Direct GitHub API requests returned `403 Forbidden` from this environment.
- npm audit endpoint also returned `403 Forbidden` from this environment.

As a result, **current live GitHub Security / CodeQL / Dependabot / PR alert state could not be fetched from GitHub** in this run.

## Triage groups

## 1) Must fix before audit

### Item: Webhook GET verification accepted unsafe edge cases when token config is missing/malformed
- **Title:** Fail-closed verification for `GET /webhook` and `GET /webhook/facebook`
- **Severity:** Medium
- **Affected file:** `server/_core/messengerWebhook.ts`
- **Real risk now?:** Yes (prior behavior could compare against undefined/malformed values and did not require a string challenge).
- **Recommended action:** Require all of the following before returning challenge:
  - `FB_VERIFY_TOKEN` configured and non-empty
  - `hub.mode === subscribe`
  - `hub.verify_token` is a string and exactly matches configured token
  - `hub.challenge` is a string
- **Status in this branch:** Fixed with minimal route guard hardening and dedicated tests.

## 2) Can document as mitigated

### Item: Meta webhook signature authenticity checks
- **Title:** Webhook POST signature verification middleware present
- **Severity:** High (if absent)
- **Affected file:** `server/_core/webhookSignatureVerification.ts` (wired in `server/_core/index.ts`)
- **Real risk now?:** No, for configured environments with `FB_APP_SECRET`; route is protected by signature middleware.
- **Recommended action:** Keep as-is; ensure `FB_APP_SECRET` is always set in production and covered by startup checks/policy.

### Item: Dependabot configuration for npm ecosystem
- **Title:** Dependabot weekly npm updates configured
- **Severity:** Informational
- **Affected file:** `.github/dependabot.yml`
- **Real risk now?:** Low by itself; this is a mitigation process, not a runtime control.
- **Recommended action:** Keep schedule; during audit, export open Dependabot alerts from GitHub UI/API from a network that can reach GitHub.

## 3) False positive / stale / superseded

### Item: Historical review notes claiming missing signature verification
- **Title:** `CODE_REVIEW.md` finding “Missing Meta webhook signature verification”
- **Severity:** High (historical claim)
- **Affected file:** `CODE_REVIEW.md`
- **Real risk now?:** No, superseded by current code that applies `verifyMetaWebhookSignature` middleware.
- **Recommended action:** Treat as stale historical finding; do not patch based on this note.
- **Superseded by:** Current implementation in `server/_core/index.ts` + `server/_core/webhookSignatureVerification.ts`.

## Open security PRs status

Unable to determine from GitHub in this environment (API access blocked), so no open security PR was classified as stale/active from live metadata.

## Changes made (smallest safe fix)

1. Hardened webhook verification handler to fail closed unless token/challenge are valid strings and configured token is non-empty.
2. Added targeted tests for missing token config, missing challenge, and valid challenge flow.

## Validation commands run

- `pnpm exec vitest run server/messengerWebhook.verification.test.ts`
