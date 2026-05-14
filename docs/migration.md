# Messenger to Facebook Migration

The plugin is publicly named `facebook` even though V1 supports Facebook Page
Messenger direct messages only.

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

Do not register a second active Messenger plugin alongside this Facebook plugin.
