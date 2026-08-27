# Leaderbot Image Generator - Primary Backlog (`todo.md`)

> Dit bestand is de enige bron van waarheid voor open werk.
> Historische audit- en refactorrapporten zijn verwijderd of samengevat; open punten staan hier.

## Verified snapshot

- Last reviewed `main` baseline: **2026-08-25** commit
  **`0b4a9c66b57a9d6fdbd9dde49b778cba36fca17d`**. Protected production
  [run 32820475232](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32820475232)
  deployed immutable image digest
  `sha256:33390bc580305a8549667633a9a2f9eac30dcd34262d11f75270a40aaf5bfd1e`.
  Public `/healthz` and `/readyz` returned HTTP 200; billing readiness reported
  `phase: "offline"` with no Mollie API or payment call.
- Current direction: generic prompt-first image generation; legacy style-picker UI, quick-reply flows, and director-mode preset plumbing are removed. Internal style-preset compatibility may remain only as backend fallback.
- Product direction: `leaderbot.live` and `apps/image-gen` form the direct
  multi-tenant customer path. OpenClaw is personal-only, remains shielded, and
  is not the customer-facing image-generation runtime.
- 2026-08-25 production update: the protected bridge, encrypted snapshot,
  isolated restore proof, `0016_expand` transition and attested runtime deploy
  completed. Every Mollie commercial, live, drain, entitlement, notification,
  finalization and accounting execution flag remains off. Migration 0017
  remains blocked.
- Historical audit and inventory files are not active plans. Keep valid open work here instead of reviving stale audit snapshots.

## Architecture boundary notes

- Root `src/` is the generic OpenClaw Facebook/Messenger plugin surface. Keep it channel-integration oriented and avoid moving Leaderbot image-generation runtime ownership into this layer.
- `apps/image-gen/server/_core` is the Leaderbot image-generation runtime. Keep image-generation behavior, prompt-first orchestration, and runtime primitives owned there rather than in Messenger transport code.
- OpenClaw is personal-only and must not own or persist multi-tenant customer
  conversations. The customer image-generation path must terminate directly in
  `apps/image-gen`, which owns its workspace-scoped state, assets, queues,
  quotas, billing and deletion.
- Leaderbot-specific bridge code that currently lives in `src/monitor.ts` is temporary. It must stay behind an adapter boundary and remain explicitly opt-in (`leaderbotBridgeEnabled`) so ClawHub/private installs do not forward Messenger content to the external image-generation service just because host-level bridge tokens exist.
- Conversation modules must not import Messenger or WhatsApp transport APIs. They should expose channel-neutral conversation responses/actions for renderers to translate into platform-specific controls.
- Every multi-tenant image-gen state, quota, storage and deletion boundary must
  remain explicitly tenant-, workspace- and channel-scoped, with no shared
  customer-content path across tenants.
- The root Facebook gateway now has a root-only `sharedStateStore` boundary.
  `memory` remains the default for one replica; `redis` uses versioned HMAC-only
  account/Page keys and atomically shares webhook deduplication plus the optional
  daily audio-transcription cap without storing message content. Store failures block
  ordinary work and billable forwards, while explicit `delete-my-data` requests
  remain routable. This is not a durable ingress queue: keep one gateway replica
  until acknowledged webhook work is persisted in a tenant-scoped queue/outbox.
- Package tooling has an explicit enforced boundary: npm `>=11.12.1` owns the
  root plugin and deploy orchestration, while all three isolated subapps pin
  pnpm `10.28.1` and own their local lockfiles. A dependency-free CI guard
  rejects mixed subapp lockfiles, stale pnpm pins, root pnpm-workspace drift, and
  root deploy scripts that bypass npm.

## Production release strategy

Leaderbot is already publicly reachable, so release work is gated by live-safety
risk rather than feature ambition. Each gate should be completed as small PRs
with targeted tests and metadata-only observability. Do not expand public access,
Meta permissions, paid provider usage, or customer self-serve features until the
prior gate is proven in production.

### Multi-photo composition - 2026-08-22

- [x] Detect two to four tenant-scoped Messenger photo uploads, retain them as
      one bounded source set, and expose a channel-neutral `combine_photos`
      conversation action that Messenger renders as the `Samenvoegen` pill.
- [x] Ask for a natural-language composition instruction after action
      selection and send each stored source as a distinct GPT Image edit input.
      The photo limits, external provider hard limit, tenant boundaries, private
      logging, retention, and delete-my-data paths remain active.
- [ ] Complete a staged Messenger smoke with two photos in one message and two
      sequential photo messages, then record Android, iOS, and Web evidence before
      production rollout. No additional Meta permission is expected.

### Veilige livegang - 2026-08-23

- [x] Er is één bewaakte route om iets live te zetten. Bij een fout wordt de
      vorige goede versie teruggezet.
- [x] De foto-app en opslag-app aanvaarden alleen een exacte versie die GitHub
      uit goedgekeurde code bouwde en ondertekende.
- [x] Een app uitrollen en de database aanpassen zijn twee aparte stappen. Er
      is geen handmatige binnenweg.
- [ ] Zet de productiebeveiliging, goedkeurders en vier beperkte sleutels in
      GitHub klaar en bewijs de route één keer van begin tot einde.
- [x] Zet de foto-app in kleine stappen live: eerst de veilige tussenversie,
      dan een nieuwe back-up met geslaagde hersteltest, daarna alleen
      database-uitbreiding 0016, en ten slotte de ondertekende nieuwe app.
      De beschermde overgang en offline controle zijn vastgelegd in
      [run 32820475232](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32820475232).
- [x] Databasewijziging 0017 blijft uit. Daar komt pas later een apart plan voor.
- [ ] Bouw en controleer de opslag-app via dezelfde bewaakte route.
- [ ] Houd de gateway uit tot zijn gegevensschijf veilig is gekopieerd en getest.
  - [x] Leg de huidige oude Machine, image, versleutelde volume, mount en regio
        exact vast in `apps.gateway.stateRebaseline`; gebruik
        `legacy_unlabeled` omdat de bestaande release geen deploymentlabel heeft.
  - [x] Laat configuratievingerafdrukken alleen alle drie samen ontbreken en
        blokkeer elke volgende fase tot ze canoniek berekend en beoordeeld zijn.
  - [x] Verbied automatische verwijdering van oude gateway-Machines en volumes,
        ook tijdens voorbereiding, herstel en opvolgercontrole.
  - [ ] Maak een beschermde kopie van het volume en bewijs daarop start,
        tenantisolatie en rollback zonder klantinhoud te lezen of te loggen.
        De oefening mag alleen starten vanuit `rehearsal_approved`; deze
        tussenstap vereist alle drie configuratiehashes en exact beoordeelde
        artefactherkomst, maar bevat nog geen geslaagd oefenbewijs. De huidige
        begrensde workflow bewijst alleen clone-mount, start/herstart met een
        credential-gescrubde production-shaped Facebook-configuratie, lege
        tijdelijke runtime-state, uitgeschakelde transporten, lege config- en
        shell-credentialbronnen, geen cloud-workerprofielen en behoud van de
        live baseline. Ze inspecteert nog niet de geladen plug-in plus `/readyz`.
        Ze laat startgereedheid, tenantisolatie en rollback bewust op `false` en
        claimt zonder egresscontrole niet dat er geen providercalls gebeurden.
  - [ ] Bouw en beoordeel afzonderlijke uitrol- en herstelartefacten uit volledig
        vastgezette bouwinputs; leg beide identiteiten en configuratiehashes vast.
  - [ ] Zet de gateway pas in een latere, apart beoordeelde wijziging op inzetbaar
        nadat de rebaseline `settled` is. Betalings- en quota-enforcement blijven
        tot dan uit.
