# ClawHub Release Prep

This package is prepared for ClawHub discovery as `@dj-shortcut/facebook`.

## Owner and Package Scope

ClawHub requires the package scope to match the publishing owner. Because the
package name is `@dj-shortcut/facebook`, publish it with the `@dj-shortcut`
ClawHub owner.

If this plugin later moves to the official OpenClaw namespace, rename or
transfer the package to `@openclaw/facebook` and publish with the `@openclaw`
owner.

## Current Release Choice

Canonical install target:

```bash
openclaw plugins install clawhub:@dj-shortcut/facebook
```

This repo still keeps `private: true` to avoid accidental npm publication.
ClawHub publication is the next public-distribution path; npm publication
remains a separate release decision.

## Preflight

Run the package checks before publishing:

```bash
npm ci
npm run build
npm test
npm run pack:dry
npm pack
```

Verify local install from the tarball:

```bash
.\node_modules\.bin\openclaw.cmd --profile facebook-plugin-test plugins install .\dj-shortcut-facebook-*.tgz --force
.\node_modules\.bin\openclaw.cmd --profile facebook-plugin-test plugins inspect facebook
.\node_modules\.bin\openclaw.cmd --profile facebook-plugin-test channels list --all
```

Expected channel result:

- `Facebook` appears as installed.
- `Messenger` does not appear as a separate channel.

## Publish Dry Run

Install and authenticate the ClawHub CLI:

```bash
npm i -g clawhub
clawhub login
clawhub whoami
```

Dry-run the package publish:

```bash
clawhub package publish @dj-shortcut/facebook --dry-run
```

Only publish for real after the dry run succeeds and the package owner is
confirmed as `@dj-shortcut`:

```bash
clawhub package publish @dj-shortcut/facebook
```

## Post-Publish Smoke Test

Use a fresh profile:

```bash
openclaw --profile facebook-clawhub-smoke plugins install clawhub:@dj-shortcut/facebook
openclaw --profile facebook-clawhub-smoke plugins inspect facebook
openclaw --profile facebook-clawhub-smoke channels list --all
```

The inspect output should have no diagnostics, and the channel list should show
`Facebook` without a separate `Messenger` channel.
