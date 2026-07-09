# AGENTS.md

# Mission

This repository powers:

* OpenClaw Facebook Messenger integration
* Leaderbot tenant-owned conversational assistants
* Leaderbot image-generation platform

Primary goal:

Turn Facebook Messenger into a first-class OpenClaw channel while keeping the system maintainable, channel-neutral, and production-safe.

The long-term direction is:

Inbound Message
-> Conversation Layer
-> Conversation Response
-> Channel Renderer

The conversation layer should not know Messenger-specific details.

---

# Hard Production Rules

### Tenant Isolation

- Customer data must remain tenant-scoped and workspace-bound at all times.
- No cross-tenant reads are allowed in API handlers, jobs, logs, caches, or analytics.
- No shared memory layers or global caches may store tenant content unless explicitly justified and documented per workspace boundary.
- No shared retrieval indexes, vectors, or search artifacts may span customer workspaces unless an explicit customer-approved sharing feature exists.
- All new storage systems must document their tenant boundary model before production use.

### Privacy

- Never log raw PSIDs, access tokens, tenant secrets, customer messages, or uploaded knowledge.
- Never persist customer content in debug paths, shared tracing streams, support notes, or ad-hoc diagnostics.
- Prefer redacted logs, hashed identifiers, and metadata-only observability signals.

### Messenger Compliance

- Preserve webhook verification and request signature handling.
- Preserve GDPR consent flow and deletion requirements (`delete-my-data`).
- Avoid changes that risk violating Facebook/Messenger platform policies or sender expectations.
- Keep operational behavior compatible with approved policy envelopes during staged rollouts.

### Cost Protection

- Image generation is billable and must remain bounded by customer policy.
- Preserve quota enforcement, budget enforcement, exhaustion handling, and abuse protection.
- Never bypass quota checks in fallback paths, queue workers, or inline generation modes.
- Billing controls must remain observable with auditable signals before and after refactors.

# Meta Review Requirements

New or changed Messenger capabilities should:

- Consider Meta App Review impact before implementation.
- Preserve reviewability and keep behavior easy to demonstrate in a reproducible way.
- Avoid unnecessary permissions and never expand permission scope without explicit product and policy approval.
- Update review documentation, demo instructions, and required-permission notes whenever review scope changes.

---

# Product Principles

## Conversation First

The conversation layer owns:

* intent resolution
* assistant responses
* follow-up actions
* conversation state

Conversation state, memory, and assistant context must be scoped to the owning customer/workspace. Do not introduce shared or global memory paths that can leak customer data across tenants or channels.

Preferred response shape:

```ts
{
  text?: string;
  images?: ImageOutput[];
  actions?: ConversationAction[];
}
```

Channel implementations are responsible only for rendering.

Examples:

* Messenger -> Quick Replies
* WhatsApp -> Buttons/List Messages
* Web UI -> Chips/Pills
* Future channels -> Native controls

Never hardcode channel-specific UI decisions inside conversation logic.

---

## Prompt-First Image Generation

The primary image experience is:

User prompt
-> Image generation
-> Result

Legacy style-picker menu flows are deprecated.

Do not reintroduce style-picker systems unless explicitly requested.

Prefer:

* natural language prompts
* prompt enhancement
* assistant-guided image creation

Over:

* rigid style catalogs
* large style menus
* preset proliferation

---

## Leaderbot Customer Portal

`leaderbot.live` is intended to become a real tenant/customer portal where customers manage their own AI.

The portal direction is:

* customer account and workspace
* owned AI identity and instructions
* knowledge management
  * Knowledge management must be tenant-scoped: uploaded files, extracted text, embeddings, retrieval indexes, and assistant memory must not be shared or searchable across customer workspaces unless an explicit customer-controlled sharing feature exists.
* channel connection status
* usage, quota, billing, and privacy controls

Do not treat `leaderbot.live` as:

* a marketing-only brochure site
* the public OpenClaw gateway UI
* a place to revive old DJ/personality campaign assets

The OpenClaw/Messenger gateway must stay shielded. Public traffic may reach only required webhook/health/legal/customer-app surfaces, not internal gateway admin/API surfaces.

---

## Tenant Privacy & Data Ownership

Infrastructure ownership does not imply customer data access.

Rules:

1. Each customer gets their own assistant workspace.
2. Customer data includes conversations, assistant memory, uploaded knowledge, personal data, generated prompts/outputs, channel identifiers, and metadata.
3. Infrastructure operators may manage deployment, uptime, billing, quotas, security, and reliability, but must not have default access to customer conversation content, memory, knowledge base content, or personal data.
4. Default system behavior must be tenant isolation by design, least-privilege access, metadata-first observability, redacted logs by default, explicit customer-approved support access when content inspection is required, auditable break-glass access for exceptional incidents, and deletion/export paths for tenant-owned data.
5. Never introduce admin tooling, logs, analytics, debug endpoints, or background jobs that expose customer content across tenants by default.
6. Infrastructure ownership never implies customer-content access by default.
7. Customer content is private by default.
8. Support access must be explicit, customer-approved, and auditable.
9. Break-glass access must be exceptional, narrowly scoped, time-limited, and logged.

