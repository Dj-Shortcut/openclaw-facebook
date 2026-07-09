# Leaderbot Customer Portal

`leaderbot.live` should become a tenant/customer portal where customers manage their own AI.

This is not a public brochure site and not the internal OpenClaw gateway UI.

## Product Goal

Customers should be able to log in, configure their AI, connect channels, manage knowledge, and understand usage and privacy controls from a dedicated app surface.

## Portal v1 Definition

Portal v1 is not a complete SaaS billing platform. It is the minimum customer
control surface needed to launch without exposing the internal OpenClaw gateway.

Portal v1 is complete when a real customer can:

1. Open `leaderbot.live` and see the Leaderbot customer portal, not a brochure
   page and not the OpenClaw gateway UI.
2. Sign in with Facebook Login.
3. Load their own workspace and see their workspace membership.
4. Rename the workspace.
5. View and edit the AI identity:
   - name
   - instructions
   - tone
   - language
   - model default
6. See Messenger connection status for their workspace.
7. Start Facebook Page connection, complete authorization, select a Page, and
   disconnect the Page later. Stored Page token data must not be returned to the
   browser.
8. View free-plan usage:
   - images remaining today
   - messages today
   - blocked count
   - current plan name
9. Submit a manual upgrade request and see request history/status.
10. Register knowledge sources by type/name/reference and disable them later.
    Portal v1 tracks customer-owned knowledge sources; full upload, extraction,
    embeddings, and retrieval UX are later work.
11. View and update privacy controls:
    - knowledge indexing preference
    - usage analytics preference
    - image memory retention days
12. Create export/deletion requests and see request history/status.
13. Access `/privacy`, `/terms`, and `/data-deletion` from the portal surface.

## Messenger-Origin Customer Handoff

Many customers will first meet Leaderbot inside Messenger, not by typing
`leaderbot.live` into a browser. Messenger presence is not the same thing as a
portal login: Meta gives the app a Page-scoped sender identifier for the
conversation, but that does not prove business ownership of a customer workspace
or grant Page-management permissions.

The intended low-friction path is:

1. A customer starts in Messenger.
2. After manual approval/payment, Leaderbot sends a customer-facing portal link
   inside Messenger.
3. That link contains a short-lived, single-use, signed handoff token tied to
   the Messenger conversation and the intended workspace setup.
4. Opening the link creates or resumes the customer's portal session and lands
   directly in the workspace setup surface.
5. Facebook Login or Meta OAuth is requested only when it is needed for account
   recovery, persistent member access, or Page connection permissions.

The handoff token must not expose raw PSIDs, access tokens, customer messages,
or tenant content in the URL, logs, analytics, or support tooling. Tokens must
expire quickly, be auditable, and be consumed once. Portal actions after handoff
must still enforce workspace membership and tenant boundaries.

Portal v1 passes production verification when:

```bash
pnpm --dir apps/image-gen deploy:verify-portal
```

passes against production URLs, and a manual portal smoke confirms:

- Facebook Login creates or loads a persisted customer workspace.
- The authenticated customer can load `/api/portal/snapshot`.
- AI identity changes persist and reload.
- Workspace rename persists and reloads.
- Messenger status/connect/disconnect controls are tenant-scoped.
- Messenger-origin customers can follow the portal handoff with minimal friction
  after manual approval/payment, while privileged Page connection still uses
  Meta authorization.
- Usage, upgrade request history, knowledge sources, privacy controls, and
  export/deletion request status load without cross-tenant data.
- Public routing exposes only the portal, legal pages, intended health/readiness
  and metrics surfaces, and required webhook routes.
- Internal OpenClaw gateway UI/admin/API surfaces are not publicly reachable.

## Ownership Boundary

- `leaderbot.live`: customer-facing portal and public legal pages.
- OpenClaw gateway: private runtime surface for Messenger transport and assistant execution.
- Messenger webhook routes: public only where required by Meta.
- Image generation service: separate backend capability, not the portal frontend.

## Non-Goals

- Do not expose the OpenClaw gateway UI or admin API publicly.
- Do not make `leaderbot.live` a marketing-only landing page.
- Do not reuse old DJ/personality campaign assets for the portal.
- Do not expand legacy style-picker flows as part of the portal work.
- Do not block v1 on Stripe, subscription management, invoices, or premium plan
  automation. Manual upgrade requests are the v1 billing mode.
- Do not block v1 on image gallery/history, generated-video support, full
  knowledge ingestion, embeddings UI, or conversation history.

## Security Notes

The public gateway guard should stay enabled. Customer portal code must use tenant-scoped backend APIs rather than direct gateway access.

Launch readiness work is tracked in the canonical backlog: [docs/operations/todo.md](operations/todo.md).
