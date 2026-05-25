# X/Twitter Companion Workflow

This Facebook plugin only handles Facebook Page Messenger direct messages.
TweetClaw is a separate optional third-party OpenClaw plugin maintained outside
this repository. Keep this plugin as the Messenger transport, then install
TweetClaw only when the same OpenClaw assistant also needs X/Twitter work.

Useful combined workflows:

- answer a Facebook Page DM with a summary from recent X/Twitter search results;
- create a monitor for a keyword or account and send follow-up updates through
  the Page conversation;
- export followers or run a giveaway draw after a Page admin approves the task;
- draft a tweet or reply from a Messenger prompt, then require OpenClaw approval
  before posting.

## Install TweetClaw

Install this plugin first, then add TweetClaw. For local experiments, installing
the current TweetClaw package is fine:

```bash
openclaw plugins install clawhub:@dj-shortcut/facebook
openclaw plugins install @xquik/tweetclaw
```

For production, pin the exact TweetClaw version you tested and roll updates
through the same review path as the rest of your OpenClaw configuration:

```bash
openclaw plugins install @xquik/tweetclaw@1.6.31
openclaw plugins inspect tweetclaw --runtime
```

The TweetClaw package is published as
[`@xquik/tweetclaw`](https://www.npmjs.com/package/@xquik/tweetclaw). Its source
and OpenClaw plugin manifest live at
[`Xquik-dev/tweetclaw`](https://github.com/Xquik-dev/tweetclaw). The
[ClawHub listing](https://clawhub.ai/plugins/@xquik/tweetclaw) is useful for
browsing discovery metadata.

## Configure Credentials Separately

Use the Facebook Page credentials only for `channels.facebook`. Use an Xquik API
key only for TweetClaw:

```bash
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Do not paste Page access tokens, app secrets, verify tokens, Xquik API keys, or
TweetClaw request payloads into public chats, prompts, logs, or repository
examples.

The TweetClaw API key and any TweetClaw billing or MPP settings belong to the
third-party TweetClaw plugin config, not to `channels.facebook`.

## Example Config

See [`examples/facebook-tweetclaw-companion.json5`](../examples/facebook-tweetclaw-companion.json5)
for a combined OpenClaw config shape. It keeps each surface in its own section:

- `channels.facebook` receives and replies to Facebook Page Messenger DMs;
- `plugins.entries.tweetclaw.config` stores the optional third-party TweetClaw
  settings, such as the Xquik API key and monitor polling settings;
- `tools.alsoAllow` explicitly enables TweetClaw's `explore` and `tweetclaw`
  tools while preserving the normal OpenClaw tool profile.

## Safety Boundaries

Treat the two channels as separate trust zones:

- A public Facebook sender is not automatically approved to post, DM, follow,
  delete, create monitors, export followers, or create webhooks on X/Twitter.
- TweetClaw write-like actions should pass through OpenClaw approval prompts.
- Do not publish Page-scoped sender IDs, private Messenger text, or admin notes
  into public X/Twitter content without explicit human approval.
- Keep budget gates and tool policy in the OpenClaw host runtime.

Use TweetClaw's free `explore` tool to choose an endpoint before calling the
live `tweetclaw` tool. That makes Facebook-to-X workflows easier to review
because the assistant can show the path, method, query, and body before any
paid, private, or write action runs.
