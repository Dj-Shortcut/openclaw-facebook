# Facebook Page Messenger Setup

This plugin connects OpenClaw to Facebook Page Messenger direct messages.

## Meta App

1. Create or open a Meta app.
2. Enable Messenger.
3. Connect the Facebook Page that should host the assistant.
4. Generate a Page access token.
5. Copy the Page ID, Page access token, app secret, and choose a webhook verify
   token.

## OpenClaw Config

Prefer `channels.facebook`:

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

Subscribe the Page webhook to:

- `messages`
- `messaging_postbacks`
- `message_reads`

V1 processes text messages and skips unsupported events.

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
