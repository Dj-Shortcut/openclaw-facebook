# Facebook Page Messenger Setup

This plugin connects OpenClaw to Facebook Page Messenger direct messages. In
Meta terms, setup involves three related pieces: a Meta app, a Facebook Page,
and the Messenger product enabled for that Page. The plugin is installed and
configured as `facebook` because it owns the Facebook/Meta integration surface;
V1 does not add a separate active `messenger` channel.

V1 capability is intentionally narrower than the plugin name: Facebook Page
Messenger DMs only.

## Meta App

1. Create or open a Meta app.
2. Enable Messenger.
3. Connect the Facebook Page that should host the assistant.
4. Generate a Page access token.
5. Copy the Page ID, Page access token, app secret, and choose a webhook verify
   token.

The Meta app provides app identity and webhook verification. The Facebook Page
provides the Page ID and Page access token. Messenger is the product surface
that delivers Page direct-message events to the webhook.

## OpenClaw Config

Use `channels.facebook` for new installs:

```json5
{
  channels: {
    facebook: {
      enabled: true,
      name: "Leaderbot",
      pageId: "<FACEBOOK_PAGE_ID>",
      pageAccessToken: "<FACEBOOK_PAGE_ACCESS_TOKEN>",
      appSecret: "<FACEBOOK_APP_SECRET>",
      verifyToken: "<FACEBOOK_VERIFY_TOKEN>",
      dmPolicy: "pairing"
    }
  }
}
```

Default account environment variables:

- `FACEBOOK_PAGE_ID`
- `FACEBOOK_PAGE_ACCESS_TOKEN`
- `FACEBOOK_APP_SECRET`
- `FACEBOOK_VERIFY_TOKEN`

Legacy `MESSENGER_*` variables remain temporary fallbacks.

## Meta Webhook

Default callback URL:

```text
https://<gateway-host>/facebook/webhook
```

The old `/messenger/webhook` path is legacy only. Keep it only when an existing
deployment explicitly sets `webhookPath: "/messenger/webhook"`; do not use it
as the default for new installs.

Subscribe the Page webhook to:

- `messages`
- `messaging_postbacks`
- `message_reads`

V1 processes text messages and skips unsupported events.

## Legacy Compatibility

Temporary compatibility remains for existing deployments:

- `channels.messenger`
- `MESSENGER_PAGE_ID`
- `MESSENGER_PAGE_ACCESS_TOKEN`
- `MESSENGER_APP_SECRET`
- `MESSENGER_VERIFY_TOKEN`
- target prefixes `messenger:<PSID>` and `fbm:<PSID>`

When both new and legacy values are present, `channels.facebook` and
`FACEBOOK_*` win. Do not register a second active Messenger channel.

## Pairing

Unknown direct-message senders receive a pairing code when `dmPolicy` is
`pairing`.

```bash
openclaw pairing list facebook
openclaw pairing approve facebook <CODE>
```

## V1 Limits

Included:

- Facebook Page Messenger direct messages
- Meta app webhook verification
- Facebook Page identity and Page access token configuration
- text inbound and text outbound replies
- webhook verification and signature validation
- pairing/allowlist access control
- multi-page account config

Not included:

- Instagram
- Page comments
- private replies
- templates and attachments
- automatic Page subscription
- broad Meta platform routing