- [ ] Test na de livegang een gewone foto, een fotobewerking en de teller in
      echte Messenger-gesprekken.

### Messenger processing-consent incident follow-up - 2026-08-22

Multiple real Messenger users reached a repeated processing-consent prompt in
the public image flow. The failure combined temporary quick replies, overly
narrow typed-consent matching, GDPR postbacks being classified as unknown on
the error path, and a pre-redaction debug logger that still received raw text.
Keep this incident metadata-only; do not add names, PSIDs, screenshots, photos,
or raw conversation content to repository notes or logs.

- [x] Replace GDPR consent quick replies with persistent Messenger postback
      button templates while retaining explicit typed consent as a UI fallback.
      Keep destructive deletion confirmations as temporary quick replies.
- [x] Normalize typed consent with bounded typo tolerance, structural
      permission-grant matching, contextual short acknowledgements only for 15
      minutes after a delivered notice, and fail-safe question, refusal, and
      uncertainty handling.
- [x] Register every GDPR consent/deletion postback as a known Messenger payload
      so a handler/send failure remains eligible for the safe fallback instead of
      appearing to hang silently.
- [x] Restrict pre-redaction inbound diagnostics to metadata-only booleans,
      lengths, counts, and normalized media categories; tests prove that raw text,
      captions, payloads, attachment URLs, message ids, referrals, and identifiers
      never reach that logger.
- [x] Cover real Messenger postback event shape, typed-language variation,
      negative and uncertain counterexamples, stale short acknowledgements,
      rejected control delivery, GDPR fallback eligibility, and privacy-safe
      inbound diagnostics in focused tests.
- [x] Preserve explicit consent refusals as distinct from unanswered consent so
      later ordinary messages remain blocked without presenting the controls again.
      Expire destructive deletion confirmation state after 15 minutes, arm it only
      after the warning controls are delivered, consume it before deletion, and
      reject stale Messenger/WhatsApp confirmation payloads without deleting data.
- [ ] Implement no-second-upload photo-first continuation only on the verified
      workspace privacy boundary. It must bind the temporary reference to
      `workspaceId`, `channelConnectionId`, `bindingEpoch`, `userKey`, and
      `privacyEpoch`, serialize consent decisions, retain the reference across
      transient fetch/storage failure, preserve a bounded encrypted caption, and
      revalidate consent plus ownership before image fetch. The Page/sender-only
      prototype was rejected and removed; never deploy it or tell a customer the
      automated flow retained a photo when it did not.
- [ ] Review and merge the hotfix, promote it through the canonical immutable
      image-gen deployment path, and retain the current reviewed digest as the
      explicit rollback image. Repository tests are not production evidence.
- [ ] Complete a privacy-safe production smoke on Android, iOS, and Web for
      fresh text-first and photo-first users, including typed fallback and refusal.
- [ ] Add metadata-only funnel signals for consent prompt, consent acceptance,
      refusal, and repeated-prompt loops; alert on abnormal repetition without
      logging message text, attachment URLs, raw identifiers, or customer content.

### Local launch-hardening tranche - 2026-08-02 (no launch-go)

Completed locally and covered by focused regression tests in the current
worktree; none of these items counts as production rollout proof:

- [x] Scope short-lived gateway prompt/reply memory by Messenger account, Page,
      and sender so identical sender/message identifiers cannot share remembered
      assistant prompts across account/Page boundaries.
- [x] Make `delete-my-data` outcomes truthful: Messenger and WhatsApp now report
      `completed`, `pending`, or `failed`, and send success copy only after all
      required deletion work completed. Incomplete deletion retains safe retry
      context and gives the user retry/support guidance.
- [x] Upgrade the affected image-gen Axios, Sentry, and `express-rate-limit`
      dependencies and make the production-dependency high-severity audit blocking
      in CI. `pnpm audit --prod` reports no known production vulnerabilities in the
      current worktree (zero critical, high, moderate, and low advisories). Keep the
      security overrides in the pnpm-10-supported app-local `pnpm-workspace.yaml` so
      fresh installs enforce the same dependency graph as the lockfile.
- [x] Add an interim opaque Page-partitioned image queue and make partitioned
      enqueue, reserve/lease, completion, retry, and dead-letter transitions atomic
      and idempotent under ambiguous Redis responses. Consumers recompute the Page
      HMAC, stale workers are fenced by random lease tokens, legacy Redis Cluster
      `CROSSSLOT` errors no longer block partitioned work, and the default lease now
      covers every configured OpenAI retry attempt. This is an atomicity milestone,
      not the final workspace tenant boundary.
- [x] Replace raw-PSID request ids with random UUIDs, remove raw Page/message ids
      and error bodies from operational logs, apply redaction to both logger APIs,
      and scrub Sentry exception messages, request data, breadcrumbs, variables,
      and unapproved context before export. Disable Sentry performance tracing until
      transaction/span exports have a tested metadata-only allowlist; error events
      remain enabled behind the scrubber.
- [x] Stop creating the redundant `psid:<hashed-userKey>` Messenger shadow-state
      and make `delete-my-data` remove existing shadow records during the transition.
- [x] Fail closed for both legacy portal-handoff issuance and claim with no
      environment bypass until an immutable Page/channel/workspace authorization
      boundary exists.
- [x] Add the first additive `ConversationSubjectV2` identity foundation:
      strict byte-exact Messenger Page and WhatsApp WABA/`phone_number_id`
      endpoints, a dedicated versioned 256-bit HMAC key, branded opaque tenant,
      binding, and user keys, an exact fail-closed `channelConnections` resolver,
      nullable WABA schema support in migration `0011`, and globally unique
      workspace ownership for non-null WABA IDs in migration `0012`. The
      channel-connection write path now rejects non-canonical Meta IDs, enforces
      the Messenger/WhatsApp endpoint shape, and locks both WhatsApp WABA and phone
      claims. Startup/readiness and CI production type-checking now enforce the
      local foundation. Existing webhook/state/queue paths are deliberately not
      switched to v2 in this tranche.
- [x] Add the next additive, still-unwired V2 boundary primitives: an exact
      allowlisted detached envelope with authenticated payload purpose and bytes,
      current-key-only verification, mandatory physical queue-scope verification,
      authoritative binding re-derivation, safe stale/reassigned/inactive/
      ambiguous quarantine codes, and a branded connected-delivery gate. Add a
      V2-only replay claim with a binding-scoped opaque Redis key, dedicated-key
      HMAC framing, strict Meta-ID/fallback identities, a stable authenticated
      per-unit claim id, a fresh random owner token for every short `processing`
      lease attempt, and an atomic owner-specific `completed` transition. Ambiguous/
      busy outcomes remain retryable, Redis readiness is strict, and there is no
      process-memory or V1 fallback. Only an explicit `completed` state is treated
      as a duplicate. These primitives do not change live webhook behavior yet.
- [x] Add the additive, still-unwired persisted V2 Meta ingress-unit contract:
      mint a private runtime brand only after exact raw-body HMAC verification, bind
      its signature-provider claim to the payload root, strictly cap every provider
      array, split a verified delivery into deterministic per-event order,
      retain only allowlisted canonical payload fields, and reject the whole batch
      before identity resolution on an invalid event. Conversation events with no
      stable provider ID or timestamp deliberately fail closed so replay identity
      remains stable. Messenger echo/delivery/read/referral and WhatsApp status-only
      notifications remain metadata-only and do not mint a conversation subject.
      The unit HMAC binds the exact payload digest, stable replay claim id, complete
      detached boundary, and key epoch. Queue verification authenticates the unit
      before decoding, derives endpoint/sender only from those authenticated bytes,
      re-resolves the current binding, and requires the external physical tenant/
      binding scope. It mints a separate non-forgeable queued capability; replay
      rejects a generic verified boundary that never saw physical scope. Tamper,
      transplant, reassignment, multi-entry, canonical-byte, provider-mismatch, and
      stale-worker fencing tests are included. No route or queue uses this contract
      yet.

