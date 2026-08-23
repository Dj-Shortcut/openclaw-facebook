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
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `PUBLIC_BASE_URL`

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
