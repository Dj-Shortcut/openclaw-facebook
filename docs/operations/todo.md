# Leaderbot production outcomes

This is the only source of truth for open product and production work.

Last reset: **2026-08-27**.

## Product decision

```text
One owner-operated Facebook Page
-> direct Meta webhook
-> apps/image-gen
-> many isolated Messenger users
-> free daily images
-> optional one-time premium credit bundles
```

The target product has:

- one commercial owner;
- many end users with separate pseudonymous state;
- no OpenClaw runtime dependency;
- no external tenant/workspace provisioning;
- no subscription, mandate, automatic renewal, automatic top-up, or overage;
- one-time Mollie checkout only;
- purchased credits separate from the resetting free allowance;
- premium quality selected by a server-owned offer policy.

The reusable OpenClaw Facebook channel remains a separate open-source product.
It will move out of this repository after its standalone package, channel-index,
ClawHub, install, release, and rollback routes are proven.

## Active order

Owner-directed execution note (2026-08-28): implementation and Test Mode work
for P2 through P4 may continue while the currently deployed bot remains in use.
That sequencing decision is not production evidence for P1. P1 remains open
until the direct owner Page callback, zero OpenClaw gateway traffic, rollback,
retention, and standalone-channel extraction proofs below are actually recorded.
Live payment enablement remains gated by the relevant P1 through P4 evidence.

- [ ] **P1 - Direct owner bot and OpenClaw retirement proof.** Point the owner
      Page at the direct `apps/image-gen` Messenger callback using the intended
      Meta app and credentials. Prove verification, signatures, text, consent,
      image generation, edits, quota, deletion, queue, delivery, monitoring,
      and rollback without OpenClaw. Record zero gateway traffic before
      disabling its callback and infrastructure. Preserve or delete legacy
      volume data under an explicit privacy/retention decision. Extract the
      generic OpenClaw channel to its standalone project before removing the
      root package and ClawHub workflows from this repository.
  - [x] PR #479 removed the automatic gateway health probe at exact `main`
        merge `6f48774d9ffdb744441570ed0da619bf08be6fb7` on
        `2026-08-30T17:37:55Z`. Because the observation duration had not yet
        been fixed before that merge, this timestamp is not the observation
        start.
  - [x] PR #480 fixed the observation duration in advance at exactly 168
        continuous hours (seven 24-hour periods) and merged to `main` as
        `c251a5e34c46bd327ffa5c015ed038f1fced545e` on
        `2026-08-30T17:44:08Z`. That exact SHA and UTC timestamp start the
        observation clock.
  - [ ] After that start, collect continuous metadata-only gateway ingress
        evidence for all 168 hours. The scheduled end is
        `2026-09-06T17:44:08Z` only if the full window remains uninterrupted. A
        green health check is not user-traffic evidence. Any evidence gap,
        gateway probe, gateway Machine mutation, or direct Page-callback drift
        resets the clock and requires a new reviewed start and scheduled end.
        Do not stop, delete, scale, or replace the gateway Machine or its
        volumes during this window.

- [ ] **P2 - User-scoped purchased-credit ledger.** Add an append-only credit
      ledger, wallet projection, and idempotent reservation/commit/release model
      bound to the exact conversation subject and privacy epoch. Keep free daily
      quota separate. Prove duplicate events, concurrency, crashes, deletion,
      Page rebinding, refund adjustments, and insufficient balance.

- [ ] **P3 - Quota-exhaustion CTA and one-time checkout.** Return a
      channel-neutral upgrade action when free credits are exhausted. Open a
      short-lived single-use checkout handoff bound to user, Page, privacy
      epoch, offer, and nonce. Show exact price, credit count, quality, validity,
      no-subscription disclosure, and no-purchase alternative. Grant once only
      after trusted Mollie payment verification; never from the browser return.
      Test Mode must exercise that same signed checkout path; the temporary
      direct Mollie command has been removed. The production trigger remains
      the daily free-credit exhaustion path only.