---

# Architectural Direction

## Desired Ownership

Conversation Layer:

* text
* images
* actions
* state transitions
* tenant-scoped memory/context boundaries

Channel Layer:

* rendering
* transport
* platform APIs

Avoid:

* Messenger payloads in domain code
* Messenger quick replies in conversation logic
* Channel-specific branching inside assistant behavior

---

## Conversation Actions

When users are offered choices, represent them as:

```ts
ConversationAction
```

not:

```ts
MessengerQuickReply
```

The assistant should be able to dynamically suggest actions regardless of topic.

Examples:

* Generate image
* Retry
* Explain more
* Change style
* Continue
* Ask another question

Actions are a conversation primitive, not a Messenger primitive.

# Current Refactor Priorities

Priority order:

1. Move interaction logic into conversation layer.
2. Reduce Messenger-specific branching.
3. Extract reusable conversation primitives.
4. Simplify webhook orchestration.
5. Remove dead code.

Not priorities:

* Large rewrites.
* Framework migrations.
* Style catalog expansion.
* Experimental routing systems.

# Out of Scope

- Do not add Facebook Login without explicit approval.
- Do not request `user_posts`.
- Do not request `user_friends`.
- Do not add social graph features.
- Do not add invasive profile collection.
- Favor minimal Meta permission requests by default.

# Dead Code Policy

Identity-game experiments are deprecated.

Unless a task explicitly references them:

* remove unused identity-game code
* remove unused routes
* remove unused tests
* remove unused docs

Prefer deletion over preservation.

Dead code increases maintenance cost.

# Refactor Rules

Keep changes:

* small
* incremental
* test-backed

Avoid:

* drive-by refactors
* unrelated cleanup
* architecture rewrites in feature PRs

If touching a large file:

* extract one responsibility
* preserve behavior
* add tests first when possible

# Compatibility Rules

Do not remove existing production behavior unless:

1. replacement exists
2. tests exist
3. migration path exists

Privacy and tenant-isolation fixes may intentionally restrict operator/admin access to customer data, provided there is a safe migration path for support workflows, auditability is preserved, and production customer functionality remains available.

Legacy Messenger style payloads should not be reintroduced. Preserve production behavior through channel-neutral `ConversationAction` inputs and explicit natural-language/image-edit requests.

# Production Safety

Favor:

* stability
* privacy-preserving observability
* rollback safety

Over:

* clever abstractions
* speculative architecture
* premature optimization

Observability should prefer metadata, health signals, aggregate metrics, and redacted diagnostics. Do not log or expose customer conversation content, memory, uploaded knowledge, personal data, or generated prompts/outputs unless there is an explicit customer-approved support flow or audited break-glass incident path.

Never break:

* Messenger webhook verification
* GDPR consent flow
* Delete-my-data flow
* Image generation pipeline
* OpenClaw channel compatibility

# High-Risk Areas

### Messenger Runtime

- `messengerWebhook.ts`
- `webhookHandlers.ts`
- `generationFlow.ts`
- `webhookGenerationJobs.ts`

Preserve webhook verification, consent gating, conversation state transitions, and image delivery paths in these files.

### Privacy Systems

- `consentService.ts`
- `faceMemory.ts`
- `delete-my-data` handlers

Avoid data-retention or observability regressions; ensure redaction and tenant boundaries remain enforced.

### Billing / Quotas

- `messengerQuota.ts`
- billing-related services
- future Stripe integrations

Quota and budget enforcement must remain intact and test-covered for fallback and failure paths.

# Documentation Rules

Source of truth:

apps/image-gen/docs/operations/todo.md

Keep docs aligned with code.

Delete stale documents rather than maintaining outdated plans.

Historical documents should not appear actionable.

# Agent Decision Framework

Before making changes ask:

1. Does this move logic toward the conversation layer?
2. Does this reduce channel coupling?
3. Does this remove dead code?
4. Does this preserve production behavior?
5. Is this the smallest safe change?

If the answer to multiple questions is "no":

Stop and reconsider.

# Testing

Minimum expectation:

TypeScript:

```bash
./node_modules/.bin/tsc --noEmit
```

Targeted tests for modified areas.

Run broader suites when changing:

* shared runtime behavior
* conversation flow
* image generation
* webhook processing

Production correctness is more important than coverage numbers.
