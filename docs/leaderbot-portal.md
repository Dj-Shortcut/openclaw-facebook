# Leaderbot Customer Portal

`leaderbot.live` should become a tenant/customer portal where customers manage their own AI.

This is not a public brochure site and not the internal OpenClaw gateway UI.

## Product Goal

Customers should be able to log in, configure their AI, connect channels, manage knowledge, and understand usage and privacy controls from a dedicated app surface.

## Ownership Boundary

- `leaderbot.live`: customer-facing portal and public legal pages.
- OpenClaw gateway: private runtime surface for Messenger transport and assistant execution.
- Messenger webhook routes: public only where required by Meta.
- Image generation service: separate backend capability, not the portal frontend.

## First Portal Capabilities

- Customer account and tenant/workspace selection.
- AI identity settings: name, instructions, tone, language, and model defaults.
- Knowledge management: upload, link, review, and remove customer-owned context.
- Channel management: Messenger Page connection status, webhook health, and pairing state.
- Conversations: recent activity and delivery status without exposing raw internal gateway controls.
- Usage and limits: request counts, image generation use, quota state, and upgrade prompts.
- Privacy controls: data export/deletion request handling and public `/privacy`, `/terms`, `/data-deletion` pages.

## Non-Goals

- Do not expose the OpenClaw gateway UI or admin API publicly.
- Do not make `leaderbot.live` a marketing-only landing page.
- Do not reuse old DJ/personality campaign assets for the portal.
- Do not expand legacy style-picker flows as part of the portal work.

## Security Notes

The public gateway guard should stay enabled. Customer portal code must use tenant-scoped backend APIs rather than direct gateway access.

Launch readiness work is tracked in the canonical backlog: [apps/image-gen/docs/operations/todo.md](../apps/image-gen/docs/operations/todo.md).
