# OpenClaw Facebook Plugin

Private hardening repo for the installable `@openclaw/facebook` plugin.

V1 connects a Meta app, a Facebook Page, and the Messenger product so OpenClaw
can handle Facebook Page Messenger direct messages through Meta webhooks. The
public plugin id, channel id, config key, setup docs, and default webhook path
use `facebook` because this is the Facebook/Meta integration surface, not a
standalone generic Messenger channel. Legacy `messenger`, `fb`, and `fbm`
aliases remain temporarily for existing installs only.

The short version: install and configure `facebook`; expect V1 capability to be
Facebook Page Messenger DMs.

## Install

Private phase:

```bash
openclaw plugins install <private-git-or-tarball-url>
```

ClawHub phase:

```bash
openclaw plugins install clawhub:@openclaw/facebook
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

Do not configure a second active `messenger` channel. Existing
`channels.messenger` config and `MESSENGER_*` secrets remain temporary
fallbacks, but new installs should use `channels.facebook` and `FACEBOOK_*`.
The old `/messenger/webhook` path is not the new default; keep it only if an
existing deployment explicitly configured that legacy `webhookPath`.

See [`docs/setup.md`](docs/setup.md) for the full Meta setup flow.
See [`docs/clawhub.md`](docs/clawhub.md) for ClawHub release preparation.

## Local/private install validation

This plugin does not need to be published to npm before it can be installed
privately:

```bash
npm run build
npm test
npm run pack:dry
npm pack
openclaw plugins install ./openclaw-facebook-*.tgz
openclaw channels list
```

Expected channel listing: `Facebook`. There should be no separate `Messenger`
channel.

## Development

```bash
npm install
npm run build
npm test
npm run pack:dry
```

Do not commit real Page tokens, app secrets, verify tokens, PSIDs, or live
deployment config.
