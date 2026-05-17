# Facebook-to-Claw cost control plan

This plan describes how to prevent public Facebook Messenger users from creating
unbounded OpenClaw/Leaderbot costs, and how to make usage visible and billable.

## Priority

The first phase is cost containment, not payments.

1. Keep unknown Facebook users behind DM pairing.
2. Prevent duplicate Messenger webhooks from starting duplicate turns.
3. Add host-level budget and tool gates before any expensive agent turn.
4. Log all expensive Responses/API/image/tool usage into a cost ledger.
5. Add prepaid credits and user-facing billing only after the ledger is reliable.

The `openclaw-facebook` package should stay mostly transport-focused. It can
emit reliable channel metadata and prevent duplicate delivery, but the budget,
tool, payment, and billing decisions belong in the OpenClaw/Leaderbot host
runtime where model calls and tools execute.

## Phase 1: close cost leaks

### Facebook access tiers

Use channel-origin and trust tier to decide what a Messenger user may do.

| Tier | Default source | Access |
| --- | --- | --- |
| `anonymous_facebook` | New PSID, not approved | Pairing only, no agent turn |
| `paired_facebook` | Approved DM pairing | Cheap/restricted assistant profile |
| `trusted_user` | Explicit owner approval or paid account | Budgeted assistant profile |
| `admin_owner` | Owner/admin account | Full tools, still logged |

Approving DM pairing must only mean "this sender may enter the assistant". It
must not automatically grant shell, deploy, file, GitHub mutation, cloud machine,
or private-memory access.

### Default Facebook tool policy

For Facebook-originated users, default deny:

- shell or code execution
- deploys or cloud machine creation
- GitHub mutations
- private files or private memory
- image/video generation
- web search or browser automation unless explicitly allowed
- high reasoning effort or large context windows

Allow only cheap text responses and explicitly safe read-only tools until the
user is trusted and budgeted.

### Runtime budget gate

Before every expensive host action, check:

- channel is `facebook`
- account/page id
- hashed user id / `userKey`
- trust tier
- daily user spend
- global Facebook spend
- requested tool/model class
- estimated maximum cost

Recommended first defaults:

- `anonymous_facebook`: no agent turn
- `paired_facebook`: max EUR 0.05/day, 3 turns/session, cheap model only
- `trusted_user`: prepaid balance required, stop at zero
- global Facebook cap: EUR 5/day until real usage data exists

If the budget gate denies a turn, send a short safe message or silently ignore
for abuse cases. Do not start a model call first.

## Phase 2: usage ledger

Create one ledger entry per expensive provider action. Use pseudonymous user
keys, not raw PSIDs.

Minimum fields:

- `ledgerId`
- `channel`
- `accountId`
- `userKey`
- `conversationId`
- `requestId`
- `responseId`
- `provider`
- `model`
- `inputTokens`
- `cachedInputTokens`
- `outputTokens`
- `reasoningTokens`
- `imageCount`
- `toolCalls`
- `estimatedCostEur`
- `reservedCostEur`
- `finalCostEur`
- `status`
- `createdAt`
- `settledAt`

Statuses:

- `reserved`
- `estimated`
- `settled`
- `failed`
- `refunded`

The first implementation may use estimated pricing only. Reconciliation with
OpenAI Costs/invoices can come later.

## Phase 3: prepaid credits

Use prepaid credits before allowing expensive public Facebook usage.

Recommended v1:

- Mollie Checkout
- Bancontact enabled
- EUR credit packs: 5, 10, 25, 50
- no postpaid usage
- reserve cost before each turn
- capture/adjust after actual usage is known
- hard stop when credit is exhausted

Payment records should be idempotent by provider payment id. A paid Mollie
webhook may credit the account once and only once.

## User-facing overview

Every user should be able to see:

- current balance
- today's spend
- monthly spend
- spend by conversation
- spend by message/turn
- tool/image/reasoning warnings
- whether costs are estimated or settled

Messenger replies may include a short cost footer for paid/trusted users:

```text
Estimated cost: EUR 0.03. Balance: EUR 4.72.
```

For anonymous or pairing-only users, avoid cost footers and keep the flow simple.

## Admin overview

The owner dashboard should show:

- total Facebook spend today/month
- global budget remaining
- spend by account/page
- spend by userKey
- top expensive conversations
- blocked attempts
- duplicate webhook skips
- tool-denied attempts
- provider failures and retries

This dashboard is the first place to verify whether invoices match local usage.

## Abuse handling

Unknown users should not reach the assistant. If they spam before pairing:

- keep the normal OpenClaw 1-hour pairing code/request behavior
- optionally add host-level silent mutes for high message volume
- do not send extra feedback to suspected bots

Suggested future thresholds:

- more than 10 messages in 10 minutes: silent mute for 15 minutes
- more than 30 messages in 1 hour: silent mute for 24 hours

Do not apply these pre-pairing mutes to already approved owner/admin users.

## Repo boundaries

`openclaw-facebook`:

- verify and normalize Facebook/Messenger traffic
- preserve safe defaults like `dmPolicy: "pairing"`
- dedupe duplicate Meta message delivery
- pass channel/account/sender metadata to the host runtime

OpenClaw/Leaderbot host runtime:

- enforce budget policy
- enforce tool policy
- call OpenAI/Responses/Images
- write cost ledger entries
- manage prepaid credits
- expose user/admin billing views
- reconcile with provider billing

## Acceptance criteria

- Unknown Facebook users cannot trigger an agent/model/tool turn.
- Duplicate Meta deliveries do not create duplicate turns.
- Approved Facebook users cannot access full Claw tools by default.
- Every expensive provider call is tied to a `userKey` and ledger entry.
- A global Facebook daily cap can stop all public-channel spend.
- Users can see estimated cost and remaining balance before paid rollout.
- Owner can trace an invoice spike back to channel, userKey, conversation, and
  provider call.