- [ ] **P4 - Premium quality and Test Mode journey.** Bind the paid offer to a
      versioned premium provider policy and prove unit economics. In Mollie Test
      Mode, pass paid checkout, delayed/replayed webhook, cancellation, failure,
      refund, partially used wallet, provider failure, delivery failure,
      deletion, budget exhaustion, receipt, reconciliation, and rollback.
  - [ ] **Remove portal prerequisites from credit activation.** Credit startup
        and `/readyz` must work without a legacy buyer-profile attestation or
        `PORTAL_HANDOFF_TOKEN_SECRET`. Preserve the existing
        `BILLING_PROFILE_EVIDENCE_HMAC_SECRET` for credit recovery evidence;
        its historical name does not make it a portal prerequisite.
        Keep the owner/user boundary, signed credit capability, audited payment
        controls, worker health, budgets, and retained-payment recovery intact.
        The code separates these requirements from legacy sales and initializes
        payment controls through the existing audited operator action, without
        a profile attestation. PR #522 merged as
        `92961bb59bef11e7a6e02e1bbe44383907c16f60` and is deployed in
        `deploy-34484419576-1`; actual payment-to-credit-to-delivery proof
        remains outstanding.
  - [ ] **Test Mode without tester registration.** Owner direction (2026-09-10):
        any eligible Messenger user must be able to test without a manually
        registered identity or customer login. Leave the four optional tester
        restriction fields empty, while automatically binding each checkout,
        payment and wallet to its actual Messenger user and Page/privacy
        boundary. PR #522 implements eligibility and retains consent, budgets,
        audited payment controls and worker checks. PR #522 is merged; PR #515
        merged as `b9caea7951b44d1f97bbd1bc742c25aca68264e9` with tests for two
        users under one unchanged configuration with all tester pins absent.
        Both changes are deployed in `deploy-34484419576-1`. The complete
        payment-to-credit-to-delivered-edit proof remains outstanding;
        live billing stays off.
  - [ ] **Bug: false failure message after a delivered image.** Owner report
        (2026-09-09): the tester receives each photo, then also receives
        "ik kon de afbeelding nu niet maken". PR #514 identified post-delivery
        bookkeeping failures escaping into generic failure handling and merged
        its scoped suppression and regression tests as
        `b8ad818ab2a02b8b1c527327821f3f8a8a30a1fa`. The fix is deployed in
        `deploy-34484419576-1`; actual delivered-image verification remains
        open. Code tests are not proof of delivery. Genuine failures, retry protection and exactly-once
        quota/credit accounting remain required.
  - Read-only activation inventory on 2026-09-10, exact running
    `deploy-34461561679-1` and restricted runtime principal: the deployed Mollie
    key has a Test prefix; the recovery signer and both distinct, correctly
    paired notification-signing audiences meet their configuration checks.
    This does not prove Mollie accepts the key. The checkout signer was staged
    at this inspection and was subsequently applied by `deploy-34484419576-1`.
    Workspace 1/Test controls already exist at epoch 1 with
    commercial execution disabled; the outbox safety lane is enabled, the
    other three lanes are disabled, and every lane has zero pending/dead-letter
    work. Use the existing audited enable action, not direct SQL. The temporary
    metadata-only probe was removed. No customer rows, payments or provider
    calls were read or changed.
  - [x] **Roll out the current reviewed fixes before activation.** Protected
        build [34479903069/1](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34479903069)
        succeeded from `b9caea7951b44d1f97bbd1bc742c25aca68264e9`, producing
        `sha256:f2fa9d60e1fca02c09cb2764981a7134e908f2e33f127eb0e54e77030b4a7a4b`.
        PR #523 merged as `a3d0f1f10572debde5540a1097e906d9b54e8309` after
        review and CI. Protected deployment
        [34484419576/1](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34484419576)
        passed artifact provenance, Meta callback, rollback, billing-trigger,
        drift and health/readiness checks. All four Machines independently
        report the exact image/source above and `deploy-34484419576-1`.
        This includes PRs #514, #515, #520 and #522 and retains the proven
        `deploy-34461561679-1` predecessor for rollback. The existing checkout
        signer is now Deployed, with no staged secrets remaining. Paid and
        checkout flags remain false, mode is test, and live remains false.
        No grants, schema or gateway settings changed. Anonymous `/healthz`
        and `/readyz` return 200; all four legal routes return 200 with the
        shared header/footer, and browser inspection confirms the new privacy
        and terms layout. This is not payment-to-credit-to-delivery proof or
        live-payment approval.
  - [x] **Credit schema installed in production.** Protected run
        [34339825855/1](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34339825855)
        on `ea680af1061901436fdae4e59397365ce6949f36` completed at
        `2026-09-09T10:41:12Z`: exact `0016 -> 0018`, restored-snapshot integrity
        proof, isolated restore resources removed, and temporary SUPER revoked.
        The transition artifact digest is
        `sha256:b86a0f76a4538bc580fd8f16698e4f6573312e1e3082c3ad3e784201c89b7ec5`.
        The exact repair token and GitHub secret were retired with
        `repair_exec_token_retired`. Do not repeat this installation or the
        previously completed cleanup `34335377679`.
  - [x] **Build the final credit runtime.** Protected build
        [34342883040/2](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34342883040)
        succeeded on `80703910131e227d1d683b1f5b6287c8bff241de`, producing
        `sha256:1d80d6bce5fdbd7486f31d6223ca87ac7a50d075661ec48ae0f3d536eb8e5b36`.
        Exact labels, rejection of pre-credit schemas, acceptance of 0018,
        and trusted provenance passed. Attempt 1 stopped at the initial
        exact-source CI gate while its last test was still running; it did
        not build or deploy an image. Attempt 2 ran after all main CI passed.
  - [x] **Stage the reviewed credit runtime principal.** Protected run
        [34345293602/2](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34345293602)
        on `c784e496cf8e629b87dd8b31c28bfbbe989a70b6` verified the restricted
        grants and exact candidate trigger preflight, then staged `DATABASE_URL`
        at `2026-09-09T11:53:32Z` without restarting any Machine. Artifact digest:
        `sha256:d3f807a17cc0e5d051e2d5aa476d600bbdf8395dc338c745073995f5930403e8`.
  - [x] **Review and deploy the staged credit runtime.** Protected rollout
        [34461561679/1](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34461561679)
        on `8ee0a971e4916b92ca07be6924498373315775e7` succeeded. All four desired
        app/worker Machines run the reviewed `1d80d6bce5fd...` final runtime under
        `deploy-34461561679-1`. The exact restricted-principal probe passed on
        every Machine; smoke health/readiness and a fresh strict settled-live
        readback passed with no drift (Fly release 381). The release artifact
        contains `runtime-principal-cutover.json` with `machineCount:4` and
        `healthAndReadinessPending:false`; artifact SHA-256:
        `8d4ca366b787d54f4c23a6722647033ff02651b40d78c1af4b4023e0479f5049`.
        The public HTML at `app.leaderbot.live` contains the premium-credit
        offer. This is not visual acceptance: the owner reports old styling on
        privacy, terms, refunds, data, contact and Messenger pages; Claude is
        checking these against the approved homepage in a separate frontend PR.
        Payment flags remain off in Test Mode. Personal Messenger checkout, actual
        credit grant and delivered-edit proof remain open below. Do not repeat
        the completed schema expansion, hostname repair or principal staging.
    - Rollout `34350372911/1` on merged PR #511 stopped in `Record rollback