Still open before broad customer launch or paid activation:

- [ ] Wire the new `ConversationSubjectV2` foundation before multi-tenant
      traffic: require and compare both Messenger outer `entry.id` and inner
      `recipient.id`, preserve WhatsApp outer WABA plus
      `metadata.phone_number_id`, then resolve exactly one
      `channelConnection` and workspace before any state/quota/consent/replay read.
      Missing, duplicate, changed, inactive, or unavailable mappings must fail
      closed; free versus paid entitlement is policy after identity resolution,
      never an identity fallback.
- [ ] Connect the unforgeable V2 raw-body verifier at the live signature seam and
      select its Messenger or WhatsApp secret from an authenticated route contract,
      not by trusting payload fields. Both the generic and WhatsApp-specific webhook
      paths must reject a signature-provider/payload-root mismatch. Seal the complete
      delivery before any queue write, then persist each unit only in its external
      tenant/binding partition. A consumer must receive that physical scope from an
      independently authenticated queue/lease context and verify it before replay,
      state, provider, or delivery access. Multi-unit persistence across tenant
      partitions must be atomic and idempotent, or use a durable resumable manifest;
      a partial enqueue must never be acknowledged as a completed delivery.
- [ ] Add an authoritative binding lifecycle epoch or durable cancellation/
      deletion tombstone before enabling queued V2 content. The current
      `(workspaceId, channel)` row is reused, so disconnecting and reconnecting the
      identical endpoint can recreate the same subject and otherwise resurrect old
      authenticated work. Cover the chosen epoch/tombstone in queue verification
      and test disconnect -> same-row reconnect explicitly.
- [ ] Activate the implemented V2 replay claim only after every ingress producer
      and worker consumes a verified V2 unit under one deployment-wide key epoch.
      Do not dual-write, read V1 on a V2 miss, or run mixed V1/V2 processors; drain
      old ingress first so a Meta redelivery cannot execute once in each namespace.
      Claim replay immediately before one durable, tenant-scoped, idempotent event-
      job enqueue; mark it `completed` only after that enqueue succeeds and before
      webhook ACK. Propagate `claim_busy`, store-unavailable, and lost-lease outcomes
      as retry/requeue rather than catch-and-ack. Never persist or reuse the fresh
      per-attempt owner token, and do not put slow provider work inside the current
      30-second lease. Validate the completed TTL against Meta's retry horizon and
      prove the Lua CAS/ACL/expiry behavior against production-like Redis or Redis
      Cluster before enabling traffic.
- [ ] Replace live Redis `psid:<raw sender>` state with workspace/channel-bound
      v2 state, locks, quota, completions, cost history, chat history, consent, face
      memory, and deletion keys. The legacy data has no Page/WABA owner and therefore
      requires an offline, backed-up, resumable one-owner migration; do not add a
      runtime v2-miss-to-v1 fallback. Remove the global in-memory alias scan and dead
      SQL `messengerState` shadow only after migration evidence and retention review.
- [ ] Replace the global webhook ingress queue before multi-tenant traffic. It
      currently persists complete Facebook/WhatsApp payloads, including customer
      content and identifiers, in shared queued/processing/dead-letter lists without
      a tenant partition, retention TTL, or bounded cap. Split multi-entry payloads
      by resolved workspace before enqueue and make deletion/cancellation explicit.
- [ ] Finish the image queue's final workspace boundary. Page-HMAC partitioning
      now protects mechanics, but Page identity alone does not prevent a queued job
      from crossing policy after Page reassignment. The v2 envelope must bind and
      revalidate workspace, channel connection, Page binding, and subject before
      state/provider/delivery; delete-my-data must tombstone/cancel queued work and
      suppress late processing/output. Add a durable, idempotent dead-letter
      notification/outbox so a double-lost Redis reply cannot strand the user in
      `PROCESSING`; add bounded dead-letter retention/caps and fail readiness while
      unmigrated legacy Cluster jobs remain. Prove the Lua scripts against real
      Redis/Redis Cluster, not only the deterministic test fake.
- [ ] P2: Bound completion/object inventory growth for customers active over many
      years. A sliding TTL can keep old members alive; later move inventory to fixed
      time windows or a scored sorted set with explicit age-based cleanup. This is
      not a release blocker.
- [ ] Scope or remove the remaining globally stable log hashes (`user` and
      `psidHash`) once the workspace binding exists; per-request UUID correlation is
      now available and replay logs no longer expose a stable event hash.
- [ ] Replace the unsafe legacy Messenger-to-portal handoff boundary before
      onboarding customers through it. The 2026-08-02 local containment disables
      both token issuance and claim with a non-configurable fail-closed gate because
      the current admin call can pair any workspace with a global sender hash. A
      safe replacement must derive the workspace from an immutable receiving-Page
      / `channelConnections` binding, revalidate that binding atomically on claim,
      use authenticated non-forgeable operator attribution, and refuse ambiguous,
      disconnected, legacy-unbound, or cross-workspace mappings. Existing tokens
      must remain unclaimable and be allowed to expire or be explicitly revoked.
- [ ] Before deploying the partitioned queue, configure one stable
      `MESSENGER_GENERATION_PARTITION_SECRET` across gateway and workers, prove the
      unique Page-to-workspace ownership invariant, and drain/review existing
      global legacy and dead-letter jobs before multi-tenant onboarding.
      Before switching to Page-scoped Messenger state, pause new Messenger ingress;
      verify queued, processing, and reserved generation counts are zero; and review
      the dead-letter queue. From an authoritative channel inventory, build a
      resumable offline migration manifest that maps every proven legacy Messenger
      PSID state to exactly one receiving Page, preserves consent, response-window,
      quota/reservation, face-memory, and pending-deletion fields, and writes the
      full record to its Page+PSID key. After verifying the copy, purge its proven
      legacy Messenger raw-PSID record and retain auditable evidence that no
      identified Messenger record remains unmigrated or undeleted. Preserve
      non-Messenger records; move them only through a separately verified
      channel-scoping migration. Runtime `delete-my-data` must not guess that an
      unmarked raw-PSID record belongs to Messenger because the old keyspace is
      shared by non-Messenger callers. Abort on missing or ambiguous Page ownership:
      runtime code never falls back to an unowned PSID record.
      Deploy gateway and workers as one rollout only after that evidence, then
      resume ingress.
- [ ] Before deploying this identity foundation, provision the same immutable
      `CONVERSATION_SCOPE_HMAC_KEY_ID` and 256-bit
      `CONVERSATION_SCOPE_HMAC_SECRET` version on every app and worker process,
      back up the database, apply and verify migrations `0011` and `0012`, and
      inventory existing Page/WhatsApp identifiers for the strict decimal
      canonical form and duplicate WABA ownership. Abort rather than normalizing
      ambiguous data. Do not derive or backfill WABA ownership from environment
      variables. Prove the unique Page, phone, and WABA claims under concurrent
      writes against real MySQL before activation.
