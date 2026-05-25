# OpenClaw Facebook Plugin

This plugin gives OpenClaw a Facebook Page inbox. After setup, people can send a
direct message to your Facebook Page and OpenClaw can receive it, decide what to
do, and reply through Messenger.

It is meant as a clear starting point for building on the Meta platform: connect
a Meta app, a Facebook Page, and the Messenger product, then let OpenClaw handle
Facebook Page Messenger DMs through Meta webhooks.

V1 is intentionally focused: Facebook Page Messenger direct messages only. It
does not yet implement comments, Private Replies/comment-to-DM flows, Instagram
DMs, attachments, or broader Meta automation.

The plugin is called `facebook` because this is the Facebook/Meta integration
surface. Legacy `messenger`, `fb`, and `fbm` aliases remain temporarily for
existing installs only.

## Install

Private phase:

```bash
openclaw plugins install <private-git-or-tarball-url>
```

ClawHub phase:

```bash
openclaw plugins install clawhub:@dj-shortcut/facebook
```

Public phase:

```bash
openclaw plugins install @dj-shortcut/facebook
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

See [`docs/setup.md`](docs/setup.md) for the short setup tutorial, and
[`docs/facebook-complete-tutorial.md`](docs/facebook-complete-tutorial.md) for
the full Meta-side guide covering the app, Page identity, permissions, review,
Messenger rules, production checks, and troubleshooting.
See [`docs/clawhub.md`](docs/clawhub.md) for ClawHub release preparation.
See [`docs/cost-control-plan.md`](docs/cost-control-plan.md) for the recommended
budget, usage-ledger, and payment boundaries for public Facebook assistants.
See [`docs/x-twitter-companion.md`](docs/x-twitter-companion.md) only if the
same OpenClaw assistant also needs X/Twitter search, monitors, webhooks, media
workflows, follower export, giveaway draws, or approval-reviewed tweet posts.
TweetClaw is a separate optional third-party plugin maintained outside this
repository; it is not required for Facebook Page Messenger DMs.

## Access model

Default setup uses `dmPolicy: "pairing"` so unknown Facebook users receive a
pairing code before they can talk to the assistant. For a public Page bot, use
`dmPolicy: "open"` with `allowFrom: ["*"]` to let anyone message the Page.

Open means the conversation entry point is public; it should not grant unknown users
privileged tools, private memory, files, git/deploy access, or admin actions.
Use separate OpenClaw permissions/tool policy for that trusted core.
Public users may send personal, financial, authentication, or business-sensitive
information into Messenger. In open mode, those messages can be forwarded into
your OpenClaw host, model provider, logs, memory, and any enabled tools according
to your runtime configuration. Publish a privacy policy, disclose automated/AI
handling where required, and decide what data is retained, deleted, or shared
with third-party providers before enabling this for a public Page.
For paid or public assistants, keep billing, credits, model selection, and tool
budgets in the OpenClaw host runtime where provider calls execute.

## Local/private install validation

This plugin does not need to be published to npm before it can be installed
privately:

```bash
npm run build
npm test
npm run pack:dry
npm pack
openclaw plugins install ./dj-shortcut-facebook-*.tgz
openclaw channels list
```

Expected channel listing: `Facebook`. There should be no separate `Messenger`
channel.

## Development

Use Node.js `22.16.0` (see `.nvmrc` / `.node-version`) before installing dependencies.
```bash
npm install
npm run build
npm test
npm run pack:dry
```

Do not commit real Page tokens, app secrets, verify tokens, PSIDs, or live
deployment config.
