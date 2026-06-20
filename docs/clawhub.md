# ClawHub Release Prep

This package is prepared for ClawHub discovery as `@dj-shortcut/facebook`.

Public listing copy is maintained in [clawhub-listing.md](clawhub-listing.md).

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

## Safety Disclosure

Before publishing, verify the listing and README disclose the optional
Leaderbot image-generation bridge. ClawHub installs must keep
`leaderbotBridgeEnabled` disabled by default so host-level
`LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN` or `INTERNAL_IMAGE_REQUEST_TOKEN` values do
not unexpectedly forward Messenger events, Page-scoped sender IDs, prompts, or
media URLs to the separate Leaderbot service.

Public Pages should use `pairing` or `allowlist` for controlled setup. Use
`open` mode or `unknownSenderMode: "leaderbot_free_tier"` only when the Page has
clear privacy and data-retention terms for public Messenger users.

## Preflight

Use Node.js `>=24.15.0` before installing or packing; this matches the current
repository runtime contract in [openclaw-update.md](openclaw-update.md).

Run the package checks before publishing:

```bash
npm ci
npm run openclaw:release-check
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

Or run the GitHub Actions workflow:

1. Add `CLAWHUB_TOKEN` as a repository secret.
2. Open **Actions** > **Publish Plugin to ClawHub**.
3. Run it with `publish` left unchecked.
4. Inspect the generated package artifact and ClawHub validation output.

Only publish for real after the dry run succeeds, the package owner is confirmed
as `@dj-shortcut`, and the release checklist in
[openclaw-update.md](openclaw-update.md) has been completed:

```bash
clawhub package publish @dj-shortcut/facebook
```

To publish from CI with GitHub OIDC provenance, rerun **Publish Plugin to
ClawHub** with `publish` checked. Pushing a trusted `v*` tag also publishes, but
uses the `CLAWHUB_TOKEN` fallback path for compatibility. The workflow builds,
tests, packs, validates the tarball contents, installs the tarball into an
isolated OpenClaw profile, uploads the tarball as an artifact, and then calls
OpenClaw's official `package-publish.yml` reusable ClawHub workflow.

## Post-Publish Smoke Test

Use a fresh profile:

```bash
openclaw --profile facebook-clawhub-smoke plugins install clawhub:@dj-shortcut/facebook
openclaw --profile facebook-clawhub-smoke plugins inspect facebook
openclaw --profile facebook-clawhub-smoke channels list --all
```

The inspect output should have no diagnostics, and the channel list should show
`Facebook` without a separate `Messenger` channel.