- [ ] Add deployment-wide identity-key epoch consensus and schema readiness.
      Local syntax readiness cannot detect two nodes using the same key ID with
      different secret material or a database missing migrations. Rotation must
      use an immutable secret-manager version, an offline resumable migration
      manifest, deletion-completeness checks, and zero-old-record evidence; never
      add runtime try-all-key or v2-to-v1 fallback behavior.
- [ ] Clear the existing image-gen server ESLint baseline (37 errors outside
      this tranche, including unsafe-value and unused-code findings) and add the
      server lint command to CI once green. The production files changed in this
      tranche pass targeted ESLint, but the repository-wide server gate is not yet
      clean.
- [ ] Configure and verify production OAuth, explicit spend caps, and the
      intended entitlement/billing feature flags. Paid/live billing stays fail-closed.
- [ ] Rehearse, back up, run, and verify required live database/state migrations,
      including the Page-ownership preflight and the blocked OpenClaw Memory Core
      state repair, with an approved rollback path.
- [ ] After deployment, run and record production route/security, portal login,
      workspace isolation, Messenger, `delete-my-data`, quota/budget, queue, and
      rollback smokes. Until that evidence exists, broad customer launch remains
      **NO-GO** and Mollie live billing remains **NO-GO**.

## Finish cut - 2026-06-30

The controlled Messenger/image-generation launch is effectively through Gate 1:
live Messenger smoke, source-photo delivery, storage-proxy delivery, and
`delete-my-data` have been operator-verified.

The remaining work is not "build the product"; it is release closure. Broad
customer launch is allowed when these checks are true:

1. `leaderbot.live` resolves to the customer portal and passes:
   `pnpm --dir apps/image-gen deploy:verify-portal`.
   Portal v1 scope is defined in `docs/leaderbot-portal.md`; do not expand it
   during launch closure.
2. Public route audit is recorded: portal root, legal pages, health/readiness,
   metrics, and required Meta webhook routes are reachable; internal gateway UI,
   admin APIs, and unreviewed OpenClaw routes are not publicly reachable.
3. Mollie is the only payment provider. Its local Test Mode implementation is
   present, but live billing remains NO-GO until `docs/LAUNCH_READINESS.md` and
   every scenario in `docs/MOLLIE_TEST_RESULTS.md` are complete. Manual upgrade
   requests remain the production fallback until then.
4. Owner monitoring is good enough for launch when `/admin/cost-dashboard` or
   `/admin/cost-summary` shows spend, quota blocks, provider failures, queue
   health, duplicate skips, and delivery failures without raw identifiers,
   prompts, tokens, source media, generated images, or customer messages.
5. Tenant-isolation audit is recorded for portal data, knowledge, channel
   identifiers, generated assets, deletion/export paths, billing metadata, logs,
   support access, and break-glass behavior. Existing tenant-isolation tests must
   pass before this is signed off.

Explicitly defer these unless they become necessary for the launch decision:

- exactly-once Messenger outbox semantics
- channel-neutral usage-ledger consolidation
- image gallery/history
- generated-video support
- live premium subscription activation before the Mollie launch gate passes
- removing remaining internal style-preset backend compatibility

### Gate 1: immediate stabilization

Goal: keep the live Messenger bot reliable, bounded, and reversible while it is
reachable by real users.

Required before any broader traffic, marketing, or customer onboarding:

1. [x] Preserve Meta webhook verification, POST signature validation, request-size limits, fast ACK behavior, and Messenger response-window compatibility.
2. [x] Keep the OpenClaw public gateway shielded: expose only required webhook/health routes and deny built-in high-cost `image_generate` on the gateway.
3. [x] Count Messenger images only after a usable result is durably recorded;
       keep audio/video tied to provider attempts. Retryable failures consume no
       Messenger photo, and a replayed successful job counts once.
4. [x] Keep Redis-backed webhook ingress, generation queue dedupe, worker lease/reclaim behavior, and queue metrics enabled for production image-generation traffic.
5. [x] Keep privacy-safe logging defaults: hashed/pseudonymous sender identifiers, redacted errors, and no raw PSIDs, tokens, customer messages, uploaded knowledge, or generated prompts/outputs in logs.
6. [x] Keep face memory disabled by default and retain the protected emergency disable route for rollback.
7. [x] Maintain the documented Fly rollback workflow and non-destructive workspace migration behavior.
8. [x] Run and record a live Messenger smoke after each production deploy: webhook verification, signed POST delivery, text reply, prompt-first text-to-image, source-photo edit, quota-exhausted path, and Graph API send failure handling. Operator-verified on 2026-06-30.
9. [x] Verify GDPR consent and `delete-my-data` behavior end-to-end with live or production-equivalent state, including generated assets, retained source images, face-memory state, and tenant/customer portal records. Operator-verified on 2026-06-30.
10. [x] Add a release checklist entry that confirms `/healthz`, `/readyz`, `/metrics`, queue depth, failed/dead-lettered jobs, and event-loop p95/p99 before and after deploy.

Exit criteria: live smoke passes, deletion proof is recorded, no public route
regression is found, cost/quota metrics are visible, and rollback target is known
before deployment.

### Gate 2: public hardening

Goal: make the public bot safe for sustained usage beyond controlled smoke.

Required before enabling open `dmPolicy`, public promotion, or broader free-tier
access:

1. [x] Track image provider attempts and outcomes without calculating an image price.
2. [x] Bound expensive paths before provider calls. Messenger images use the
       customer day/month photo quota plus provider concurrency and the external
       OpenAI hard limit; audio/video retain spend gates; Facebook-host tools remain
       default-deny.
3. [x] Add default-deny tool policy for all high-cost tools exposed to untrusted Facebook-originated users.
4. [x] Add per-user/global spend caps for priced audio/video. Image admission is
       deliberately count-based per customer and never decided by an internal price
       estimate.
5. [x] Write provider attempts to a pseudonymous ledger. Images record attempt
       status and safe request metadata only; optional audio/video controls may
       record their configured estimates.
6. [x] Add richer provider usage dimensions to cost-ledger entries where providers expose safe metadata.
7. [x] Add owner cost alerts and an owner dashboard for spend, quota blocks, duplicate skips, provider failures, queue health, and delivery failures. Admin-only aggregate cost monitoring exists at `/admin/cost-summary` and `/admin/cost-dashboard`; richer failure drilldown UX is deferred.
8. [x] Continue verifying storage-proxy delivery under Messenger crawler constraints, including generated outputs and retained source images. Operator-verified on 2026-06-30 with tester photo forwards through Messenger.
9. [ ] Deferred: evaluate stronger queue/outbox semantics if exactly-once Messenger image sends become mandatory.
10. [x] Keep public legal pages current (`/privacy`, `/terms`, `/data-deletion`) and aligned with Meta App Review, face-memory status, retention, and deletion behavior. Current image-gen runtime legal pages include tested privacy, terms, and data-deletion routes; future portal relocation remains a Gate 3 task.
11. [x] Document Meta App Review impact for each new Messenger capability and avoid permission expansion unless product/policy approval is explicit. Current review notes live in `docs/operations/meta-app-review.md`; keep them updated for future Messenger capability changes.

Exit criteria: all paid/provider calls are bounded and ledgered, public legal
copy matches behavior, owner monitoring can detect cost/reliability regressions,
and Meta review/demo notes are reproducible.

### Gate 3: customer-platform expansion

Goal: turn `leaderbot.live` into a tenant-owned customer platform without
exposing internal gateway controls or cross-tenant data.

Required before broad customer launch:

1. [x] Design the `leaderbot.live` tenant/customer portal as a real app, not a brochure site.
2. [x] Define the tenant model for customer workspace, owned AI identity, channel connections, knowledge, usage, billing, and privacy controls.
3. [x] Add portal authentication.
4. [x] Add the local Mollie Test Mode billing foundation, while keeping live billing fail-closed behind an explicit launch switch.
5. [x] Move public legal routes (`/privacy`, `/terms`, `/data-deletion`) into the portal surface before pointing customer traffic there. React portal pages and local footer links exist; production routing verification remains part of the public route audit.
6. [ ] Keep the internal OpenClaw gateway unavailable as a public UI/API; expose only required webhook/health/legal/customer-app surfaces.
7. [ ] Move remaining feature-specific quota counters toward a single channel-neutral, tenant/workspace-scoped usage ledger before paid rollout. Deferred unless paid rollout starts.
8. [ ] Verify tenant isolation across uploaded knowledge, extracted text, embeddings/retrieval artifacts, assistant memory, conversations, channel identifiers, generated prompts/outputs, billing, logs, support access, export, and deletion paths.
9. [x] Provide customer-facing bot instructions, current generic prompt behavior copy, privacy controls, and export/deletion instructions.
10. [x] Keep legacy style-picker/campaign assets removed and do not reintroduce style catalogs unless explicitly requested.
11. [ ] Add secure Messenger-to-portal customer handoff after manual approval/payment, using a short-lived single-use link that opens the customer's workspace setup with minimal friction and without exposing raw PSIDs or customer content.

Exit criteria: customer data is tenant-scoped by design, support/break-glass access
is explicit and auditable, customer billing/privacy controls exist, and public
traffic cannot reach internal gateway admin/API surfaces.

## Actieve backlog (open)

### Architectuur

- [x] Centraliseer Redis client management
- [x] Maak Face Memory retentie configureerbaar via ENV
- [x] Verplaats Admin Rate Limiting van memory naar Redis
- [x] Consolideer operationele logging naar `safeLog` / gestructureerde logger

### Product & bot-ervaring

- [x] Design the `leaderbot.live` tenant/customer portal as a real app, not a brochure site
- [x] Define tenant model: customer workspace, owned AI identity, channel connections, knowledge, usage, and privacy controls
- [x] Add tenant model foundation: knowledge sources + privacy controls persistence and portal snapshot exposure
- [x] Add tenant-checked customer portal API for knowledge source registration and listing
- [x] Add customer-facing knowledge source registration and status list to the portal dashboard
- [x] Add tenant-checked customer control to disable knowledge sources
- [x] Scaffold customer-facing Tauri portal app with tenant-scoped portal API surfaces
- [x] Replace the marketing-style home screen with an authenticated customer portal dashboard and customer-editable AI identity/instructions
- [x] Add tenant-checked workspace name management in the customer portal
- [x] Add tenant-checked workspace member visibility in the customer portal
- [x] Add initial Facebook Page Connect authorization entrypoint for customer workspaces
- [x] Add customer-facing Facebook Page Connect completion and Page selection controls
- [x] Add tested REST portal auth guard for snapshot and customer-owned mutations
- [x] Add tenant-scoped portal export/deletion request tracking for customer data controls
- [x] Add customer-visible data request status summary and outage-safe request loading
- [x] Add initial customer-facing free-plan usage balance and upgrade prompt to the portal dashboard
- [x] Add portal-rendered privacy, terms, and data-deletion pages with local footer links
- [x] Add customer-facing bot instructions for prompt-first image use, workspace context, and data controls
- [x] Transitional gateway behavior: keep ordinary Messenger conversations on
      the OpenClaw turn instead of falling back to image-generation help copy.
      This does not satisfy or define the direct multi-tenant customer route.
- [x] Add tenant-checked Messenger disconnect control that clears stored page token data
- [x] Add portal authentication before broad customer launch
- [x] Enforce Facebook Login-only customer portal sessions
- [x] Create or load a persisted customer workspace during Facebook Login before issuing the portal session
- [x] Add tenant-checked portal auth session metadata for customer workspace membership
- [x] Add tenant isolation tests before broad customer launch
- [x] Add portal audit logging before broad customer launch
- [x] Add tenant-checked portal upgrade request control with privacy-safe billing audit metadata
- [x] Add tenant-scoped portal upgrade request tracking and customer-visible request status history
- [x] Add production readiness guard for the customer portal database configuration
- [x] Document the production customer portal database secret, migration, readiness, and smoke-test rollout order
- [x] Add a production portal verifier for DATABASE_URL readiness and public endpoint checks
- [x] Load non-secret OAuth browser configuration from the running portal so Fly runtime values, rather than unavailable Docker build secrets, control whether Facebook Login is shown.
- [x] Add launch billing and usage controls before broad customer launch. Current launch mode is manual upgrade requests with customer-visible free-plan usage; paid subscriptions are deferred.
- [ ] Add zero-friction Messenger-to-portal handoff for approved customers before relying on the portal for onboarding
  - Messenger presence alone is not portal authentication.
  - [x] Add a customer-facing `/handoff/:token` portal route that stores the handoff locally through Facebook Login and claim it only after the receiving-Page boundary below is revalidated.
  - [x] Contain the unsafe legacy handoff locally by failing closed for both issuance and claim with no environment override. Keep it disabled in production until the Page/workspace boundary below is implemented and all pre-fix tokens have expired or been revoked.
  - [x] Bind issuance and claim to one immutable receiving Page, `channelConnection`, and workspace; revalidate that binding atomically before granting membership and fail closed for missing, duplicate, disconnected, changed, legacy-unbound, or cross-workspace mappings.
  - [ ] Attribute recovery to an authenticated, non-forgeable operator/support principal and require an explicit customer-approved workflow. The protected recovery sender no longer accepts caller-supplied `createdByUserId`; until principal attribution exists, use its redacted delivery logs and the billing outbox record for audit evidence.
  - [ ] Re-enable the operator-only sender only after the tenant boundary is proven; the existing short-lived-token and response-window mechanics may be reused behind that boundary.
  - [x] Allow `/handoff` portal pages through the guarded public gateway and redact `/handoff/:token` from HTTP logs and metrics.
  - [x] Wire paid Mollie webhook completion to the same handoff sender after the billing and tenant-runtime launch gates pass.
        Delivery is deliberately separate from payment truth: a closed response
        window, stale sender state, changed Page binding, or exhausted bounded send
        retry records a failed `send_portal_handoff` outbox item without creating a
        second payment. Automated outbox retries reuse the same idempotent delivery
        identity; terminal response-window or Page-binding failures remain auditable
        through the outbox record and redacted delivery logs, without recharge.
        Human recovery is unavailable: the protected admin sender is deliberately
        fail-closed until recovery is bound to the failed outbox operation and an
        authenticated, non-forgeable support principal. Never copy a raw token into
        support tooling.
  - Storage boundary: `portalHandoffTokens` rows are scoped to one `workspaceId`; the opaque token is never stored, only its hash is persisted, and Messenger identity may be stored only as the privacy-peppered `messengerSenderUserKey`.
  - Deletion boundary: `delete-my-data` must delete handoff rows for the erased Messenger `userKey`, including pending and consumed links.
  - Consumption boundary: only the portal handoff route may consume a pending, unexpired token and convert it into that workspace's onboarding/session flow.
  - Do not put raw PSIDs, tokens, message text, or tenant content in links/logs.
  - Request Facebook Login/Meta OAuth only when needed for persistent account access or Page connection permissions.
- [ ] Deploy and verify the `leaderbot.live` customer portal in production.
  - `leaderbot.live` must route to the tenant/customer portal, not the old gateway or brochure surface.
  - Production auth/session/env config must allow a customer to sign in and load their own workspace.
  - Production portal smoke must cover workspace details, AI identity/instructions, Messenger status/connect controls, usage, privacy controls, and export/deletion request status.
  - Public production surface must expose only the customer portal, legal pages, health/readiness/metrics as intended, and required webhook routes; internal gateway/admin APIs must remain shielded.
