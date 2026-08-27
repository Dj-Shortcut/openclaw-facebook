# Legacy OpenClaw gateway retirement

This directory is frozen. The gateway is not part of the target Leaderbot
runtime and must not receive new product features or customer traffic.

Keep its production manifest block until direct `apps/image-gen` Messenger
traffic and the required observation window are proven. Use this directory only
to identify the legacy app, verify that the direct callback is authoritative,
handle retained volume data under an explicit privacy decision, and remove the
gateway safely under P1/P5 in
[`../../docs/operations/todo.md`](../../docs/operations/todo.md).

Do not use the gateway for Leaderbot Messenger ingress, checkout, billing,
storage, portal traffic, or rollback after the approved retirement window.

The detailed update and redeploy design has been retired. A small compatibility
handoff remains because the legacy safety validator still requires it; it is
not authorization to deploy.
