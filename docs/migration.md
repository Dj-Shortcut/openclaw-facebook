# Messenger to Facebook Migration

The plugin is publicly named `facebook` even though V1 supports Facebook Page
Messenger direct messages only. That is intentional: the runtime setup is a
Facebook/Meta integration made of a Meta app, a Facebook Page, and the Messenger
product for Page DMs.

Use `facebook` for the public plugin/channel/config/webhook surface. Treat
`messenger` as the old compatibility name for the current DM capability, not as
a second active channel.

New installs should use the plugin package `@dj-shortcut/facebook`, plugin id
`facebook`, channel id `facebook`, `channels.facebook`, `FACEBOOK_*` secrets,
and the default webhook path `/facebook/webhook`.

Use new config:

```json5
{
  channels: {
    facebook: {
      enabled: true
    }
  }
}
```

Temporary compatibility:

- `channels.messenger`
- `MESSENGER_PAGE_ID`
- `MESSENGER_PAGE_ACCESS_TOKEN`
- `MESSENGER_APP_SECRET`
- `MESSENGER_VERIFY_TOKEN`
- target prefixes such as `messenger:<id>` and `fbm:<id>`

Precedence:

- `channels.facebook` wins over `channels.messenger`
- `FACEBOOK_*` wins over `MESSENGER_*`

The old `/messenger/webhook` path works only when an existing deployment
explicitly configures it as `webhookPath`; it is not the default for new
setups.

Do not register a second active Messenger plugin alongside this Facebook plugin.

## Leaderbot/Fly migration notes

- Set `OPENCLAW_EXTENSIONS="facebook"`
- Move deployment config to `channels.facebook.accounts.leaderbot`
- Update the Meta callback to `https://<gateway-host>/facebook/webhook`
- Existing Fly/Leaderbot `MESSENGER_*` secrets may remain until the next secret
  rotation, then move them to `FACEBOOK_*`

## Public Leaderbot mode

If Leaderbot is meant to be reachable by anyone who messages the Facebook Page,
set:

```json5
dmPolicy: "open",
allowFrom: ["*"]
```

That makes the Page DM entry point public. It should not make powerful tools public.
Keep Codex/workspace access, private memory, git/deploys, config changes, and
other high-impact actions behind OpenClaw permissions for trusted users only.