- [x] Verify GDPR deletion end-to-end before broad customer launch. Operator-verified on 2026-06-30.
- [ ] Keep the internal OpenClaw gateway unavailable as a public UI/API; expose only required webhook/health/legal/customer-app surfaces
  - 2026-08-26 target route audit: the Fly public route guard exposes only
    `/healthz` to the personal OpenClaw gateway by default. Both
    `/facebook/webhook` and the legacy `/messenger/webhook` must return `404`;
    the canonical multi-tenant Page callback belongs to image-gen. When
    stale `LEADERBOT_PORTAL_ORIGIN`, `OPENCLAW_PUBLIC_PORTAL_ORIGIN`, guard or
    path-allowlist values cannot restore portal, Mollie or Facebook routing.
    Customer portal, legal, OAuth, billing and webhook endpoints terminate
    directly in image-gen. Gateway UI/debug routes remain admin-gated and
    production route verification remains open.
- [x] Move public legal routes (`/privacy`, `/terms`, `/data-deletion`) into the portal surface before pointing customer traffic there. React portal pages and local footer links exist; production route verification remains part of the public route audit.
- [x] Remove legacy campaign/style assets that do not support the portal direction
- [ ] Deferred: observe generic text-to-image quality before removing remaining internal style-preset backend compatibility
- [x] Create "upgrade to premium" prompt when limit reached
- [ ] Deferred: add image gallery/history for users
- [ ] Deferred: plan Messenger generated-video support before implementation
  - Uploaded Messenger videos remain unsupported input.
  - Generated video is future output only, behind a feature flag.
  - Future video provider calls must reserve quota before any paid external request, commit on usable success, and release or expire on failure.
  - See `docs/operations/messenger-video-support-spike.md`.

### Kosten & quota

Validated controls:

1. [x] Messenger quota checks run before generation.
2. [x] Database-backed daily quota tables/helpers (`dailyQuota`) are available.
3. [x] Duplicate Messenger generation queue enqueues are deduped by request id.
4. [x] Production queue metrics expose queued, processing, failed, global-slot, Redis-backed, and scrape-error state.
5. [x] Public OpenClaw gateway denies the built-in `image_generate` tool; Messenger image generation routes through the separate image-gen service.
6. [x] Retire the global image-count and estimated-price admission gates; customer daily/monthly photo quotas own image admission, while the cost ledger remains metadata-only observability.
7. [x] Messenger photo quota reserves before generation and commits only after a
       usable result is durably recorded. Failures consume zero; retries of the same
       successful request count once. WhatsApp retains its existing provider-attempt
       quota until its channel flow is migrated separately.
8. [x] Messenger generated-video and audio-transcription quota also commits when provider attempts start, closing the same retry leak for newer paid features.
9. [x] Shared bot text rate limiting is configurable via `BOT_TEXT_RATE_LIMIT_MAX` and `BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS` instead of hardcoded limits.
10. [x] New bot features have a reusable feature-scoped limiter helper and generic `FEATURE_RATE_LIMIT_<FEATURE>_*` env convention.
11. [x] Free-tier product targets: Messenger gets `5` successful photos per
        Brussels day and `20` per Brussels month; bot text gets `30` messages per
        `60` seconds; audio gets `5` attempts per UTC day; video gets `1` attempt per
        UTC day.
12. [x] Admin-only `/admin/cost-summary` exposes owner-safe aggregate cost ledger summaries without raw PSIDs, prompts, tokens, or customer content.
13. [x] OpenAI image, audio transcription, and generated-video provider attempts append metadata-only ledger entries before external provider calls; images do not calculate or store a price.
14. [x] Optional global daily Messenger provider spend cap (`MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD`) continues to protect priced audio/video attempts; image admission uses photo quotas instead.
15. [x] Optional per-user daily Messenger provider spend cap (`MESSENGER_USER_DAILY_SPEND_CAP_USD`) continues to protect priced audio/video attempts per `userKey`.
16. [x] Root Facebook gateway stamps untrusted inbound turns with a default-deny `tools.deny` policy for high-cost, runtime, and filesystem tools.
17. [x] Cost ledger summaries roll up provider-attempt cost metadata per request using hashed request keys instead of raw Messenger message IDs.
18. [x] Optional global monthly Messenger provider spend cap (`MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD`) blocks audio/video provider attempts before external calls and is exposed in metrics; it does not gate images.
19. [x] `delete-my-data` erasure removes the erased user's cost-ledger entries and deletion failure logs use pseudonymous `user` metadata instead of raw PSIDs.
20. [x] Image, audio transcription, and generated-video ledger entries are reconciled from `provider_attempt_started` to success/failure status. Image price fields remain empty.
21. [x] Admin cost summaries expose owner-safe open, failed, blocked, and per-status provider-attempt counts for monitoring regressions without raw PSIDs or prompts.
22. [x] Optional owner cost alerts (`MESSENGER_OWNER_COST_ALERTS=1`) notify on remaining audio/video spend-cap blocks with metadata-only budget details.
23. [x] Retire the root-gateway daily image-forward cap so one customer's use can never block another customer before tenant-scoped image quota runs.
24. [x] Optional root-gateway daily audio transcription cap (`MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP`) blocks Facebook voice attachment transcription before media download or model transcription.
25. [x] Historical bridge hardening: retire the root-gateway daily Leaderbot event-forward cap so unknown senders' first photos and interactive image actions reached tenant-scoped Leaderbot controls. The 2026-08-26 target cutover supersedes this path: the personal OpenClaw gateway is pairing-only, its bridge is disabled, and multi-tenant actions terminate directly in image-gen.
26. [x] Optional audio transcription cost estimate (`OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD`) feeds spend-cap checks and reconciles successful audio ledger attempts with final cost.
27. [x] Optional video generation cost estimate (`OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD`) feeds spend-cap checks and reconciles successful video ledger attempts with final cost.
28. [x] Exact `MESSENGER_ADMIN_IDS` owner accounts retain the existing customer-quota/entitlement behavior; all image attempts remain auditable by count and outcome without image-price calculations.

Open cost-control work:

1. [x] Implement per-image provider-attempt and outcome tracking without image prices.
2. [x] Keep expensive paths bounded: image generation uses customer photo quotas and the external OpenAI hard limit, while audio/video keep their provider spend gates and Facebook-host tools remain default-deny.
3. [x] Add default-deny tool policy for all high-cost tools exposed to untrusted Facebook-originated users.
4. [x] Add per-user daily spend caps for paired Facebook users.
5. [x] Add global Facebook daily spend cap.
6. [x] Write provider calls to a pseudonymous ledger. Image attempts record no estimated or final price; optionally-priced audio/video attempts keep their existing controls.
7. [x] Add richer provider usage dimensions to cost-ledger entries where providers expose safe metadata.
8. [x] Add owner dashboard for Facebook spend by day/month, account/page, `userKey`, blocked attempts, duplicate skips, and provider failures. The admin-only cost summary route includes stored spend plus open/failed/blocked/status counts and Messenger generation queue health; `/admin/cost-dashboard` renders an aggregate owner view with duplicate-skip and delivery-failure counts without raw identifiers or prompt content. Richer drilldowns are deferred.
9. [x] Add a user-facing usage overview before paid rollout. The image balance, rate-limit context, blocked count, and upgrade prompt are visible in the customer portal; paid subscription billing is deferred.
10. [x] Add monthly cost cap enforcement.
11. [x] Send cost alerts to owner for spend-cap blocks.
12. [x] Add external uptime monitor for `/healthz`.
13. [x] Add a dedicated generated-video quota namespace before enabling any video provider call.
14. [ ] Deferred: move remaining feature-specific quota counters toward a single channel-neutral usage ledger before paid rollout.

