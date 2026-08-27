# Storage Proxy for Cloudflare R2

This repo's main app already expects a Forge-style storage proxy via:

- `BUILT_IN_FORGE_API_URL`
- `BUILT_IN_FORGE_API_KEY`

The proxy implemented in [`storage-proxy/index.ts`](../apps/image-gen/storage-proxy/index.ts) keeps that contract and stores objects in Cloudflare R2.

Deployed Fly app note:

- Use Fly app `leaderbot-storage-proxy`
- Do not use the separate empty Fly app `storage-proxy`

## Contract expected by the main app

Upload request:

- `POST /v1/storage/upload?path=<object-key>`
- Header: `Authorization: Bearer <FORGE_API_KEY>`
- Headers: `X-Leaderbot-Storage-Scope`, `X-Leaderbot-Storage-Expires`, and
  `X-Leaderbot-Storage-Signature: v1=<HMAC-SHA256>`
- Body: `multipart/form-data`
- Form field: `file`

Upload response:

```json
{ "url": "https://assets.example.com/generated/disco/123.jpg" }
```

Download URL request:

- `GET /v1/storage/downloadUrl?path=<object-key>`
- The same bearer and signed scope/expiry headers are required.

Download URL response:

```json
{ "url": "https://assets.example.com/generated/disco/123.jpg" }
```

Delete request:

- `DELETE /v1/storage/object?path=<object-key>`
- The same bearer and signed scope/expiry headers are required.

Delete response:

- `204 No Content` on success.
- The main app uses this for retained source-photo deletion, including face-memory user deletion, expiry, and kill-switch cleanup.

## Proxy env vars

Required:

- `FORGE_API_KEY`
- `R2_ACCOUNT_ID` unless the reviewed deployment supplies `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_LIFECYCLE_ACCESS_KEY_ID`
- `R2_LIFECYCLE_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `PUBLIC_BASE_URL`

Keep the credentials separate. `R2_ACCESS_KEY_ID` must remain an Object Read &
Write token scoped to the production bucket. The lifecycle pair must use a
different Cloudflare R2 **Admin Read only** token. At the provider this is an
account-wide grant for bucket listing/configuration, object read/list, and
read-only R2 Data Catalog table/metadata access, not a bucket-scoped
lifecycle-only grant. The proxy never uses Data Catalog. Never give the proxy
an Admin Read & Write token.

The proxy consumes the lifecycle pair only for one
`GetBucketLifecycleConfiguration` request per process startup, before it starts
listening. Request handling and object upload, download, and deletion continue
to use the bucket-scoped object credential. The runtime can require that the two
access-key IDs differ and can prove that the lifecycle read succeeded; the S3
credential contract does not expose enough metadata to prove that Cloudflare
issued it with the intended permission level. That grant must therefore be
reviewed in Cloudflare.

Metadata-only operator evidence from 2026-08-27 records that the current
Cloudflare UI showed the dedicated credential as **Admin Read only** and the
account contained exactly one bucket, uniquely named `leaderbot-images`. No
access-key or secret value was captured. This evidence does not by itself prove
which credential is installed in Fly or that a proxy startup succeeded.

Optional:

- `R2_ENDPOINT`
  If unset, defaults to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
- `PORT`
  Defaults to `8787`
- `STORAGE_ALLOW_LEGACY_BEARER_AUTH`
  Temporary rolling-deploy bridge. Default `false`; an unsigned bearer request
  is rejected unless this is explicitly `true`.
- `STORAGE_ALLOW_LEGACY_KEYS`
  Temporary bridge for old, unscoped keys under the three known lifecycle
  prefixes. Default `false`; unknown prefixes and path traversal are always
  rejected.

## Main app env vars

Point the main app at the proxy:

- `BUILT_IN_FORGE_API_URL=https://<your-storage-proxy-host>`
- `BUILT_IN_FORGE_API_KEY=<same value as FORGE_API_KEY>`
- `PUBLIC_BASE_URL=<same public asset base configured on the proxy>`. This is
  required in production even without a path prefix: only that exact trusted
  origin/base path may be converted back to a delete/download key.
- `STORAGE_PUBLIC_BASE_URLS=<comma-separated aliases>` only during a controlled
  public-domain transition.

## How public URLs are formed

The proxy returns:

```text
<PUBLIC_BASE_URL>/<normalized-object-key>
```

Messenger example (line breaks added for readability):

- `PUBLIC_BASE_URL=https://pub-abc123.r2.dev`
- object key:
  `generated/images/v1/workspace-42/connection-7/binding-3/privacy-5/user-<64-hex-HMAC>/1787461200000-<uuid>.png`

Result:

