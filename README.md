# OpenClaw Facebook Plugin

[![Repo Fallow Maintainability](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Dj-Shortcut/openclaw-facebook/main/public/badges/fallow-maintainability.json)](https://github.com/Dj-Shortcut/openclaw-facebook/actions/workflows/image-gen-fallow.yml)
[![Image Gen Fallow Maintainability](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Dj-Shortcut/openclaw-facebook/main/apps/image-gen/public/badges/fallow-maintainability.json)](https://github.com/Dj-Shortcut/openclaw-facebook/actions/workflows/image-gen-fallow.yml)

This plugin gives OpenClaw a Facebook Page inbox. After setup, people can send a
direct message to your Facebook Page and OpenClaw can receive it, decide what to
do, and reply through Messenger.

It is meant as a clear starting point for building on the Meta platform: connect
a Meta app, a Facebook Page, and the Messenger product, then let OpenClaw handle
Facebook Page Messenger DMs through Meta webhooks.

V1 is intentionally focused: Facebook Page Messenger direct messages only. It
does not yet implement comments, Private Replies/comment-to-DM flows, Instagram
DMs, broader Meta automation, or general attachment workflows. Inbound media
attachments are handled only as supported Messenger payloads for DM ingestion.

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

## Repository Layout

This repository is now the Leaderbot/OpenClaw monorepo. The Facebook/OpenClaw
plugin still lives at the repository root so existing plugin packaging keeps
working. The production image-generation service lives in
`apps/image-gen`.

`leaderbot.live` is planned as a tenant/customer portal where customers manage
their own AI. It should not expose the private OpenClaw gateway UI/API, and it
should not become a marketing-only brochure site.

```text
.
├── apps/image-gen              # Leaderbot image-generation web/service app
├── deploy/fly-gateway          # OpenClaw gateway Fly image
├── src                         # Facebook channel plugin runtime
└── docs                        # Shared operations and release docs
```

Deploy targets:

```bash
npm run gateway:deploy
npm run image-gen:deploy
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
      dmPolicy: "pairing",
    },
  },
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

## Conversation Actions

Assistant replies may include channel-neutral `actions`:

```json
{
  "text": "What would you like to do next?",
  "actions": [
    { "id": "edit_image", "label": "Edit image", "inputText": "Edit image" },
    { "id": "new_image", "label": "New image", "inputText": "New image" }
  ]
}
```

The Facebook channel renders these actions as Messenger quick replies. When a
person clicks one, the action id is decoded back into the next inbound message
text, so the assistant receives it like normal user input instead of a
Messenger-specific payload branch.

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

Use Node.js `22.19.0` (see `.nvmrc` / `.node-version`) before installing dependencies.

```bash
npm install
npm run build
npm test
npm run pack:dry
```

Run Fallow from the repository root when you want a repo-wide dead-code and
maintainability pass:

```bash
npm run fallow:report
npm run fallow:report:production
```

The primary maintainability badge at the top of this README is generated from
the full-repo `.fallow/report.json` and published to
`public/badges/fallow-maintainability.json`. The image-generation app badge is a
secondary app-level signal from `apps/image-gen/.fallow/report.json`; it can stay
green while repo-wide health declines in other packages, root plugin code, or
unsupported/static-analysis entrypoints.

Badge JSON is refreshed only by the Fallow workflow on scheduled or manual runs
against `main`. Pull requests generate reports for review, but they do not write
badge changes.

Do not commit real Page tokens, app secrets, verify tokens, PSIDs, or live
deployment config.
