# tRPC API Surface (`/api/trpc`)

This project exposes application APIs through a single tRPC endpoint: `/api/trpc`.

Because the API is type-safe and inferred from server routers, the source of truth is:

- `server/routers.ts`
- `server/_core/systemRouter.ts`

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

## Notes

- Runtime request/response serialization uses `superjson` (`server/_core/trpc.ts`).
- Zod input validation is enforced on procedures that define `.input(...)`.
- For implementation details and definitive types, inspect the routers directly.