```text
https://pub-abc123.r2.dev/generated/images/v1/workspace-42/connection-7/binding-3/privacy-5/user-<64-hex-HMAC>/1787461200000-<uuid>.png
```

## Local run

```bash
pnpm storage-proxy:dev
```

Or production-style:

```bash
pnpm storage-proxy:start
```

## Authentication canonical form

The app signs this exact newline-delimited value with `FORGE_API_KEY`:

```text
leaderbot-storage-v1
<UPPERCASE HTTP METHOD>
<exact object key>
<exact parsed v1 scope>
<Unix expiry seconds>
```

The expiry is 60 seconds from the app and the proxy rejects signatures more
than 120 seconds into the future. A signature for another method, key, tenant
scope, or privacy epoch cannot be reused. Manual bearer-only curl calls are
intentionally rejected in the final configuration.

## Tenant boundary and crash safety

The lifecycle prefix remains first (`inbound-source/`, `generated/images/`, or
`generated/videos/`). Active Messenger writers then include, in order:

```text
v1/workspace-<id>/connection-<id>/binding-<epoch>/privacy-<epoch>/user-<HMAC key>/
```

The user segment is the existing 64-hex HMAC user key, never a raw PSID. For
source, generated-image, and generated-video uploads, the exact key is added to
the epoch-specific privacy inventory before the first PUT. A worker crash or
remote timeout therefore leaves both inventory and the provider fence in place;
delete-my-data can retry cleanup without sweeping a later privacy epoch.

Logs contain only a short SHA-256 object-key hash, never the raw key.

## Required staged rollout

This invariant cannot be activated safely in one rolling deploy because the
current proxy only understands bearer auth and existing objects are unscoped:

1. Apply and verify all three 30-day lifecycle rules, including
   `generated/videos/`.
2. Deploy the new proxy with both temporary bridge flags set to `true`.
3. Deploy the app so all new Messenger objects use scoped keys and signed
   requests. Keep legacy-key support for deletion/readback of old objects (and
   until any non-Messenger writer has moved to a scoped contract).
4. Turn off `STORAGE_ALLOW_LEGACY_BEARER_AUTH` after every app instance is on
   signed requests.
5. After at least the 30-day lifecycle window and an inventory check, turn off
   `STORAGE_ALLOW_LEGACY_KEYS`. Both defaults are already fail-closed.

Do not deploy the fail-closed proxy ahead of the signing app without step 2;
that would intentionally reject the old clients.

## Production notes

- Fly deploy target for this project is `leaderbot-storage-proxy`
- Production deploys run only through the repository's manually dispatched
  `Deploy production` workflow with target `storage-proxy` and the exact
  immutable digest recorded in `deploy/production/apps.json`.
- Do not run a local or direct source `fly deploy` for this app. Read-only Fly
  status, logs, and secrets inspection must use `-a leaderbot-storage-proxy`.
- `PUBLIC_BASE_URL` should be a durable public R2 URL or custom domain.
- The bucket must be readable at `PUBLIC_BASE_URL`.
- The bucket must have prefix-scoped lifecycle expiration configured as
  documented in [`r2-retention.md`](r2-retention.md).
- The main app should only talk to the proxy, not directly to R2.
- This removes Fly machine affinity from Messenger attachment delivery because the returned URL no longer depends on local machine memory or disk.
- Retained source-image features depend on the delete endpoint for user-initiated deletion and emergency cleanup.

### Current rollout evidence (2026-08-27)

The protected deployment of the reviewed storage-proxy candidate
`sha256:d2a2be7a61d7668ec1665ab459eee2b0717020c0542a78a7faccd494a68c47cc`
failed. Its rollback completed and the restored production baseline is healthy.
The candidate is therefore not deployed-runtime evidence and must not be marked
`runtime_deployed`.

Build run `33069256896` subsequently built and attested the replacement runtime
candidate
`sha256:3f2861c2ddc373ae777122f9b6cbac0f333c7ce65c094cc5fd2dbccfdf6df1e9`
from reviewed `main` source
`16b18195646fe2db8adc70a80e60616c50b6bc7c`; the manifest binds that exact
source and digest while retaining the healthy legacy rollback. A fresh
protected deployment must still pass both health and readiness checks before
the transition can become `runtime_deployed`. Do not promote or merely relabel
the failed `d2a2...` candidate.

Protected run `33080233054` stopped before production mutation. The live
comparison after two releases during the 2026-08-27 credential rotation showed
the exact legacy image and reviewed runtime shape, with `fly_flyctl_version`
equal to `2026.8.27-dev.1787839287`. That exact temporary predecessor metadata
is recorded for this first trusted rollout only; the candidate deploy must
replace it through pinned flyctl `0.4.85`, and no other development build is
accepted.
