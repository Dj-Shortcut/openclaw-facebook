# Legacy OpenClaw gateway retirement

This directory is frozen. The gateway is not part of the target Leaderbot
runtime and must not receive new product features or customer traffic.

Keep the production manifest deployment block in place. Use this directory only
to identify the legacy app, verify that the direct `apps/image-gen` callback is
authoritative, handle retained volume data under an explicit privacy decision,
and remove the gateway safely during P5 in
[`../../docs/operations/todo.md`](../../docs/operations/todo.md).

Do not use the gateway for Messenger ingress, checkout, billing, storage, portal
traffic, or rollback after the approved retirement observation window.

The detailed update and redeploy design has been retired. A small compatibility
handoff remains because the legacy safety validator still requires it; it is
not an authorization to deploy.
