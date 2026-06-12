# OpenClaw Update, Release, and Rollback Workflow

This is the single supported workflow for updating OpenClaw in this repository.
Do not update OpenClaw by editing files under `node_modules`, patching installed
packages, shelling into running machines, or using dashboard actions that mutate
runtime package directories.

## Runtime Contract

The repository supports one OpenClaw runtime contract:

| Requirement | Contract |
| --- | --- |
| Node.js | `>=24.0.0` |
| Package manager | npm for the root plugin package; pnpm only for subapps that already use pnpm |
| OpenClaw package | `openclaw` version recorded in `package.json` at `openclaw.build.openclawVersion` |
| Plugin SDK version | same version as `openclaw.build.openclawVersion` |
| Fly gateway OpenClaw version | same version in `deploy/fly-gateway/Dockerfile` `ARG OPENCLAW_VERSION` |
| Gateway companion runtime | `@openclaw/codex` at the same version as OpenClaw |
| Facebook plugin install | built from this repo and installed as `@dj-shortcut/facebook` |
| Runtime templates | `HEARTBEAT.md` must be present at `src/agents/templates`; workspace bootstrap templates must be present at `src/agents/templates` or `docs/reference/templates`, matching OpenClaw's packaged template search path |
| Installed package mutation | unsupported |

Automated validation:

```bash
npm run openclaw:validate
```

The Fly/Docker gateway image runs the stricter gateway validation during build:

```bash
EXPECTED_OPENCLAW_VERSION=<version> node scripts/validate-openclaw-runtime.mjs /app --gateway
```

## Update Workflow

Use this workflow for local machines, CI, servers, and hosted environments.

1. Pick the target OpenClaw version.

   ```bash
   npm view openclaw version
   npm view @openclaw/codex version
   ```

   The versions must match before updating the gateway image.

2. Update every version reference through the repository script.

   ```bash
   npm run openclaw:update -- <version>
   npm install --package-lock-only --ignore-scripts --prefer-online
   npm ci
   ```

   This updates:

   - root package version
   - root OpenClaw dev dependency
   - OpenClaw build metadata
   - manifest test expectations
   - Fly gateway `OPENCLAW_VERSION`
   - package lockfile

3. Validate the repository and runtime contract.

   ```bash
   npm run openclaw:release-check
   ```

4. Build the gateway image before merging when the update touches hosted runtime
   behavior.

   ```bash
   fly deploy -a leaderbot-openclaw-gateway --build-only
   ```

5. Open a PR. The PR must include:

   - target OpenClaw version
   - validation command output
   - gateway build result or reason it was not required
   - expected public route impact
   - rollback target or rollback capture plan
   - npm and ClawHub release decision

6. Merge only after CI passes and review confirms there is no installed-package
   patching or undocumented runtime workaround.

7. Deploy hosted environments from the merged commit.

   ```bash
   git switch main
   git pull --ff-only origin main
   npm run gateway:deploy
   ```

8. Verify production.

   ```bash
   fly status -a leaderbot-openclaw-gateway
   fly releases --image -a leaderbot-openclaw-gateway
   curl -fsS https://leaderbot-openclaw-gateway.fly.dev/healthz
   ```

   Also verify:

   - only reviewed public routes are exposed;
   - admin/dashboard access still requires the configured admin controls;
   - Facebook webhook verification still succeeds;
   - logs contain metadata, not raw customer messages or secrets.

## Automated Update PR

The scheduled/manual GitHub workflow `.github/workflows/update-openclaw.yml`
uses the same supported update script:

```bash
npm run openclaw:update -- <version>
```

It must not carry separate inline version-editing logic. If the update workflow
needs new behavior, add it to `scripts/update-openclaw.mjs` and document it here.

## Rollback Workflow

This is the single supported rollback workflow.

1. Capture the previous good image before deploy.

   ```bash
   fly releases --image -a leaderbot-openclaw-gateway
   ```

2. If the new release fails verification, redeploy the previous good image.

   ```bash
   fly deploy --image <previous-good-image> -a leaderbot-openclaw-gateway
   ```

3. Verify rollback.

   ```bash
   fly status -a leaderbot-openclaw-gateway
   curl -fsS https://leaderbot-openclaw-gateway.fly.dev/healthz
   ```

4. Record metadata-only rollback notes in the incident or PR:

   - incident id or reason
   - failed version/image
   - restored image
   - operator
   - verification outcome

Never roll back by editing `/app/node_modules`, package manifests, generated
bundles, or runtime files inside a running machine.

## Release Workflow

The update workflow and release workflow use the same validation gate.

1. Run:

   ```bash
   npm run openclaw:release-check
   npm pack
   ```

2. Validate the tarball in an isolated OpenClaw profile:

   ```bash
   openclaw --profile facebook-plugin-release plugins install ./dj-shortcut-facebook-*.tgz --force
   openclaw --profile facebook-plugin-release plugins inspect facebook
   openclaw --profile facebook-plugin-release channels list --all
   ```

3. Decide the publication target.

   - ClawHub is the canonical public install path:

     ```bash
     clawhub package publish @dj-shortcut/facebook --dry-run
     clawhub package publish @dj-shortcut/facebook
     ```

   - npm publication is a separate release decision. This package remains
     `private: true`; remove that only in a dedicated release PR that documents
     scope, ownership, package name, and compatibility impact.

4. After publishing, smoke test from a fresh profile:

   ```bash
   openclaw --profile facebook-clawhub-smoke plugins install clawhub:@dj-shortcut/facebook
   openclaw --profile facebook-clawhub-smoke plugins inspect facebook
   openclaw --profile facebook-clawhub-smoke channels list --all
   ```

Expected result: `Facebook` appears as installed and `Messenger` does not appear
as a separate channel.

## Unsupported Recovery Paths

These are explicitly unsupported:

- editing installed files under `node_modules/openclaw`;
- copying missing runtime files into installed packages;
- patching OpenClaw bundles during Docker build;
- running `npm install` inside a running Fly machine to repair production;
- relying on package-internal paths other than the documented runtime contract;
- using dashboard update actions that report `not-git-install` as a prompt for
  manual in-container recovery.

If an update requires a new OpenClaw runtime file, export, template, or behavior,
fix and publish it upstream, then update this repository to that published
version through the workflow above.
