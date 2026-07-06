# tRPC API Surface (`/api/trpc`)

This project exposes application APIs through a single tRPC endpoint: `/api/trpc`.

Because the API is type-safe and inferred from server routers, the source of truth is:

- `server/routers.ts`
- `server/_core/systemRouter.ts`
- `server/_core/portalRouter.ts`

Use this document as a human-readable reference for procedures and their behavior.

## Procedures

### `system.health`

- **Type:** Query
- **Auth:** Public
- **Input schema:**
  - `timestamp: number` (must be `>= 0`)
- **Response:**
  - `{ ok: true }`

### `system.notifyOwner`

- **Type:** Mutation
- **Auth:** Admin only (`ctx.user.role === "admin"`)
- **Input schema:**
  - `title: string` (required, min length 1)
  - `content: string` (required, min length 1)
- **Response:**
  - `{ success: boolean }` (`true` when owner notification is delivered)

### `auth.me`

- **Type:** Query
- **Auth:** Public (returns current user context if authenticated)
- **Input schema:** None
- **Response:**
  - `ctx.user` (nullable/optional depending on session)

### `auth.logout`

- **Type:** Mutation
- **Auth:** Public (session-aware)
- **Input schema:** None
- **Side effects:**
  - Clears the auth session cookie.
- **Response:**
  - `{ success: true }`

## Portal Procedures (`portal.*`)

The portal router requires a valid session. Most procedures also require a `workspaceId` input.

### `portal.auth.session`

- **Type:** Query
- **Auth:** Protected
- **Response:** Current user, workspace, and membership details.

### `portal.workspace.current`

- **Type:** Query
- **Auth:** Protected
- **Response:** The user's current workspace.

### `portal.workspace.members`

- **Type:** Query
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** List of workspace members.

### `portal.aiIdentity.get`

- **Type:** Query
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** Current AI identity settings (name, instructions, tone, etc.).

### `portal.channels.status`

- **Type:** Query
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** Connection status for Facebook Messenger.

### `portal.facebook.startConnect`

- **Type:** Mutation
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** Facebook OAuth URL and state for starting a connection.

### `portal.facebook.completeConnect`

- **Type:** Mutation
- **Auth:** Protected
- **Input:** `{ workspaceId: string, state: string, code?: string }`
- **Response:** List of authorized Facebook Pages.

### `portal.facebook.selectPage`

- **Type:** Mutation
- **Auth:** Protected
- **Input:** `{ workspaceId: string, state: string, pageId: string }`
- **Response:** `{ success: true }` after connecting the selected Page.

### `portal.usage.summary`

- **Type:** Query
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** Usage statistics (remaining images, messages today, etc.).

### `portal.knowledge.list`

- **Type:** Query
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** List of registered knowledge sources.

### `portal.privacy.controls`

- **Type:** Query
- **Auth:** Protected
- **Input:** `{ workspaceId: string }`
- **Response:** Privacy settings (knowledge indexing, analytics, retention).

## Notes

- Runtime request/response serialization uses `superjson` (`server/_core/trpc.ts`).
- Zod input validation is enforced on procedures that define `.input(...)`.
- For implementation details and definitive types, inspect the routers directly.