release`, before any deployment or restart. The app-level Fly config
      returned no deployment identity, while all four started Machines still
      proved `deploy-33297361675-1` and the reviewed bridge image; `/readyz`
      remained 200. Capture rollback from the existing strict settled-live
      Machine/release evidence, not the shadow app config. Require an unchanged
      settlement tuple and the exact hash-reviewed restore file before retrying.
    - Rollout `34353109061/1` passed the corrected rollback capture, then both
      candidate and restore release commands rejected the staged database URL
      with `getaddrinfo ENOTFOUND` on a bracketed IPv6 hostname. No app/worker
      Machine was replaced: all four retained the reviewed bridge and identity;
      exact restored-config verification plus health/readiness passed. The
      staging probe had used an IPv4 tunnel, missing the production URL parsing
      mismatch. Repair only the staged URL hostname via the protected hostname
      repair workflow, preserving the restricted principal and password; prove
      the exact schema and trigger probes through that production hostname
      before the next rollout. Do not repeat schema migration or create another
      principal. The separate recovery controller also needs its standalone
      startup regression: its eager cleanup-helper import was unavailable in
      the isolated recovery directory.
    - Host-repair run `34457016452/1` (2026-09-10) stopped at
      `runtime_database_host_probe_create_failed`, before URL staging, and did
      not establish cleanup completion. A subsequent read-only reproduction
      with pinned flyctl 0.4.85 showed that its image resolver duplicates the
      reviewed digest suffix. Correct the probe creation request to preserve
      that exact digest, retain all existing isolation/cleanup guards, and
      rerun only after reviewed main CI.
    - **Hostname repair passed:** protected run
      [34458768314/1](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34458768314)
      on merged PR #518 (`d9042b1303ecca481ffb122cdee64ac26205c1d2`) passed both
      exact schema and trigger probes through the corrected hostname, staged
      the same restricted principal, removed its probe and reproved the unchanged
      bridge baseline. This step is complete; do not repeat it or rotate keys.
    - Runtime rollout `34459197149/1` then started the reviewed final runtime
      on all four Machines, but the post-deploy principal probe failed before
      running: Fly SSH treated the leading environment assignment as an
      executable. The protected workflow restored all four Machines to the
      reviewed bridge and verified restored configuration and health. Prefix
      that exact probe command with `env`, prove the argv behavior in tests,
      and retain the all-Machine gate for the next rollout. PR #519 supplied
      that fix and executable regression; run `34461561679/1` subsequently
      passed the complete rollout. Neither run proves a payment test.
    - Public address check (2026-09-09): `app.leaderbot.live` serves the bot app;
      Fly lists its certificate as ready. `leaderbot.live` resolves to different
      A/AAAA addresses and timed out from the operator Mac. Verify/correct that
      separate public-domain route after this runtime rollout; do not claim the
      apex serves the new frontend merely because the app subdomain is healthy.
      Read-only inspection on 2026-09-11 identified the apex A/AAAA as the
      stopped OpenClaw gateway's assigned ingress addresses; that app also
      retains the `leaderbot.live` and `www.leaderbot.live` certificates.
      Authoritative DNS is `dns1.registrar-servers.com` /
      `dns2.registrar-servers.com`, not the Cloudflare R2 account. Prepare
      certificates on image-gen and a reversible DNS cutover separately; keep
      the gateway stopped, existing email/assets records unchanged and signed
      checkout URLs on `https://app.leaderbot.live`. No domain change has run;
      this marketing-domain repair does not block Test checkout on the app host.
    - Staging run `34345293602/1` stopped at `scheduler_update_trigger` before
      staging a secret or restarting a Machine. Read-only metadata proved the
      three legacy billing triggers still named the active runtime account,
      which had no `TRIGGER` privilege. The failed staging account was removed.
      The reviewed DBA runbook repair completed at `2026-09-09T11:47:26Z`:
      all three bodies and every other 0018 trigger remain unchanged, with one
      locked, separate definer and exactly the prescribed two table-grant sets.
      Snapshot `vs_zGGOJgmJAKGKfqMJklNp6` has digest
      `0e17cf05d01b0639756fc438d285735130edb03dd2d99b1df12562af1398c1b0`.
      Runtime grants and billing flags were not changed; `/readyz` stayed green.
      Attempt 2 then passed the protected restricted-runtime reproof. The staged
      fingerprint is not proof of application rollout or a completed payment.
    - At checkout activation, also replace the landing page's hard-coded
      `commercialBillingAvailable=false` / no-purchase badge with truthful
      Messenger-purchase guidance. The public landing page must not create an
      unbound payment or imply a working checkout while exposure remains off.
    - After schema/runtime readiness, complete the actual Messenger journey:
      signed checkout, verified Mollie webhook, credits on the correct
      user's balance, one delivered premium edit, and one debit. The
      owner's earlier Mollie test payment and refund did not prove the
      credit grant. Keep the current offer unchanged. Live-pilot readiness
      additionally requires the P5 gates below.

  - [ ] Before any Mollie Test Mode checkout, prove the restricted runtime and
        settle the manifest at `complete` with only proven 0018 runtime
        rollbacks. A separately reviewed `creditTestActivation` request may
        expose the existing Test offer without tester registration after the protected
        obsolete-principal flow locks the old broad runtime account. The
        protected deployment must independently prove that account is still
        locked, has zero sessions, and every current app/worker uses the exact
        restricted principal. Produce and consume fresh metadata evidence in
        the same deployment run under the shared lock; a historical lock
        artifact or a manifest assertion is not current proof. Keep a proven
        drain-on, checkout-off rollback and all payment/privacy/budget gates.
        The reviewed desired Test configuration does not itself expose checkout;
        the running Machines remain closed until the protected activation
        and subsequent deployment both succeed.
  - [ ] Retain the obsolete account's 24-hour recovery window before its
        separately approved irreversible drop. Unlock is blocked while the
        reviewed Test request exists or any Machine still exposes credits or
        checkout. Keep `IMAGE_GEN_DATABASE_PROVISIONER_URL` until the drop
        succeeds. Then run the separately reviewed
        `.github/workflows/retire-image-gen-credit-provisioners.yml` path to
        lock all reserved `lbcp_*` accounts under its own database-backed
        24-hour recovery window, drop them, and prove the inventory empty. An
        authorized owner must then delete the exact production environment
        secret before the workflow's separate stable-absence verification.
        Full credential retirement remains incomplete until both cleanup paths
        have metadata-only success evidence. Their irreversible deletion clocks
        are unchanged; do not substitute manual SQL or unreviewed secret edits.
        This bounded Test exception does not authorize live payment exposure.
    - On 2026-09-10 the owner explicitly approved replacing the old bridge
      rollback with the proven running runtime after the change was explained.
      That settlement removed the bridge, set the schema transition to
      `complete`, and recorded `deploy-34461561679-1` with its exact config as
      the final-0018 runtime rollback at that time. It authorized no account
      deletion, new database permissions or payment activation. The previous
      automatic-review denial was not bypassed; the owner supplied the missing
      specific authorization. A later owner-approved settlement superseded that
      rollback point with `deploy-34496956631-1`; see the PR #524 entry below
      and read the exact current values from `deploy/production/apps.json`.
    - PR #517 merged on 2026-09-10 as `7ba51d1a4f411fa18094ad42328718eb14dbeb22`.
      Both the PR MySQL run `34485670813` and main run `34486831012` passed,
      including the corrected exact-user disabled-monitoring fixture. This
      supersedes the failed test setup in `34482865305`; do not repeat that
      implementation. The existing same-run inspection uses the protected
      provisioner through a pinned exact-Machine tunnel. It does not create
      access or enable checkout. The owner separately authorized the exact
      four-column metadata read grant on 2026-09-10; its application and
      readback succeeded at `15:44:48Z`. Only the existing provisioner's
      inspection rights changed; no bot rights, passwords or customer data
      were changed. This is not the protected same-run activation proof.
    - Read-only operator inspection at `2026-09-10T14:51:51Z` found zero obsolete
      sessions in a complete stable census, but did not prove the obsolete
      account locked or absent. The historical fingerprint covered `User@Host`;
      it was mapped to the account's `User` fingerprint before the census.
      The earlier mismatched-fingerprint lookup is not account-retirement
      evidence. The sole managed provisioner had the valid base profile but
      not the four-column extension. No account, grant, secret or
      data was changed. This local diagnostic is not the protected same-run
      activation proof and cannot replace its credential-consumer checks.
    - The owner separately approved temporarily locking the exact unused old
      runtime account. Protected workflow `34498036250/1` succeeded, recording
      `ACCOUNT LOCK` at `2026-09-10T15:54:21.110Z` for account-name SHA-256
      `db3013fb364b7486dabd6520c68beb4a7f5df05530ce90febb30049418a509b5`
      against deployment `deploy-34496956631-1`. The account was not dropped.
      Independent readback at `15:55:52Z` confirmed it locked with zero old
      sessions in a complete stable census; the existing provisioner retained
      its valid base profile plus the exact four-column inspection extension.
      Commercial control remained false at epoch 1 and all five activity/two
      queue counts remained zero. These completed access steps do not replace
      the later activation workflow's fresh same-run proof.
    - PR #524 merged as `f0c491c74c46e2f6821e12f3ea46e818f789c209`; its
      protected processing-only rollout `34496956631/1` succeeded on
      2026-09-10. Fresh settled-live verification proved
      `deploy-34496956631-1`, reviewed runtime `f2fa9d60...`, release 383 and
      watermark `ff6eab0614dd8a72ba26f93ae5093ea3610ae617c01452a255c2ade5092ad508`.
      `/healthz` and `/readyz` returned 200; readiness reported `operational`
      with all checks true. All four Machines retained Test Mode with
      checkout, paid image use and live billing false. No payment was made.
      The owner explicitly approved replacing the old recovery version with
      this successful processing-on version. The settlement uses its exact
      protected-source config, SHA-256
      `05ffded5fb93abca68e275fe174f20db55f9e0dd1a679cd94c6378fc10053380`,
      as the sole runtime recovery configuration; the older physical files
      remain retained. PR #525, including corrected recovery references, merged
      as `0535cb879f477891bfb49ff6025886b48194d7a7`. This closes the reviewed
      recovery settlement only, not checkout activation or the payment test.
    - A browser check of the existing operator login reached Facebook, but
      Facebook refused authentication with a supported-permission error.
      A 302 from the login route is not successful sign-in. The existing
      audited `billingAdmin.enableSchedulerTenant` action still needs a
      legitimate admin session; do not forge one or register a tester to
      bypass this. Public checkout does not require operator login.
    - The owner explicitly approved a separate protected operator command on
      2026-09-10 to enable Test payment processing without Facebook login.
      PR #526 reuses the existing epoch-fenced audited
      scheduler service, resolves the existing owner/admin, and records the
      actual GitHub operator/run rather than fabricate a web session. No new
      login, Facebook permission, database account/grant, tester registration,
      payment, or live exposure is authorized by this code change.
      A metadata-only precheck at `16:44:35Z` found exactly one existing
      owner/admin for workspace 1; commercial controls remained false at
      epoch 1 and all lane pending/dead counters were zero. The exact Test
      workspace had zero provider operations, subscriptions, payment routes,
      ledger rows, exposed intents, pending/dead outbox work and notifications.
      This precheck alone was not operator execution evidence. The subsequent
      protected operator success is recorded below; retain its receipt before
      dispatching the separate exposure deployment.
      These manual workflows do not deploy automatically when a PR is merged.
      If the operator response is ambiguous, never rerun the mutation with a
      changed request, run/attempt/source or executable provenance. The reviewed
      audit-preflight follow-up adds read-only inspection of the original
      committed audit to the existing protected `prove`/`consume` path and
      requires the enabled Test epoch and all four matching lanes before Fly
      apply. If the response is lost, this same protected deployment proof can
      recover the original committed audit; no independent recovery command or
      new enable mutation is required. A lost response is not proof of rollback;
      inconsistent or missing committed state blocks before Fly apply. Retain
      the immutable operator artifact/predecessor anchor and initial
      request `8a62f93d-e092-4dd8-82ca-9e77bdd89d54`, fixed to epoch 1→2, before
      the exposure deployment. This request committed at epoch 2 in run
      `34581138362/2`; keep the whole anchor unchanged across later frontend
      releases.
      Current runtime and payment safety checks remain fresh
      on every deployment; a later disable/re-enable cannot replace the original
      activation, even with the same artifacts. This proof's protected execution
      and the actual payment-to-credit-to-delivered-edit journey remain pending.
      Review follow-up on 2026-09-11 fixes the CI scalar-row type checks, persists
      exact executable identities in the atomic audit, rejects failed billing
      outbox work and refuses missing control/lane registration without writing
      new rows. PR #526 merged as
      `3f0b7d01b0daef28f6f9abf8d514a128d68eeb62` at
      `2026-09-11T06:42:21Z`, after green CI and review. Image Gen CI
      `34570157440` actually ran both dedicated MySQL operator cases;
      migration smoke `34570157395` also passed. A fresh metadata-only
      production inspection at `2026-09-11T06:37:54Z` confirmed the same
      disabled epoch, existing owner/admin and zero pending/dead or financial
      work, without changing data. That precheck is distinct from the actual
      operator success below. Checkout exposure and the
      payment-to-credit-to-delivered-edit proof remain open.
    - Protected operator run
      [34581138362/2](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34581138362/attempts/2)
      successfully committed the original request at epoch 2 for workspace 1,
      Test Mode, from workflow source
      `108379291f6cb59b196f078621ca51f3addd3cde`. It used operator image
      `c54c1fd0...` / artifact source `479e43d17aab852ea6b4bbfd6b03c4eac15eb797`
      on the unchanged `f2fa9d60...` / `deploy-34496956631-1` predecessor.
      The metadata receipt records success, committed outcome, unchanged
      baseline and verified remote/container cleanup; its SHA-256 is
      `96e407ac273acfb3b387f63e98e28c2bf6a10838624057f2954eb4d360b2c3c4`.
      Exact image and bundle provenance is recorded in the production runbook.
      Attempt 1 stopped at baseline with `not_started`, before upload or
      activation dispatch; the redacted evidence establishes no failure cause.
      No new operator action is needed for a later frontend artifact. This
      success does not deploy that artifact, expose checkout, make a payment,
      grant credits or deliver an image. Fresh deployment `prove`/`consume`,
      the exposure rollout and the actual Test payment/edit journey remain open;
      all running purchase entry points and live/legacy billing stay closed.
    - Protected artifact build
      [34578480504/1](https://github.com/Dj-Shortcut/openclaw-facebook/actions/runs/34578480504)
      passed from exact merged source
      `479e43d17aab852ea6b4bbfd6b03c4eac15eb797`, producing runtime
      `sha256:c54c1fd026e281ada8f88ecb1acc0a26d48e736b3874d3e7aeb70dc2c64efe5f`
      with attestation `46800613`. Its exact-container checks reject pre-credit
      schemas and accept 0018. This supersedes the unexecuted `70c608aa...`
      candidate and includes the reviewed conditional purchase copy and original
      activation-audit checks. The desired Test activation pins this artifact
      while retaining `f2fa9d60...` / `deploy-34496956631-1` as the unchanged
      checkout-off, processing-on predecessor and rollback. The offer remains
      EUR 4.99 for eight medium credits; all manual tester pins remain empty,
      and live/legacy billing stay disabled. No operator execution, public
      checkout or payment-to-credit-to-delivery evidence is claimed by this
      build or configuration change.
    - The completed payment-processing preparation changed only notification, drain and
      reconciliation flags to true; checkout, paid image use, legacy sales and
      live billing remain false. It reuses the reviewed `f2fa9d60...` runtime,
      not a new payment implementation. Metadata-only checks on all four
      Machines confirmed the deployed Test key, matching distinct notification
      key pairs and both required HMACs. The same database inspection found
      control epoch 1 with commercial access disabled, outbox enabled and the
      other three lanes disabled at epoch 1, with no pending/dead work.
      All five durable provider-activity counts and both delivery-queue counts
      were zero, confirmed again immediately before dispatch at `15:36:15Z`.
      These pre-rollout observations permitted the initial processing-only
      transition while all purchase entry points stayed closed. Post-rollout
      readiness and the new recovery baseline are recorded above.
      This configuration-only rollout pinned its actual predecessor
      `deploy-34484419576-1` and its exact protected-source config from
      `a3d0f1f10572debde5540a1097e906d9b54e8309`, so the existing settled-live
      gate can distinguish that current state from the proposed flag change.
      The prior `1d80d6bc...` rollback allowlist was unchanged during that
      rollout; neither retained drain-off config is a post-payment recovery
      baseline. Do not repeat the initial preparation path if any count is
      nonzero or commercial controls have changed. With no route or ledger, an unknown Mollie
      callback may perform a provider read but cannot persist the first
      financial record. Do not extend this empty-state rollback reasoning to
      an installation with existing payments or exposed checkout.
    - Checkout configuration readback (2026-09-10): `MOLLIE_API_KEY` is present
      and deployed. After confirming no pending secrets and no existing signer,
      the owner-authorized test setup generated a fresh 32-byte
      `CREDIT_CHECKOUT_HMAC_SECRET` in memory and imported it through stdin with
      `--stage`; staging itself triggered no deployment or restart and replaced
      no existing key. Its value was not logged or written to disk. The later
      reviewed deployment `34484419576/1` applied it; Fly now reports `Deployed`
      and no staged secrets. This is not evidence that checkout is active.
      Automatic per-user checkout binding, payment drain/notification configuration and
      real Test Mode payment-to-credit-to-delivery proof are still required.

- [ ] **P5 - Bounded live pilot and legacy removal.** Obtain legal/accounting
      approval, enable one reviewed live offer for a bounded audience, monitor
      conversion, cost, failures, and support without content access, and prove
      rollback. Then remove the in-repo OpenClaw copy and gateway, customer
      portal, subscriptions, mandates, recurring workers, tenant provisioning,
      and stale secrets/workflows/docs.

## Current P1 gate

- Protected deployment inspection run `33297361675` proved the owner Page uses
  the canonical direct callback
  `https://leaderbot-fb-image-gen.fly.dev/facebook/webhook`. PR #479 removed the
  scheduled gateway health request. PR #480 then fixed and started the reviewed
  168-hour observation contract at
  `c251a5e34c46bd327ffa5c015ed038f1fced545e` on
  `2026-08-30T17:44:08Z`, with conditional end
  `2026-09-06T17:44:08Z`. P1 remains open until uninterrupted metadata-only
  zero-ingress evidence, direct Messenger smokes, rollback/retention decisions,
  the later reviewed gateway stop, and standalone channel publication are
  complete.

- Storage-proxy startup ordering was fixed and merged in PR #445 at reviewed
  source commit `6a7d0431e1e02076a2db7fcf12c8358d7fbf33cd`.
- CI boundaries were separated and merged in PR #447 at main commit
  `6c94be30ecc0fc8723f726c59e23b0cf88afacc9`.
- Production uptime was rechecked on 2026-08-27: image-gen, storage proxy, and
  legacy gateway health/readiness checks passed after one transient network
  failure from a GitHub runner.
- On 2026-08-30 the owner explicitly approved a reversible gateway
  decommission step. Fly machine `28621d2c559558` was stopped; all four
  gateway machines are now stopped, gateway `/healthz` returns `502`, and the
  direct image-gen `/healthz` remains `200 ok`. Gateway volumes and IPs were
  intentionally preserved. This proves quiescence, not zero historical
  gateway traffic or permission to delete the gateway state.
- GitHub Actions deployment evidence from 2026-08-30 shows that production
  deploys are target-specific, not a fan-out deployment of gateway,
  image-gen, and storage-proxy. Successful image-gen run `33297361675` took
  about four minutes end to end. Failed run `33310266008` stopped in about
  nine seconds during the enabled-target validation because the protected
  `0016-to-0018` credit-schema expansion freeze was active. The immediate
  simplification is therefore to finish that schema gate and keep retired
  targets disabled; deleting machines would not fix this Actions failure.
- The latest protected schema attempt `33300214073` reached the database
  preflight and failed closed because the configured migration principal is
  missing the exact schema privileges `CREATE`, `TRIGGER`, `CREATE ROUTINE`,
  and `ALTER ROUTINE`. This is production credential drift, not an
  application-code failure. Repair must be performed through the separately
  protected database provisioner, followed by the existing grant inspection;
  do not broaden the app runtime or bypass the contract.
- The reviewed repair now delegates only those four schema privileges to the
  protected provisioner, grants them to the migration principal before the
  credit DDL, and re-inspects the effective migration boundary. Repository
  validation, TypeScript, and 1,535 deployment-contract tests pass, including
  rejection of a provisioner missing this exact delegation. The MySQL
  rehearsal still needs to run with its dedicated rehearsal URL before any
  production attempt.
- After the deletion-heavy simplification, the full image-gen suite passed on
  2026-08-30: 185 test files passed, 17 skipped; 2,312 tests passed, 148
  skipped. This covers the retained Messenger, privacy, quota, wallet,
  payment, storage, queue, and deployment-boundary paths; it does not replace
  the missing direct Page callback and production schema-transition evidence.
- A live read-only check on 2026-08-30 returned HTTP 200 for
  `https://app.leaderbot.live/`, but its HTML still advertised the retired
  customer workspace, customer portal, and `€19` Startpilot. The repository's
  current checkout page is already the minimal signed credit checkout, so the
  live domain is stale deployment evidence rather than proof that the new
  checkout is live. Do not claim checkout launch until the protected image-gen
  deployment and browser smoke journey pass.
- A source route audit on 2026-09-09 found no registered customer login,
  customer portal, or OpenClaw HTTP route in the active image-gen server. One
  OAuth callback remains on purpose: it is the internal operator login, the
  only safe way to reach the billing admin procedures that recover held
  credits. It is not advertised anywhere public, has no dashboard behind it,
  and grants the admin role only to the configured owner account. The
  remaining `/api/trpc` surface is limited to internal operator procedures;
  historical handoff and billing-drain workers remain only for controlled
  retirement of durable records.
- Build run `33092823815` produced and attested immutable storage-proxy digest
  `sha256:99ea65710abb9a2294dcaf02cf76f57b240cb153a69e6020b68a470278103a8d`
  from exact reviewed source `6a7d0431e1e02076a2db7fcf12c8358d7fbf33cd`;
  GitHub provenance attestation `43467733` is the trusted build record.
- Protected deploy run `33101076132` proved artifact and source provenance but
  the candidate refused startup before binding its port. The existing
  metadata-only log could not distinguish Redis connection, Redis readiness,
  app construction, the R2 lifecycle preflight, or server binding.
  `R2_ACCOUNT_ID` was absent by design because the deployed `R2_ENDPOINT`
  alternative was present; do not
  treat that presence flag as the cause. The workflow restored reviewed legacy
  digest `sha256:334f78b92816a92e302a66c4d08742c28361a718b190227d3dbf7b933350cc28`,
  verified its captured configuration, and public `/healthz` returned `200`.
- PR #451 merged bounded, metadata-only startup-stage diagnostics at source
  `1da8da74f301fb368563cd094912e159d3bf6998`. Build run `33104393266`,
  attempt 2, produced runtime digest
  `sha256:a6bb22fcdbdfa6cc211afabfae86cc2423f501e589113f2f0a7e32db0f22083d`
  and GitHub provenance attestation `43482590`. The initial attempt stopped
  before building because exact-source main CI was still running; attempt 2
  started only after that CI passed.
- Protected deploy run `33105621166` admitted the exact `a6bb...` artifact and
  source, then failed closed in startup phase `r2_lifecycle_preflight`. The
  bounded diagnostics proved that configuration, Redis connection and
  readiness, and app construction had already passed. Read-only inspection of
  the production R2 bucket then confirmed that only Cloudflare's default
  multipart-abort rule existed; the three required 30-day prefix expiration
  rules were absent.
- The deploy restored and verified reviewed legacy digest `334f...`; public
  `/healthz` returned `200`, recovery run `33106363152` passed, and completed-run
  reconciliation `33106369992` also passed. The manifest was returned to
  `awaiting_attested_runtime`, so neither failed runtime candidate is
  dispatchable.
- The owner explicitly approved the retention boundary. Cloudflare stored the
  exact enabled 30-day rules for `inbound-source/`, `generated/images/`, and
  `generated/videos/`. A credential-separated, read-only lifecycle request
  returned HTTP `200` with those three exact rules plus the existing
  multipart-abort rule.
- Build run `33107224397` produced runtime digest
  `sha256:27dd75daaa30dac5a279fc097a57c14133efb419cbdbbd1fdefba26a21ffeace`
  from reviewed source `cf099e654d289186416b00500cb8f975cbdd906b`;
  GitHub provenance attestation `43489246` binds the exact pair.
- Protected deploy run `33110415900` deployed that exact reviewed digest from
  main commit `19ae52f90a683b2f975823a68d785608a7d8fbec` with identity
  `deploy-33110415900-1`. The final state has exactly one started Machine in
  `ams`, no deployment drift, `/healthz` `200 ok`, and `/readyz` `200` with
  `{ "ok": true, "rateLimiter": "shared_redis" }`. Rollback and recovery were
  correctly skipped, so the manifest now records `runtime_deployed`.
- This storage proof does not authorize a Facebook Page callback or gateway
  change; those remain separate from the customer payment path.
- The owner-operated photo-to-video path is implemented behind a default-off
  flag and a production-only pseudonymous pilot allowlist. It has a separate
  per-user attempt quota, global attempt cap, priced spend admission, zero
  automatic provider retries, bounded MP4 download, exact-scope provider-job
  cleanup, and delete-my-data coverage. This is not production proof and does
  not authorize enabling video before the remaining P1 callback proof and Meta
  Messenger demo checklist pass. Before activation, the owner must explicitly
  accept the residual provider-side 30-day retention boundary for a create
  timeout that occurs before a job id is returned; the client supplies an
  opaque support-reconciliation request id, but the provider documents no video
  create idempotency or programmatic recovery key.

## Current product hypothesis

Initial experiment, subject to owner sign-off and unit-economics proof:

- free allowance: a small daily number of standard images;
- exhaustion message: exact reset time plus optional purchase;
- candidate offer: a small one-time premium bundle, likely priced above EUR 1
  because fixed payment fees make a EUR 1 purchase inefficient;
- successful usable outputs consume credits; failures do not;
- purchased credits do not reset with the daily free allowance;
- no automatic follow-up outside Meta's allowed messaging window.

Exact price, quantity, quality, expiry, and refund handling are product
decisions. They live in the server-owned offer catalog and checkout copy, not
in browser input or this backlog.

## Definition of done

The new product is proven when a real Messenger user can:

1. use the free daily allowance;
2. reach exhaustion without another provider call;
3. see an honest one-time premium offer;
4. decline and continue safely;
5. pay through Mollie without exposing their Messenger identity;
6. receive exactly one credit grant after verified payment;
7. generate the promised premium images with atomic balance updates;
8. survive retries, failures, refund, deletion, and rollback without a double
   charge, double grant, lost paid balance, or privacy leak.

Production runs without OpenClaw, subscription workers, tenant portal
administration, or undocumented manual steps.

## Work rules

- Only one production outcome is active at a time: P1 through P5.
- A PR counts as progress only when it makes an acceptance point executable or
  closes it with evidence.
- Do not create additional roadmap, readiness, foundation, or follow-up
  documents. Add necessary work to the current outcome.
- Local tests are not production proof.
- Store only metadata-only smoke evidence: commit/digest, opaque request id,
  bounded outcomes, counts, timings, and rollback identity.
- Never store PSIDs, messages, prompts, media, generated images, tokens,
  checkout handoffs, or payment credentials as evidence.

## Supporting runbooks

- Architecture: `docs/architecture.md`
- Messenger setup: `docs/setup.md`
- Production smoke: `docs/production-readiness.md`
- Payment launch gates: `docs/LAUNCH_READINESS.md`
- Billing operations: `docs/BILLING_RUNBOOK.md`
- Meta review: `docs/operations/meta-app-review.md`
- Deployment and rollback: `docs/operations/production-deployments.md`
- Security: `docs/security/SECURITY.md`
