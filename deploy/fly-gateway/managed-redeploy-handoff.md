# Retired managed redeploy compatibility guard

The OpenClaw gateway is frozen and scheduled for removal. This file exists only
because the legacy gateway safety validator requires a protected-workflow
handoff shape. Do not execute it for routine maintenance or product work.

If an urgent, separately approved security containment change must preserve the
temporary rollback window, the legacy protected invocation shape is:

```bash
gh workflow run deploy-production.yml -f target=gateway -f rollback_image="$REVIEWED_ROLLBACK_IMAGE"
```

Automatic recovery compatibility marker: `recover-gateway`.

The command requires the existing protected approval and reviewed immutable
image controls. It is not a direct provider command and does not authorize a
new gateway release. Remove this file with the validator and update workflow
after the gateway retirement gate closes.
