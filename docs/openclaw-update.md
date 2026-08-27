# OpenClaw retirement guard

OpenClaw is no longer part of the target product. Do not update, publish, or
redeploy it for feature work.

This file remains temporarily because the legacy automated update workflow and
gateway documentation still link to it. Any generated OpenClaw update PR must
be closed unless an urgent security or data-loss containment issue requires a
separately approved retirement-safe patch.

Allowed work:

- verify the owner Page has moved to the direct `apps/image-gen` callback;
- confirm the gateway receives no intended Messenger traffic;
- identify and handle retained gateway state under an explicit privacy policy;
- preserve a rollback only during the approved observation window;
- disable and remove the gateway, plugin, secrets, workflows, and docs together.

Not allowed:

- routine dependency upgrades;
- ClawHub or npm publication;
- new channel, bridge, memory, agent, or customer functionality;
- reusing the gateway as checkout, billing, portal, or Messenger ingress;
- copying gateway memory or transcripts into the active bot.

The removal outcome is P5 in [`operations/todo.md`](operations/todo.md).
