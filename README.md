# OpenClaw Facebook Plugin

[![Repo Fallow Production](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Dj-Shortcut/openclaw-facebook/main/public/badges/fallow-production-maintainability.json)](https://github.com/Dj-Shortcut/openclaw-facebook/actions/workflows/image-gen-fallow.yml)
[![Image Gen Fallow Maintainability](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Dj-Shortcut/openclaw-facebook/main/apps/image-gen/public/badges/fallow-maintainability.json)](https://github.com/Dj-Shortcut/openclaw-facebook/actions/workflows/image-gen-fallow.yml)

This plugin gives OpenClaw a Facebook Page inbox. After setup, people can send a
direct message to your Facebook Page and OpenClaw can receive it, decide what to
do, and reply through Messenger.

It is meant as a clear starting point for building on the Meta platform: connect
a Meta app, a Facebook Page, and the Messenger product, then let OpenClaw handle
Facebook Page Messenger DMs through Meta webhooks.

V1 is intentionally focused: Facebook Page Messenger direct messages only. It
does not yet implement comments, Private Replies/comment-to-DM flows, Instagram
DMs, broader Meta automation, or general OpenClaw attachment workflows. Inbound
media attachments are handled only as supported Messenger payloads for DM
ingestion, unless the optional Leaderbot bridge is explicitly enabled.

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

This repository is a monorepo containing two deliberately separate products:
the generic Facebook/OpenClaw plugin and the tenant-owned Leaderbot customer
runtime. Leaderbot customers do not pass through OpenClaw.

- **Facebook Plugin (Root):** The OpenClaw channel plugin used by the repository owner and reusable private installs.
- **Leaderbot (`apps/image-gen`):** The customer-facing full-stack runtime. It owns customer Meta webhooks, tenant conversations, portal (`leaderbot.live`), image generation, quota, billing, privacy and deletion.
- **Fly Gateway (`deploy/fly-gateway`):** Deployment configuration for the owner's private OpenClaw Messenger gateway. It is not a Leaderbot customer ingress.

```text
.
├── apps/image-gen              # Leaderbot Portal & Image-gen service
├── deploy/fly-gateway          # OpenClaw gateway deployment source
├── src                         # Facebook channel plugin source code
├── docs                        # Shared documentation and release guides
└── scripts                     # Operational and maintenance scripts
```

Production changes use only approval-protected GitHub workflows:

1. `Build trusted production artifact` builds an exact image from reviewed
   `main` and records proof of its source.
2. A reviewed manifest PR approves that immutable digest and its safe rollback.
3. `Deploy production` deploys one approved app and restores the captured
   release if its checks fail.

The image-gen database has one additional protected route:
`Apply reviewed image-gen schema expand` first proves a fresh encrypted backup
can be restored and then applies only the backwards-compatible 0016 addition.
Migration 0017 is blocked. Do not run production migrations, `fly deploy`, or
`fly machine run` by hand. See
[`docs/operations/production-deployments.md`](docs/operations/production-deployments.md).
Personal gateway maintenance is independent and never blocks a Leaderbot
customer release.

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
See [`docs/openclaw-update.md`](docs/openclaw-update.md) for the single
supported OpenClaw update, rollback, runtime validation, and release workflow.
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
pairing code before they can talk to the assistant. Generic third-party public
Page bots may use `dmPolicy: "open"` with `allowFrom: ["*"]` after publishing
appropriate privacy and retention terms. The checked-in Fly gateway stays on
`pairing` or an explicit allowlist. Leaderbot customer Pages connect directly
to `apps/image-gen`; do not use this OpenClaw access model for them.

Open means the conversation entry point is public; it should not grant unknown users
privileged tools, private memory, files, git/deploy access, or admin actions.
Use separate OpenClaw permissions/tool policy for that trusted core.
Public users may send personal, financial, authentication, or business-sensitive
information into Messenger. In open mode, those messages can be forwarded into
your OpenClaw host, model provider, logs, memory, and any enabled tools according
to your runtime configuration. Publish a privacy policy, disclose automated/AI
handling where required, and decide what data is retained, deleted, or shared
with third-party providers before enabling this for a public Page.
For generic paid or public OpenClaw assistants, keep billing, credits, model
selection, and tool budgets in the OpenClaw host runtime where provider calls
execute. Leaderbot customer billing and quota live in `apps/image-gen` instead.

## Legacy optional Leaderbot image-generation bridge

For compatibility with older deployments, this package can optionally forward Messenger events and image-generation
prompts to the separate Leaderbot image-generation service. That path can send
Messenger event payloads, Page-scoped sender IDs, prompt text, and Messenger
media URLs outside the OpenClaw host. It is disabled by default for ClawHub and
private installs, even if `LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN` or
`INTERNAL_IMAGE_REQUEST_TOKEN` exists in the host environment.

Enable it only when the Page is intentionally using Leaderbot image generation
and the Page's privacy/data-retention terms disclose that processing:

```json5
{
  channels: {
    facebook: {
      dmPolicy: "pairing",
      leaderbotBridgeEnabled: true,
      unknownSenderMode: "leaderbot_free_tier",
      defaultLang: "nl",
      sharedStateStore: "memory",
    },
  },
}
```

The bridge still requires a valid internal token and an HTTPS
`LEADERBOT_IMAGE_GEN_URL` unless you are using localhost for development.

This bridge is not part of the current Leaderbot customer architecture and is
disabled in the checked-in Fly deployment. New customer Pages must point Meta
webhooks directly at `apps/image-gen`. Do not add bridge, gateway state, or
OpenClaw quota work to the Leaderbot launch critical path.
Set `defaultLang` to `"nl"` or `"en"` globally or per named Messenger account.
Dutch remains the default for existing installations.
`sharedStateStore` is a root-only gateway setting. The default, `"memory"`, is
safe for a single gateway replica. Before running more than one replica, set it
to `"redis"` and configure `MESSENGER_SHARED_STATE_REDIS_URL`,
`MESSENGER_SHARED_STATE_HMAC_SECRET`, and optionally
`MESSENGER_SHARED_STATE_HMAC_KEY_ID`. Redis coordinates message deduplication
and the optional gateway daily caps across replicas; it does not make webhook
processing durable after the HTTP acknowledgement, so keep one replica until a
durable ingress queue/outbox is implemented.

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

Use Node.js `>=24.15.0`, matching the package runtime contract, before installing
dependencies. Use npm `>=11.12.1` at the repository root. Use pnpm `10.28.1`
only inside `apps/image-gen`, `apps/customer-app`, and
`apps/image-gen/storage-proxy`; each subapp owns its lockfile. The root
`pnpm-lock.yaml` is a compatibility mirror, not the authoritative root install
contract.

```bash
npm install
npm run build
npm test
npm run pack:dry
npm run openclaw:validate
```

Run Fallow from the repository root when you want a repo-wide dead-code and
maintainability pass:

```bash
npm run fallow:report
npm run fallow:report:production
```

The primary maintainability badge at the top of this README is generated from
the full-repo `.fallow/report.json` and published to
`public/badges/fallow-maintainability.json`. The production badge is generated
from the full-repo `.fallow/report-production.json`, which excludes test/dev
files and is published to `public/badges/fallow-production-maintainability.json`.
The image-generation app badge is a secondary app-level signal from
`apps/image-gen/.fallow/report.json`; it can stay green while repo-wide health
declines in other packages, root plugin code, or unsupported/static-analysis
entrypoints.

Badge JSON is refreshed only by the Fallow workflow on scheduled or manual runs
against `main`. Pull requests generate reports for review, but they do not write
badge changes.

Do not commit real Page tokens, app secrets, verify tokens, PSIDs, or live
deployment config.
