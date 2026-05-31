# X/Twitter GetXAPI Companion Workflow

This Facebook plugin only handles Facebook Page Messenger direct messages.
GetXAPI is a separate optional HTTP backend for X/Twitter read traffic
maintained outside this repository. Keep this plugin as the Messenger
transport, then route X/Twitter reads through GetXAPI when the same OpenClaw
assistant also needs tweet, user, or search data.

This recipe sits next to the TweetClaw companion workflow in
[`x-twitter-companion.md`](./x-twitter-companion.md). Both can be enabled in
the same deployment: TweetClaw for writes and the published-tools surface,
GetXAPI for plain read traffic.

Useful combined workflows:

- answer a Facebook Page DM with a summary fetched from a GetXAPI
  `advanced_search` call;
- pull a user's recent timeline through GetXAPI and post the digest into the
  Page conversation;
- fetch replies to a tweet through GetXAPI before a Page admin drafts an
  outbound reply through TweetClaw.

## Configure the GetXAPI Read Backend

Install this plugin first, then configure the GetXAPI key as an environment
variable for the agent process:

```bash
openclaw plugins install clawhub:@dj-shortcut/facebook
export GETXAPI_API_KEY=...
export GETXAPI_ENABLE_ACTIONS=false
```

`GETXAPI_ENABLE_ACTIONS=false` keeps the backend read-only. Flip it to `true`
only when you have explicitly reviewed the action surface; the default applies
to every recipe in this repository.

## Configure Credentials Separately

Use the Facebook Page credentials only for `channels.facebook`. Use the
GetXAPI key only for the GetXAPI client:

- `channels.facebook.*` holds Page ID, Page access token, app secret, and
  verify token.
- `GETXAPI_API_KEY` lives in the agent process environment.
- Do not paste Page access tokens, app secrets, verify tokens, or
  `GETXAPI_API_KEY` into public chats, prompts, logs, or repository examples.

## Endpoint Reference

- `GET https://api.getxapi.com/twitter/tweet/advanced_search?q=<query>`
- Header: `Authorization: Bearer ${GETXAPI_API_KEY}`

## Safety Boundaries

Treat the two surfaces as separate trust zones:

- A public Facebook sender is not automatically approved to trigger paid or
  high-volume GetXAPI reads.
- GetXAPI is read-only when `GETXAPI_ENABLE_ACTIONS` is unset or `false`.
- Do not publish Page-scoped sender IDs, private Messenger text, or admin
  notes into public X/Twitter content without explicit human approval.
- Keep budget gates and tool policy in the OpenClaw host runtime.
