# Storage Proxy for Cloudflare R2

This repo's main app already expects a Forge-style storage proxy via:

- `BUILT_IN_FORGE_API_URL`
- `BUILT_IN_FORGE_API_KEY`

The proxy implemented in [`storage-proxy/index.ts`](../storage-proxy/index.ts) keeps that contract and stores objects in Cloudflare R2.

Deployed Fly app note:

- Use Fly app `leaderbot-storage-proxy`
- Do not use the separate empty Fly app `storage-proxy`

## Contract expected by the main app

Upload request:

- `POST /v1/storage/upload?path=<object-key>`
- Header: `Authorization: Bearer <FORGE_API_KEY>`
- Body: `multipart/form-data`
- Form field: `file`

Upload response:

```json
{ "url": "https://assets.example.com/generated/disco/123.jpg" }
```

Download URL request:

- `GET /v1/storage/downloadUrl?path=<object-key>`
- Header: `Authorization: Bearer <FORGE_API_KEY>`

Download URL response:

```json
{ "url": "https://assets.example.com/generated/disco/123.jpg" }
```

Delete request:

- `DELETE /v1/storage/object?path=<object-key>`
- Header: `Authorization: Bearer <FORGE_API_KEY>`

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

## Main app env vars

Point the main app at the proxy:

- `BUILT_IN_FORGE_API_URL=https://<your-storage-proxy-host>`
- `BUILT_IN_FORGE_API_KEY=<same value as FORGE_API_KEY>`
- `PUBLIC_BASE_URL=<same public asset base configured on the proxy>` if the public URL includes a path prefix, so the main app can derive object keys for deletion.

## How public URLs are formed

The proxy returns:

```text
<PUBLIC_BASE_URL>/<normalized-object-key>
```

Example:

- `PUBLIC_BASE_URL=https://pub-abc123.r2.dev`
- object key: `generated/disco/1712345678-file.jpg`

Result:

```text
https://pub-abc123.r2.dev/generated/disco/1712345678-file.jpg
```

## Local run

```bash
pnpm storage-proxy:dev
```

Or production-style:

```bash
pnpm storage-proxy:start
```

## Example curl upload

```bash
curl -X POST "https://storage-proxy.example.com/v1/storage/upload?path=generated/test/example.jpg" \
  -H "Authorization: Bearer $FORGE_API_KEY" \
  -F "file=@./example.jpg;type=image/jpeg"
```

## Example curl delete

```bash
curl -X DELETE "https://storage-proxy.example.com/v1/storage/object?path=inbound-source/example.jpg" \
  -H "Authorization: Bearer $FORGE_API_KEY"
```

## Production notes

- Fly deploy target for this project is `leaderbot-storage-proxy`
- If you run Fly commands manually, prefer `-a leaderbot-storage-proxy`
- `PUBLIC_BASE_URL` should be a durable public R2 URL or custom domain.
- The bucket must be readable at `PUBLIC_BASE_URL`.
- The main app should only talk to the proxy, not directly to R2.
- This removes Fly machine affinity from Messenger attachment delivery because the returned URL no longer depends on local machine memory or disk.
- Retained source-image features depend on the delete endpoint for user-initiated deletion and emergency cleanup.
