# AGENTS.md

# Mission

This repository powers:

* OpenClaw Facebook Messenger integration
* Leaderbot conversational assistant
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

# Product Principles

## Conversation First

The conversation layer owns:

* intent resolution
* assistant responses
* follow-up actions
* conversation state

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

### Operator and support access

* Operators should not have default read access to customer conversations, memory, uploaded knowledge, personal data, or generated prompts/outputs.
* Support access to content should require explicit customer approval where possible.
* Emergency break-glass access must be exceptional, time-limited, audited, and reviewed.
* Admin tooling should expose operational metadata by default, not raw customer content.
* Debugging tools must avoid cross-tenant search or transcript browsing unless intentionally built as a controlled, audited support feature.

These boundaries apply to admin dashboards, logs, support workflows, and incident tooling.

---

# Architectural Direction

## Desired Ownership

Conversation Layer:

* text
* images
* actions
* state transitions

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

---

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

---

# Dead Code Policy

Identity-game experiments are deprecated.

Unless a task explicitly references them:

* remove unused identity-game code
* remove unused routes
* remove unused tests
* remove unused docs

Prefer deletion over preservation.

Dead code increases maintenance cost.

---

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

---

# Compatibility Rules

Do not remove existing production behavior unless:

1. replacement exists
2. tests exist
3. migration path exists

Privacy and tenant-isolation fixes may intentionally restrict operator/admin access to customer data, provided there is a safe migration path for support workflows, auditability is preserved, and production customer functionality remains available.

Legacy Messenger style payloads should not be reintroduced. Preserve production behavior through channel-neutral `ConversationAction` inputs and explicit natural-language/image-edit requests.

---

# Production Safety

Favor:

* stability
* observability
* rollback safety

Over:

* clever abstractions
* speculative architecture
* premature optimization

Never break:

* Messenger webhook verification
* GDPR consent flow
* Delete-my-data flow
* Image generation pipeline
* OpenClaw channel compatibility

---

# Documentation Rules

Source of truth:

apps/image-gen/docs/operations/todo.md

Keep docs aligned with code.

Delete stale documents rather than maintaining outdated plans.

Historical documents should not appear actionable.

---

# Agent Decision Framework

Before making changes ask:

1. Does this move logic toward the conversation layer?
2. Does this reduce channel coupling?
3. Does this remove dead code?
4. Does this preserve production behavior?
5. Is this the smallest safe change?

If the answer to multiple questions is "no":

Stop and reconsider.

---

# Testing

Minimum expectation:

TypeScript:

```bash
cmd.exe /c node_modules\.bin\tsc.cmd --noEmit
```

Targeted tests for modified areas.

Run broader suites when changing:

* shared runtime behavior
* conversation flow
* image generation
* webhook processing

Production correctness is more important than coverage numbers.
