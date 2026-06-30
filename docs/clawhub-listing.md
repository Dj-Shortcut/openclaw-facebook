# ClawHub Listing Copy

Use this page as the source text for the ClawHub package listing for
`@dj-shortcut/facebook`.

## Package Name

`@dj-shortcut/facebook`

## Display Name

Facebook

## Short Description

Facebook Page Messenger direct messages for OpenClaw, delivered through Meta
webhooks and Page access tokens.

## Full Description

The Facebook plugin adds a Facebook Page Messenger inbox to OpenClaw. It lets
OpenClaw receive direct messages sent to a Facebook Page, route them through the
OpenClaw conversation runtime, and send text replies back through Meta's Graph
API.

This plugin is focused on Facebook Page Messenger DMs. It is a channel plugin,
not a generic Meta automation suite. It does not add Instagram DMs, Page comment
automation, Private Replies, general OpenClaw attachment handling, or broad Meta
campaign tools. Optional Leaderbot image-generation handling exists only behind
an explicit bridge setting.

The plugin is named `facebook` because the setup is tied to a Facebook Page and
Meta app. Legacy `messenger`, `fb`, and `fbm` aliases remain only for existing
install compatibility.

## Highlights

- Receives Meta Messenger webhook events for Facebook Pages.
- Sends replies through the Facebook Graph API as the connected Page.
- Verifies Meta webhook setup with a shared verify token.
- Validates POST event signatures with `X-Hub-Signature-256`.
- Supports `pairing`, `allowlist`, `open`, and `disabled` direct-message
  policies.
- Supports multi-Page configuration from one plugin install.
- Renders channel-neutral OpenClaw conversation actions as Messenger quick
  replies.
- Keeps new installs on the `facebook` channel; `messenger` remains a legacy
  compatibility alias only.
- Keeps the external Leaderbot image-generation bridge disabled by default.

## Install

```bash
openclaw plugins install clawhub:@dj-shortcut/facebook
```

After install:

```bash
openclaw plugins inspect facebook
openclaw channels list --all
```

Expected channel result: `Facebook` appears as installed, and `Messenger` does
not appear as a separate channel.

## Compatibility

- OpenClaw host: `>=2026.6.10`
- OpenClaw build tested with: `2026.6.10`
- Node.js: `>=24.15.0`
- Plugin version: `2026.6.10`

## Basic Configuration

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

The same values can also be supplied through environment variables:

```text
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_ACCESS_TOKEN=
FACEBOOK_APP_SECRET=
FACEBOOK_VERIFY_TOKEN=
```

Legacy `MESSENGER_*` variables are temporary fallbacks for existing installs.
New installs should use `FACEBOOK_*` and `channels.facebook`.

## Meta Webhook

Default callback URL:

```text
https://<gateway-host>/facebook/webhook
```

In the Meta app dashboard, subscribe the Page to:

- `messages`
- `messaging_postbacks`
- `message_reads`

Use the same verify token in Meta and OpenClaw. For real POST events, the plugin
validates Meta's `X-Hub-Signature-256` header with `appSecret`.

## Access Modes

Default mode is `pairing`, which is safest for private testing. Unknown senders
receive a pairing code before they can talk to the assistant.

`allowlist` is also appropriate for controlled private Pages where you already
know the Page-scoped sender IDs that may use the assistant.

For public Page bots, configure:

```json5
dmPolicy: "open",
allowFrom: ["*"]
```

Opening the Page only opens the message entry point. Keep private memory,
workspace files, deployment tools, billing controls, and administrative actions
restricted through the OpenClaw host permissions.

Publish privacy and data-retention terms before enabling a public Page bot.
People may send sensitive information through Messenger, and the host runtime
may pass messages to model providers or tools according to your configuration.

## Optional Leaderbot Image Generation

The package contains a guarded bridge for Leaderbot image generation. When
`leaderbotBridgeEnabled: true` is configured, a valid internal token is present,
and `LEADERBOT_IMAGE_GEN_URL` points to the image-generation service (or
localhost during development), selected Messenger events and image prompts may
be sent to the separate Leaderbot image-generation service. That forwarded data
can include Messenger event payloads, Page-scoped sender IDs, prompt text, and
Messenger media URLs.

Forwarded scenarios include unknown-sender free-tier routing, legacy/bridge
interactive payloads, image-only source uploads for storage, source-image edit
requests, media messages paired with image-generation prompts, referenced
assistant prompt image requests, and text-to-image intents.

The bridge is disabled by default, even if `LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN`
or `INTERNAL_IMAGE_REQUEST_TOKEN` is set on the host. Do not enable it unless
you intend Messenger content and identifiers to be processed by that external
service and have disclosed the behavior to Page users.

## Production Notes

Before broad public launch:

- confirm Meta app mode, Page subscription, permissions, and app review status;
- smoke test webhook verification and live Messenger delivery with the real
  Page;
- publish a privacy policy and disclose automated or AI handling where required;
- decide how Messenger messages are retained, deleted, logged, and shared with
  model providers;
- keep the Leaderbot bridge disabled unless external image generation is an
  intentional, disclosed part of the Page experience;
- add quota, abuse, and billing controls for public or paid assistants.

Messenger messages are subject to Meta platform rules, including response-window
limits. This plugin does not bypass Meta policy or app review requirements.

## V1 Scope

Included:

- Facebook Page Messenger direct messages;
- webhook verification and signature validation;
- text replies through Page access tokens;
- pairing, allowlist, open, and disabled DM policies;
- multi-Page account configuration.

Not included:

- Instagram DMs;
- Facebook Page comment handling;
- Meta Private Replies or comment-to-DM flows;
- general OpenClaw attachments, templates, media messages, or generic Meta
  automation;
- automatic Meta app or Page subscription setup.

## Support Links

- Setup guide: `docs/setup.md`
- Complete Meta tutorial: `docs/facebook-complete-tutorial.md`
- Production readiness: `docs/production-readiness.md`
- ClawHub release prep: `docs/clawhub.md`

## Release Notes For 2026.6.10

- Prepared the package for ClawHub installation as
  `clawhub:@dj-shortcut/facebook`.
- Keeps the canonical channel id as `facebook`.
- Preserves legacy `messenger` compatibility without exposing a second new
  channel.
- Requires Node.js `>=24.15.0`, matching the current repository runtime contract.
- Verified local package install from `dj-shortcut-facebook-2026.6.10.tgz`.