### Cost Ledger Reliability Hardening (Phase 2)

- [x] P1 | owner: image-gen-runtime | Handle cost-ledger per-period overflow explicitly. Emit structured warnings + metric and report dropped-entry count when cap truncation occurs.
- [x] P1 | owner: image-gen-runtime | Make cost-ledger append/update writes resilient under same-period concurrent updates using single-writer or safe retry semantics.
- [x] P2 | owner: image-gen-runtime | Make provider-attempt updates period-safe across midnight retries by reconciling by entry identity rather than current-period-only assumptions.
- [x] P2 | owner: image-gen-runtime, storage-platform | Keep cost-ledger
      retention and deletion exact: each UTC bucket expires at its original fixed
      day-end + 90-day boundary, updates never extend it, and delete-my-data scans
      all 91 possibly live day buckets while skipping locks without matching data.

Historical branch review note:

- [x] Reviewed stale branch `chore/image-gen-cost-ledger` on 2026-06-23. Do not merge or revive it wholesale: it predates the current portal/privacy work and would remove newer customer-portal, privacy-request, and OpenClaw login changes. Useful ideas from that branch are already represented on `main`: Redis legacy ledger compatibility, deletion retry safety, admin summaries, Facebook inbound tool-policy config merging, and delete-data attachment forwarding.

### Fototeller-fout - 2026-08-23

- [x] Mensen delen niet langer één fototeller.
- [x] Elke persoon krijgt maximaal 5 geslaagde foto's per dag en 20 per maand.
- [x] Een mislukte foto telt niet. Dezelfde opdracht telt nooit dubbel.
- [x] Na een foto ziet de persoon hoeveel er vandaag en deze maand nog over is.
- [x] Een gewone fout zegt niet meer ten onrechte dat het maandbudget op is.
- [x] De app raadt geen fotoprijzen meer. De aparte harde OpenAI-maandgrens van
      €10 blijft de laatste noodrem.
- [x] Automatische tests controleren de teller, aparte klanten, wissen en
      opnieuw proberen.
- [ ] De laatste bevestiging gebeurt met echte Messenger-foto's na de veilige
      livegang.

### Opslag & platform

- [x] Use durable storage proxy for generated images and retained source images
- [x] Continue verifying storage-proxy delivery under Messenger crawler constraints. Operator-verified on 2026-06-30 with tester photo forwards through Messenger.
- [x] Run dedicated Messenger image-generation worker in production with Redis-backed queue enabled
- [ ] Replace the exact legacy storage-proxy bootstrap image with a trusted,
      attested runtime. Until that reviewed rollout, the scheduled monitor may
      prove only `/healthz`; the manifest-bound gate must require public
      `/readyz` with `rateLimiter: "shared_redis"` immediately afterwards.
- [ ] Deferred: evaluate stronger queue/outbox semantics if exactly-once Messenger image sends become mandatory

### Startpilot billing (Mollie Test Mode foundation; live NO-GO)

- [x] Add workspace-scoped Mollie billing schema, classic payment webhook, one-time Startpilot checkout, dormant subscription provisioning, entitlement records, portal controls, and daily reconciliation.
- [x] Keep live Mollie billing disabled by default and reject key/mode or insecure URL mismatches.
- [x] Split commercial exposure from the retained provider drain:
      `MOLLIE_BILLING_ENABLED=false` blocks new plans/provider creates/checkout
      URLs, while `MOLLIE_BILLING_DRAIN_ENABLED=true` preserves classic
      webhook, history/export, reconciliation and safety outbox after the first
      exposure. Boot/readiness refuses drain-off when durable provider activity
      exists.
- [x] Separate provider-silent offline readiness from operational paid workers:
      `MOLLIE_BILLING_PREFLIGHT_ENABLED=true` now requires every billing,
      entitlement, finalization, notification and accounting execution flag to
      remain off, skips runtime-heartbeat gates and labels `/readyz` as
      `phase: "offline"`.
- [x] After the canonical production migration and protected rollout, capture a
      redacted green `phase: "offline"` `/readyz` response before enabling any
      operational paid lane or starting a Mollie sandbox checkout. Protected
      deploy [run 32820475232](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/32820475232)
      recorded this without a Mollie API call.
- [ ] Deploy the first operational safety phase with only the retained billing
      drain and key-free notification plane enabled. Keep commercial checkout,
      entitlement admission and AI finalization off until the exact pilot
      scheduler is enabled through its audited epoch transition; a disabled
      tenant intentionally has only its safety outbox lane enabled.
- [x] Validate the effective portal handoff origin (`PORTAL_BASE_URL`, falling back to `APP_BASE_URL`) before billing readiness/checkout; production/live requires HTTPS and an origin-only URL.
- [x] Select the bounded launch offer: `€19` once, 30 days, one workspace/Page, guided Messenger image controls, 20 Images 2.0 generations, and at most five images per day, without renewal, top-ups, or overage. OpenClaw answers remain dormant and are not advertised or required for the Mollie pilot.
- [x] Enforce an audited, expiring Belgian-consumer billing profile before
      checkout. Seller Peppol registration is separate; business/Peppol buyer
      profiles remain ineligible.
- [ ] Approve the draft Startpilot legal copy, accounting treatment, refund/withdrawal terms, invoice treatment, and financial-retention policy before live payment.
- [ ] Run and record all Mollie sandbox cases in `docs/MOLLIE_TEST_RESULTS.md`.
- [x] Add real-MySQL concurrency/integrity tests for intents, webhooks, ledger,
      outbox, provider-operation/disable races and duplicate subscription
      prevention. PR #400 CI also runs the privacy/billing MySQL lane on 8.4.11.
- [ ] Before paid Images 2.0 activation, smoke-test direct GPT Image 2 generation and editing, verify the fixed 5/day and 20/month customer counters, and separately confirm the provider-account hard limit.
- [x] Keep the optional audio/video USD spend caps atomic across workers. Image admission never uses these caps.
- [x] Add a durable, tenant-scoped finalize drain for AI-answer reservations so
      an ambiguous gateway-to-image-gen outage cannot silently release a
      delivered answer.
- [x] Partition and privacy-fence the Redis image-generation queue by immutable
      workspace/connection/binding/user/epoch scope. Real Redis tests cover
      retries, lease loss, erasure races and legacy drain.
- [ ] Define a separate immutable subscription-history/event model if historical rows become a product or accounting requirement; `billing_subscriptions` currently stores one mutable current-state row per workspace and Mollie mode.
- [x] Map inbound channel/Page identity uniquely to a workspace and enforce `workspace_entitlements` before the actual image-provider attempt; the database claim now fails closed instead of overwriting another workspace's Page credentials.
- [x] Count one Startpilot image unit when the first provider attempt for a Messenger generation job starts; provider retries remain individually audited but do not consume extra customer pilot generations.
- [x] Land the idempotent workspace-wide image receipt and its real MySQL
      last-slot/same-request race proof. PR #417 and protected deploy run
      32860967800 shipped it before any Mollie Test Mode checkout exposure.
- [ ] Prove the Page-to-workspace mapping and both paid quota gates in a production-like end-to-end test after the duplicate-Page preflight and migration, without any free-tier fallback.
- [ ] Prove the production Meta callback and customer routing terminate directly
      in image-gen without creating an OpenClaw host session transcript. Until
      this cutover evidence exists, host transcript erasure remains a
      conservative live blocker. After it passes, exact non-archiving OpenClaw
      erasure is a separate, non-blocking image-gen follow-up.
