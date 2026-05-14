# OpenClaw Facebook Plugin

Private hardening repo for the installable `@openclaw/facebook` plugin.

V1 supports Facebook Page Messenger direct messages through Meta webhooks. The
public plugin and channel id are `facebook`; legacy `messenger`, `fb`, and
`fbm` aliases remain for compatibility.

## Install

Private phase:

```bash
openclaw plugins install <private-git-or-tarball-url>
```

Public phase:

```bash
openclaw plugins install @openclaw/facebook
```

## Configure

Use `channels.facebook` for new installs:

```json5
{
  channels: {
    facebook: {
      enabled: true,
      pageId: "<FACEBOOK_PAGE_ID>",
      pageAccessToken: "<FACEBOOK_PAGE_ACCESS_TOKEN>",
      appSecret: "<FACEBOOK_APP_SECRET>",
      verifyToken: "<FACEBOOK_VERIFY_TOKEN>",
      dmPolicy: "pairing"
    }
  }
}
```

Default webhook:

```text
https://<gateway-host>/facebook/webhook
```

See [`docs/setup.md`](docs/setup.md) for the full Meta setup flow.

## Development

```bash
npm install
npm run build
npm test
npm run pack:dry
```

Do not commit real Page tokens, app secrets, verify tokens, PSIDs, or live
deployment config.
