# ClawHub Release Prep

This package is prepared for ClawHub discovery as `@openclaw/facebook`.

## Owner and Package Scope

ClawHub requires the package scope to match the publishing owner. Because the
package name is `@openclaw/facebook`, publish it with the `@openclaw` ClawHub
owner.

If publishing from a personal owner instead, rename the package first. Do not
publish `@openclaw/facebook` from a non-`@openclaw` owner.

## Current Release Choice

Canonical install target:

```bash
openclaw plugins install clawhub:@openclaw/facebook
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
.\node_modules\.bin\openclaw.cmd --profile facebook-plugin-test plugins install .\openclaw-facebook-*.tgz --force
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
clawhub package publish @openclaw/facebook --dry-run
```

Only publish for real after the dry run succeeds and the package owner is
confirmed as `@openclaw`:

```bash
clawhub package publish @openclaw/facebook
```

## Post-Publish Smoke Test

Use a fresh profile:

```bash
openclaw --profile facebook-clawhub-smoke plugins install clawhub:@openclaw/facebook
openclaw --profile facebook-clawhub-smoke plugins inspect facebook
openclaw --profile facebook-clawhub-smoke channels list --all
```

The inspect output should have no diagnostics, and the channel list should show
`Facebook` without a separate `Messenger` channel.