- [ ] Separately complete the personal-only OpenClaw gateway state/rollback work
      and exact non-archiving transcript erasure before enabling any OpenClaw
      transcript or customer feature. Keep it outside the critical Mollie and
      multi-tenant image-generation paths.
- [x] Replace the isolated worker with a durable tenant-partitioned scheduler
      and explicit `pilot_pin`/`multi_tenant` rollout, per-lane epochs,
      heartbeats, safety drain, backlog and dead-letter readiness.
- [ ] Extract billing outbox queue mechanics from provider handlers after the billing behavior is stable; keep this follow-up separate from launch-critical correctness changes.
- [x] Implement key-free signed customer/operator notification transport,
      durable receipts/outbox, dedupe, retry, fair scheduling and dead-letter
      readiness.
- [x] Expose materialized operator manual-review incidents to an authenticated,
      tenant-scoped platform-admin surface with metadata-only monotone ACK.
      Receiver dead letters remain authoritative red readiness signals for the
      required on-call drill rather than being acknowledged away in the portal.
- [x] Make accounting exports bounded and stream-safe with an explicit date
      range, high-water mark and canonical money validation.
- [x] Keep the built-in accounting importer disabled for the pilot because its
      durable cursor is not Balance-ID scoped; designate Accountable as the
      intended external bookkeeping workflow instead.
- [ ] Reconcile Mollie fees, Balances and Settlements in Accountable and record
      human accounting approval before live. If the built-in importer is later
      enabled, first add exact durable Balance-ID scope and migration coverage.
- [ ] Close every blocker in `docs/LAUNCH_READINESS.md` before enabling a `live_` key.

### Testing & docs

- [x] Test cost tracking
- [x] P1/P2 [owner: image-gen-runtime-test] Add targeted cost-ledger reliability tests for concurrent append/update behavior, overflow observability, midnight-crossing update reconciliation, and delete-cleanup latency under multi-period user history.
- [x] Create setup guide for Meta configuration
- [x] Document operator-facing prompt routing and OpenClaw-vs-image-generation fallback behavior separately from the completed customer-facing bot instructions. See `../../../../docs/operator-prompt-routing.md`.
- [x] Provide cost monitoring dashboard. Admin-only aggregate view exists at `/admin/cost-dashboard` with duplicate-skip and delivery-failure counts; production dashboard polish and failure drilldowns are deferred.
- [x] Record the 2026-07-09 CodeQL/customer-preview follow-up so the merged
      branches are reviewable after the fact:
  - CodeQL is intentionally configured through the checked-in advanced workflow
    at `.github/workflows/codeql.yml`, with `languages:
javascript-typescript`; GitHub CodeQL default setup must stay disabled or
    GitHub rejects advanced-workflow SARIF uploads.
  - CodeQL pull request and `main` push triggers intentionally cover root
    plugin JS/TS, `apps/**` JS/TS, `scripts/**` JS/TS, lockfiles, and
    production Fly gateway scripts under `deploy/fly-gateway/**/*.js`,
    `**/*.mjs`, `**/*.cjs`, and `**/*.ts`.
  - PR #336's public preview keeps render pure for OAuth: `getLoginUrl()` must
    be called only inside the Facebook login click handler because it creates
    and stores the OAuth state nonce.
  - PR #336's unauthenticated public preview copy is locale-owned through
    `portalLocales.ts`; do not add hardcoded Dutch/English/French UI strings
    directly in `Home.tsx`.
  - The public preview is example data only. It must not read tenant content,
    customer conversations, uploaded knowledge, raw PSIDs, OAuth tokens, or
    generated prompts/outputs before the user authenticates into a workspace.

### Maintenance backlog

Run each pass as a separate, reviewable PR validated with `pnpm --dir apps/image-gen check`, `pnpm --dir apps/image-gen test`, `pnpm --dir apps/image-gen fallow:report`, and `pnpm --dir apps/image-gen fallow:gate`.

0. OpenClaw runtime upgrades for Fly/Docker installs
   - [x] Single supported update, validation, release, and rollback workflow is documented in `docs/openclaw-update.md`.
   - [x] Runtime validation is automated by `npm run openclaw:validate` and the Fly gateway image build.
   - [x] Follow-up: design a managed redeploy handoff with explicit operator approval, scoped deploy credentials, redacted audit logs, and rollback guidance. Do not mutate `/app/node_modules/openclaw` inside a running Fly machine. See `deploy/fly-gateway/managed-redeploy-handoff.md`.
1. Unused dependencies / package cleanup
   - Fallow currently reports `unused_dependencies: 0`; do not remove `express` while runtime/tests still import it.
   - Re-run Fallow after each dependency update and verify package-lock/pnpm-lock changes stay scoped.
2. Dead exports and dead files
   - Triage server dead exports before frontend entries; Fallow may not see Vite's `client/index.html` entry correctly.
   - Avoid data deletion, face memory, storage retention, webhook routing, Meta verification, and public API contracts unless code search and tests prove removal is safe.
3. Duplicated helpers
   - Start with duplicated test queue helpers reported in Messenger generation/webhook queue tests.
   - Keep helper extraction inside test code unless production duplication has direct maintenance cost.
4. Large/hot modules
   - Split only one responsibility per pass from webhook and generation modules.
   - Preserve routing, consent, quota, and image delivery behavior with targeted tests.
5. Risky architectural refactors
   - Handle channel-neutral conversation layering, portal ownership boundaries, and storage proxy changes separately from maintenance cleanup.
   - Require explicit migration and rollback notes before touching production data or public contracts.

## Reeds geverifieerd in code (afgerond)

- [x] OpenAI image generation integration via Responses image generation
- [x] OAuth callback + state validation flow
- [x] Messenger quota checks before generation
- [x] Database-backed quota tables/helpers (`dailyQuota`) beschikbaar
- [x] Redis-backed Messenger generation queue with dedicated worker is active in production
- [x] Duplicate Messenger generation queue enqueues are deduped by request id
- [x] Face Memory retention is configurable via `FACE_MEMORY_RETENTION_DAYS`
- [x] Webhook opgesplitst in `messengerWebhook.ts` + `webhookHandlers.ts` + `webhookHelpers.ts`
- [x] Deploy to production + webhook connectivity tests
- [x] Text-to-image generation accepts arbitrary visual prompts without defaulting to Storybook Anime
- [x] Image-generation success/failure follow-ups use channel-neutral conversation actions before Messenger rendering
- [x] Removed unused director prompt/social-copy modules so stale template presets cannot re-enter generation output
- [x] Removed director-mode fields from active generation/runtime state so stale template names cannot influence prompts or follow-up edits
- [x] Made image prompt building more prompt-faithful by removing role/template language and blocking default cinematic/editorial/anime/luxury aesthetics unless requested
- [x] Kept ambiguous "make me / maak me" visual requests prompt-first and routed missing-subject complaints as image follow-up corrections
- [x] Aligned internal image-request routing with prompt-first intent rules so retained photos no longer hijack ambiguous "maak me" prompts
- [x] Extracted shared image intent primitives so Messenger and internal image-request routing use the same prompt-first rules

## Historisch afgerond

- [x] Meta webhook/page/token setup
- [x] Initial Messenger webhook handler and image upload support
- [x] Legacy preset/style-prompt system documented as deprecated; do not treat it as the current product direction

> Note: Legacy route `/api/webhook/facebook` is deprecated and no longer used.
