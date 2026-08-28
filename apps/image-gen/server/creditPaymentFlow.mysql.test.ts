import { createHash, randomUUID } from "node:crypto";

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { disableBillingSchedulerTenant } from "./_core/billing/billingSchedulerStore";
import {
  claimCreditPaymentCreation,
  exposeCreditPaymentCheckout,
  finalizeCreditPaymentProviderOperation,
  markCreditPaymentTransportStarted,
  type CreditCheckoutProviderScope,
} from "./_core/billing/creditCheckoutProviderStore";
import {
  CreditCheckoutReservationError,
  reserveMessengerCreditCheckout,
} from "./_core/billing/creditCheckoutReservationService";
import { deriveCreditCheckoutTestUserKeyHash } from "./_core/billing/creditCheckoutConfig";
import {
  claimCreditCheckoutBrowserSession,
  readCreditCheckoutBrowserSession,
} from "./_core/billing/creditCheckoutSession";
import { readCreditCheckoutSessionRecord } from "./_core/billing/creditCheckoutSessionStore";
import {
  CreditPaymentAdjustmentPendingError,
  applyCreditPaymentWebhookSnapshot,
  createDeterministicCreditGrantEntryId,
} from "./_core/billing/creditPaymentWebhook";
import {
  finishCreditPaymentAdjustment,
  finishCreditPaymentGrant,
  isCreditPaymentGrantComplete,
  persistCreditPaymentWebhookSnapshot,
  resolveCreditGrantFailure,
} from "./_core/billing/creditPaymentWebhookStore";
import {
  applyCreditChargebackDebit,
  applyCreditChargebackRestore,
  applyCreditRefundDebit,
  createCreditReservationHold,
  eraseCreditWalletsForPrivacySubject,
  grantCreditPurchase,
  releaseCreditReservation,
} from "./_core/billing/creditWalletStore";
import { runBillingOutboxOnce } from "./_core/billing/outboxWorker";
import type { MollieConfig } from "./_core/billing/config";
import { confirmCreditCheckoutPayment } from "./_core/billing/creditCheckoutPaymentService";
import type { MollieClient, MolliePayment } from "./_core/billing/mollieClient";
import { handleMollieWebhook } from "./_core/billing/webhookRoutes";
import { beginMessengerPrivacyErasure } from "./_core/messengerPrivacySubject";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const TEST_CHECKOUT_SECRET = "1".repeat(64);
const EXPECTED_CREDIT_ROUTINES = [
  "credit_apply_chargeback_debit",
  "credit_apply_chargeback_restore",
  "credit_apply_refund_debit",
  "credit_commit_reservation",
  "credit_consume_checkout_capability",
  "credit_create_reservation_hold",
  "credit_erase_wallet",
  "credit_expire_pristine_checkout",
  "credit_expire_reservation",
  "credit_freeze_wallet_for_review",
  "credit_grant_purchase",
  "credit_mark_reservation_provider_accepted",
  "credit_mark_reservation_transport_started",
  "credit_release_rejected_reservation",
  "credit_release_reservation",
  "credit_reserve_checkout_intent",
  "credit_scrub_terminal_reservation",
].sort();

type OwnerScope = Readonly<{
  workspaceId: number;
  actorUserId: number;
  channelConnectionId: number;
  bindingEpoch: 1;
  privacyEpoch: 1;
  userKey: string;
}>;

type CheckoutFixture = Readonly<{
  owner: OwnerScope;
  session: Awaited<ReturnType<typeof readCreditCheckoutBrowserSession>>;
  providerScope: CreditCheckoutProviderScope;
  paymentId: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function paymentId(): string {
  return `tr_${randomUUID().replaceAll("-", "")}`;
}

suite("credit payment MySQL 8.4.11 end-to-end boundary", () => {
  let connection: Connection;
  const originalEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const name of [
      "APP_BASE_URL",
      "BILLING_SUPPORT_EMAIL",
      "BILLING_NOTIFICATION_PLANE_ENABLED",
      "CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID",
      "CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS",
      "CREDIT_CHECKOUT_HMAC_SECRET",
      "MESSENGER_PAID_CREDITS_ENABLED",
      "MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD",
      "MOLLIE_BILLING_DRAIN_ENABLED",
      "MOLLIE_BILLING_ENABLED",
      "MOLLIE_CREDIT_CHECKOUT_ENABLED",
      "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
      "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
      "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
      "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
      "MOLLIE_CREDIT_WORKSPACE_ID",
      "MOLLIE_CREDENTIAL_GENERATION_ID",
      "MOLLIE_API_KEY",
      "MOLLIE_LIVE_BILLING_ENABLED",
      "MOLLIE_MODE",
      "MOLLIE_PAYMENT_WEBHOOK_URL",
    ]) {
      originalEnvironment.set(name, process.env[name]);
    }
    process.env.APP_BASE_URL = "https://app.leaderbot.live";
    process.env.BILLING_SUPPORT_EMAIL = "support@example.invalid";
    process.env.BILLING_NOTIFICATION_PLANE_ENABLED = "true";
    process.env.CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID = "k1";
    delete process.env.CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS;
    process.env.CREDIT_CHECKOUT_HMAC_SECRET = TEST_CHECKOUT_SECRET;
    process.env.MESSENGER_PAID_CREDITS_ENABLED = "true";
    process.env.MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD = "1";
    process.env.MOLLIE_BILLING_DRAIN_ENABLED = "true";
    process.env.MOLLIE_BILLING_ENABLED = "false";
    process.env.MOLLIE_CREDIT_CHECKOUT_ENABLED = "true";
    process.env.MOLLIE_CREDENTIAL_GENERATION_ID = "credit-mysql-test-v1";
    process.env.MOLLIE_API_KEY = "test_notarealkey";
    process.env.MOLLIE_LIVE_BILLING_ENABLED = "false";
    process.env.MOLLIE_MODE = "test";
    process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
      "https://app.leaderbot.live/api/webhooks/mollie/payments";

    connection = await mysql.createConnection(process.env.DATABASE_URL!);
    await connection.query("SET SESSION sql_require_primary_key=ON");
    await connection.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
  });

  afterAll(async () => {
    await connection?.end();
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function createOwnerScope(userKey = USER_A): Promise<OwnerScope> {
    const suffix = randomUUID();
    const [workspace] = await connection.query<ResultSetHeader>(
      "INSERT INTO `workspaces` (`name`,`slug`) VALUES (?,?)",
      ["Credit payment MySQL", `credit-payment-${suffix}`]
    );
    const workspaceId = workspace.insertId;
    const [actor] = await connection.query<ResultSetHeader>(
      "INSERT INTO `users` (`openId`,`role`,`loginMethod`) VALUES (?,'admin','test')",
      [`credit-payment-operator-${suffix}`]
    );
    await connection.query(
      "INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`) VALUES (?,'test',true,2)",
      [workspaceId]
    );
    const requestId = randomUUID();
    const requestFingerprint = sha256(`scheduler:${suffix}`);
    await connection.query(
      `INSERT INTO \`billing_scheduler_tenants\`
        (\`workspace_id\`,\`mode\`,\`kind\`,\`enabled\`,\`execution_epoch\`,\`operator_request_id\`,\`operator_request_fingerprint\`,\`enabled_by_user_id\`,\`enabled_at\`)
       VALUES
        (?,'test','outbox',true,2,?,?,?,CURRENT_TIMESTAMP),
        (?,'test','reconciliation',true,2,?,?,?,CURRENT_TIMESTAMP),
        (?,'test','profile_expiry',true,2,?,?,?,CURRENT_TIMESTAMP),
        (?,'test','ai_finalization',true,2,?,?,?,CURRENT_TIMESTAMP)`,
      [
        workspaceId,
        requestId,
        requestFingerprint,
        actor.insertId,
        workspaceId,
        requestId,
        requestFingerprint,
        actor.insertId,
        workspaceId,
        requestId,
        requestFingerprint,
        actor.insertId,
        workspaceId,
        requestId,
        requestFingerprint,
        actor.insertId,
      ]
    );
    const [channel] = await connection.query<ResultSetHeader>(
      "INSERT INTO `channelConnections` (`workspaceId`,`channel`,`status`,`externalId`,`bindingEpoch`) VALUES (?,'facebook_messenger','connected',?,1)",
      [workspaceId, `page-${suffix}`]
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
      [workspaceId, channel.insertId, userKey]
    );
    return {
      workspaceId,
      actorUserId: actor.insertId,
      channelConnectionId: channel.insertId,
      bindingEpoch: 1,
      privacyEpoch: 1,
      userKey,
    };
  }

  async function addPrivacySubject(
    owner: OwnerScope,
    userKey: string
  ): Promise<void> {
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
      [owner.workspaceId, owner.channelConnectionId, userKey]
    );
  }

  async function reserveAndConsumeCheckout(
    owner: OwnerScope,
    label: string
  ): Promise<CheckoutFixture> {
    process.env.MOLLIE_CREDIT_WORKSPACE_ID = String(owner.workspaceId);
    process.env.MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID = String(
      owner.channelConnectionId
    );
    process.env.MOLLIE_CREDIT_TEST_BINDING_EPOCH = String(owner.bindingEpoch);
    process.env.MOLLIE_CREDIT_TEST_PRIVACY_EPOCH = String(owner.privacyEpoch);
    process.env.MOLLIE_CREDIT_TEST_USER_KEY_HASH =
      deriveCreditCheckoutTestUserKeyHash(owner.userKey);
    const reserved = await reserveMessengerCreditCheckout({
      workspaceId: owner.workspaceId,
      channelConnectionId: owner.channelConnectionId,
      bindingEpoch: owner.bindingEpoch,
      privacyEpoch: owner.privacyEpoch,
      userKey: owner.userKey,
      requestId: `mysql-${label}-${randomUUID()}`,
    });
    const actionUrl = new URL(reserved.actionUrl);
    expect(actionUrl.origin).toBe("https://app.leaderbot.live");
    expect(actionUrl.pathname).toBe(`/credits/checkout/${reserved.intentId}`);
    expect(actionUrl.search).toBe("");
    const capability = actionUrl.hash.slice(1);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const claimed = await claimCreditCheckoutBrowserSession({
      intentId: reserved.intentId,
      capability,
    });
    expect(claimed.offer).toMatchObject({
      amount: "4.99",
      currency: "EUR",
      creditCount: 8,
      imageQuality: "medium",
      expires: false,
      automaticRenewal: false,
      refundPolicyId: "premium_image_credit_refund",
      refundPolicyVersion: 1,
    });
    await expect(
      claimCreditCheckoutBrowserSession({
        intentId: reserved.intentId,
        capability,
      })
    ).rejects.toThrow("Credit checkout session is unavailable");

    const session = await readCreditCheckoutBrowserSession(
      claimed.cookieValue,
      { requireUnexpired: true }
    );
    const record = session.record;
    expect(record.checkoutCapabilityConsumedAt).toBeInstanceOf(Date);
    expect(record.checkoutCapabilitySessionNonceHash).toMatch(/^[0-9a-f]{64}$/);
    const providerScope = {
      workspaceId: record.workspaceId,
      mode: record.mode,
      channelConnectionId: record.messengerChannelConnectionId!,
      bindingEpoch: record.messengerBindingEpoch!,
      privacyEpoch: record.messengerPrivacyEpoch!,
      userKey: record.messengerSenderUserKey!,
      walletId: record.creditWalletId!,
      financialSubjectRef: record.creditFinancialSubjectRef!,
      intentId: record.intentId,
      authorizationEpoch: record.authorizationEpoch,
      sessionNonceHash: record.checkoutCapabilitySessionNonceHash!,
      metadataHash: record.creditMetadataHash!,
      offerId: "premium_images_8_medium_v1",
      offerVersion: 1,
    } satisfies CreditCheckoutProviderScope;
    return {
      owner,
      session,
      providerScope,
      paymentId: paymentId(),
    };
  }

  function molliePayment(
    fixture: CheckoutFixture,
    status: "open" | "paid"
  ): MolliePayment {
    return {
      resource: "payment",
      id: fixture.paymentId,
      mode: "test",
      status,
      amount: { currency: "EUR", value: "4.99" },
      description: "Leaderbot - 8 premium beeldcredits",
      method: status === "paid" ? "bancontact" : null,
      sequenceType: "oneoff",
      customerId: null,
      mandateId: null,
      subscriptionId: null,
      metadata: {
        billingIntentId: fixture.providerScope.intentId,
        purpose: "premium_image_credits",
        version: 1,
        metadataHash: fixture.providerScope.metadataHash,
      },
      createdAt: "2026-08-28T09:00:00.000Z",
      ...(status === "paid"
        ? { paidAt: "2026-08-28T09:01:00.000Z" }
        : {
            _links: {
              checkout: {
                href: `https://www.mollie.com/checkout/select-method/${fixture.paymentId}`,
              },
            },
          }),
    };
  }

  async function claimTransport(fixture: CheckoutFixture) {
    const claim = await claimCreditPaymentCreation(fixture.providerScope);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed)
      throw new Error("credit provider claim was not acquired");
    const operation = { ...fixture.providerScope, ...claim };
    await expect(markCreditPaymentTransportStarted(operation)).resolves.toBe(
      true
    );
    return operation;
  }

  async function openCheckout(fixture: CheckoutFixture): Promise<void> {
    const operation = await claimTransport(fixture);
    await expect(
      finalizeCreditPaymentProviderOperation({
        ...operation,
        outcome: {
          kind: "known_succeeded",
          paymentId: fixture.paymentId,
        },
      })
    ).resolves.toMatchObject({ recorded: true, authorized: true });
    await expect(
      exposeCreditPaymentCheckout({
        ...operation,
        paymentId: fixture.paymentId,
      })
    ).resolves.toBe(true);
  }

  async function openPeer(): Promise<Connection> {
    const peer = await mysql.createConnection(process.env.DATABASE_URL!);
    await peer.query("SET SESSION sql_require_primary_key=ON");
    await peer.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await peer.query("SET SESSION innodb_lock_wait_timeout=5");
    return peer;
  }

  async function runBehindBarrier<T>(
    lockSql: string,
    lockArguments: readonly unknown[],
    actions: readonly [
      (peer: Connection) => Promise<T>,
      (peer: Connection) => Promise<T>,
    ],
    expectedWaiters = 2
  ): Promise<readonly [PromiseSettledResult<T>, PromiseSettledResult<T>]> {
    const blocker = await openPeer();
    const observer = await openPeer();
    const first = await openPeer();
    const second = await openPeer();
    let pending: readonly [Promise<T>, Promise<T>] | undefined;
    try {
      await blocker.beginTransaction();
      const [[identity]] = await blocker.query<RowDataPacket[]>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      await blocker.query(lockSql, lockArguments);
      pending = [actions[0](first), actions[1](second)];
      const deadline = Date.now() + 3_000;
      let waiters = 0;
      while (Date.now() < deadline && waiters < expectedWaiters) {
        const [[row]] = await observer.query<RowDataPacket[]>(
          `SELECT COUNT(DISTINCT waits.REQUESTING_THREAD_ID) AS waiters
           FROM performance_schema.data_lock_waits AS waits
           JOIN performance_schema.threads AS blocker_thread
             ON blocker_thread.THREAD_ID=waits.BLOCKING_THREAD_ID
           WHERE blocker_thread.PROCESSLIST_ID=?`,
          [identity.connectionId]
        );
        waiters = Number(row.waiters);
      }
      expect(waiters).toBe(expectedWaiters);
      await blocker.commit();
      return (await Promise.allSettled(pending)) as readonly [
        PromiseSettledResult<T>,
        PromiseSettledResult<T>,
      ];
    } finally {
      await blocker.rollback().catch(() => undefined);
      if (pending) await Promise.allSettled(pending);
      await Promise.all([
        blocker.end(),
        observer.end(),
        first.end(),
        second.end(),
      ]);
    }
  }

  async function waitForLockWait(
    observer: Connection,
    blockingProcessId: number,
    requestingProcessId?: number
  ): Promise<number> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [rows] = await observer.query<RowDataPacket[]>(
        `SELECT requester_thread.PROCESSLIST_ID AS requestingProcessId
         FROM performance_schema.data_lock_waits AS waits
         JOIN performance_schema.threads AS blocker_thread
           ON blocker_thread.THREAD_ID=waits.BLOCKING_THREAD_ID
         JOIN performance_schema.threads AS requester_thread
           ON requester_thread.THREAD_ID=waits.REQUESTING_THREAD_ID
         WHERE blocker_thread.PROCESSLIST_ID=?
           AND (? IS NULL OR requester_thread.PROCESSLIST_ID=?)
         LIMIT 1`,
        [
          blockingProcessId,
          requestingProcessId ?? null,
          requestingProcessId ?? null,
        ]
      );
      const observed = Number(rows[0]?.requestingProcessId);
      if (Number.isSafeInteger(observed) && observed > 0) return observed;
    }
    throw new Error("expected MySQL row-lock wait was not observed");
  }

  async function walletState(walletId: string) {
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
      [walletId]
    );
    return wallet;
  }

  async function proveAdjustmentFreezeWinsBeforeConcurrentHold(
    kind: "refund" | "chargeback"
  ): Promise<void> {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(
      owner,
      `atomic-${kind}-freeze`
    );
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toBe("processed");

    const providerEffectId = `${kind === "refund" ? "re" : "chb"}_${randomUUID().replaceAll("-", "")}`;
    const adjusted: MolliePayment =
      kind === "refund"
        ? {
            ...paid,
            amountRefunded: { currency: "EUR", value: "4.99" },
            _embedded: {
              refunds: [
                {
                  id: providerEffectId,
                  status: "refunded",
                  amount: { currency: "EUR", value: "4.99" },
                  createdAt: "2026-08-28T13:00:00.000Z",
                },
              ],
              chargebacks: [],
            },
          }
        : {
            ...paid,
            _embedded: {
              refunds: [],
              chargebacks: [
                {
                  id: providerEffectId,
                  amount: { currency: "EUR", value: "4.99" },
                  createdAt: "2026-08-28T13:00:00.000Z",
                },
              ],
            },
          };

    const blocker = await openPeer();
    const observer = await openPeer();
    const holdPeer = await openPeer();
    let adjustmentPromise:
      ReturnType<typeof persistCreditPaymentWebhookSnapshot> | undefined;
    let holdPromise: ReturnType<Connection["query"]> | undefined;
    try {
      await blocker.beginTransaction();
      const [[blockerIdentity]] = await blocker.query<RowDataPacket[]>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      await blocker.query(
        "SELECT `status` FROM `credit_wallets` WHERE BINARY `wallet_id`=BINARY ? FOR UPDATE",
        [fixture.providerScope.walletId]
      );

      adjustmentPromise = persistCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: adjusted,
      });
      const adjustmentProcessId = await waitForLockWait(
        observer,
        Number(blockerIdentity.connectionId)
      );

      const [[holdIdentity]] = await holdPeer.query<RowDataPacket[]>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      const reservationId = randomUUID();
      holdPromise = holdPeer.query(
        "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
        [
          owner.workspaceId,
          owner.channelConnectionId,
          owner.userKey,
          fixture.providerScope.walletId,
          fixture.providerScope.financialSubjectRef,
          reservationId,
          sha256(`atomic-${kind}-generation`),
          sha256(`atomic-${kind}-owner`),
          1,
          randomUUID(),
          sha256(`atomic-${kind}-hold`),
        ]
      );
      await waitForLockWait(
        observer,
        adjustmentProcessId,
        Number(holdIdentity.connectionId)
      );

      await blocker.commit();
      const [adjustmentOutcome, holdOutcome] = await Promise.allSettled([
        adjustmentPromise,
        holdPromise,
      ]);
      expect(adjustmentOutcome.status).toBe("fulfilled");
      if (adjustmentOutcome.status !== "fulfilled") {
        throw adjustmentOutcome.reason;
      }
      expect(adjustmentOutcome.value).toMatchObject({
        result: "adjustment_pending",
      });
      expect(holdOutcome.status).toBe("rejected");

      const [[state]] = await connection.query<RowDataPacket[]>(
        `SELECT
          (SELECT \`status\` FROM \`credit_wallets\`
            WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
          (SELECT \`credit_balance\` FROM \`credit_wallets\`
            WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
          (SELECT \`reserved_credits\` FROM \`credit_wallets\`
            WHERE BINARY \`wallet_id\`=BINARY ?) AS reserved,
          (SELECT COUNT(*) FROM \`credit_reservations\`
            WHERE BINARY \`reservation_id\`=BINARY ?) AS reservations,
          (SELECT COUNT(*) FROM \`billing_outbox\`
            WHERE \`workspace_id\`=? AND \`mode\`='test'
              AND \`event_type\`='credit_adjustment_retry'
              AND \`status\`='pending') AS retries`,
        [
          fixture.providerScope.walletId,
          fixture.providerScope.walletId,
          fixture.providerScope.walletId,
          reservationId,
          owner.workspaceId,
        ]
      );
      expect({
        walletStatus: state.walletStatus,
        balance: Number(state.balance),
        reserved: Number(state.reserved),
        reservations: Number(state.reservations),
        retries: Number(state.retries),
      }).toEqual({
        walletStatus: kind === "refund" ? "active" : "frozen",
        balance: 8,
        reserved: 0,
        reservations: 0,
        retries: 1,
      });
    } finally {
      await blocker.rollback().catch(() => undefined);
      await Promise.allSettled(
        [adjustmentPromise, holdPromise].filter(
          (value): value is Promise<unknown> => value !== undefined
        )
      );
      await Promise.all([blocker.end(), observer.end(), holdPeer.end()]);
    }
  }

  it("runs on an exact fresh 0000-to-0018 MySQL 8.4.11 bootstrap", async () => {
    const [[server]] = await connection.query<RowDataPacket[]>(
      "SELECT VERSION() AS version,@@innodb_page_size AS pageSize,@@GLOBAL.binlog_format AS binlogFormat"
    );
    expect(server.version).toBe("8.4.11");
    expect([8192, 16384]).toContain(Number(server.pageSize));
    expect(server.binlogFormat).toBe("ROW");

    const [[history]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count,MIN(`created_at`) AS firstMigration,MAX(`created_at`) AS lastMigration FROM `__drizzle_migrations`"
    );
    expect(Number(history.count)).toBe(19);
    expect(Number(history.firstMigration)).toBe(1771791967247);
    expect(Number(history.lastMigration)).toBe(1787886000000);

    const [routines] = await connection.query<RowDataPacket[]>(
      "SELECT `ROUTINE_NAME` AS name FROM information_schema.ROUTINES WHERE `ROUTINE_SCHEMA`=DATABASE() AND `ROUTINE_TYPE`='PROCEDURE' AND `ROUTINE_NAME` LIKE 'credit\\_%' ESCAPE '\\\\' ORDER BY `ROUTINE_NAME`"
    );
    expect(routines.map(row => String(row.name)).sort()).toEqual(
      EXPECTED_CREDIT_ROUTINES
    );
  });

  it("consumes one browser capability and grants exactly eight customerless one-off credits once", async () => {
    const owner = await createOwnerScope();
    await addPrivacySubject(owner, USER_B);
    const fixture = await reserveAndConsumeCheckout(owner, "happy");
    const providerCalls: MolliePayment[] = [];
    const creationPayment = molliePayment(fixture, "open");
    const mollieConfig = {
      apiKey: "test_not-a-real-key",
      mode: "test",
      paymentWebhookUrl:
        "https://app.leaderbot.live/api/webhooks/mollie/payments",
      appBaseUrl: "https://app.leaderbot.live",
      billingSupportEmail: "support@example.invalid",
      liveBillingEnabled: false,
    } satisfies MollieConfig;
    const checkout = await confirmCreditCheckoutPayment(fixture.session, {
      mollieConfig: () => mollieConfig,
      pilotConfig: () => ({
        checkoutEnabled: true,
        paidCreditsEnabled: true,
        paidImageProviderMaxCostUsd: 1,
        workspaceId: owner.workspaceId,
        mode: "test",
        testPilotScope: {
          channelConnectionId: owner.channelConnectionId,
          bindingEpoch: owner.bindingEpoch,
          privacyEpoch: owner.privacyEpoch,
          userKeyHash: deriveCreditCheckoutTestUserKeyHash(owner.userKey),
        },
      }),
      createClient: () => ({
        createCreditPayment: async input => {
          expect(input).toMatchObject({
            amount: { currency: "EUR", value: "4.99" },
            description: "Leaderbot - 8 premium beeldcredits",
            billingIntentId: fixture.providerScope.intentId,
            metadataHash: fixture.providerScope.metadataHash,
            idempotencyKey: `credit-payment:${fixture.providerScope.intentId}`,
          });
          providerCalls.push(creationPayment);
          return creationPayment;
        },
        getPayment: async paymentId =>
          paymentId === creationPayment.id
            ? creationPayment
            : Promise.reject(new Error("unexpected payment recovery")),
        getHostedCheckoutUrl: payment => payment._links?.checkout?.href ?? "",
      }),
      claim: claimCreditPaymentCreation,
      markTransportStarted: markCreditPaymentTransportStarted,
      finalize: finalizeCreditPaymentProviderOperation,
      expose: exposeCreditPaymentCheckout,
    });
    expect(checkout.checkoutUrl).toBe(
      `https://www.mollie.com/checkout/select-method/${fixture.paymentId}`
    );
    expect(providerCalls).toEqual([creationPayment]);
    expect(creationPayment).toMatchObject({
      sequenceType: "oneoff",
      customerId: null,
      subscriptionId: null,
      mandateId: null,
    });

    const completionScope = {
      workspaceId: owner.workspaceId,
      mode: "test" as const,
      intentId: fixture.providerScope.intentId,
      providerPaymentId: fixture.paymentId,
      walletId: fixture.providerScope.walletId,
      metadataHash: fixture.providerScope.metadataHash,
    };
    await expect(isCreditPaymentGrantComplete(completionScope)).resolves.toBe(
      false
    );

    const paid = molliePayment(fixture, "paid");
    const persisted = await persistCreditPaymentWebhookSnapshot({
      webhookPaymentId: fixture.paymentId,
      expectedMode: "test",
      payment: paid,
    });
    expect(persisted.result).toBe("grant_pending");
    if (persisted.result !== "grant_pending") {
      throw new Error("credit webhook did not reach the grant boundary");
    }
    await expect(isCreditPaymentGrantComplete(completionScope)).resolves.toBe(
      false
    );
    const entryId = createDeterministicCreditGrantEntryId(persisted.grant);
    await expect(
      grantCreditPurchase({
        workspaceId: persisted.grant.workspaceId,
        mode: persisted.grant.mode,
        channelConnectionId: persisted.grant.channelConnectionId,
        bindingEpoch: persisted.grant.bindingEpoch,
        privacyEpoch: persisted.grant.privacyEpoch,
        userKey: persisted.grant.userKey,
        walletId: persisted.grant.walletId,
        financialSubjectRef: persisted.grant.financialSubjectRef,
        intentId: persisted.grant.intentId,
        providerPaymentId: persisted.grant.providerPaymentId,
        entryId,
        evidenceHash: persisted.grant.evidenceHash,
      })
    ).resolves.toMatchObject({ result: "applied", entryId });
    await expect(isCreditPaymentGrantComplete(completionScope)).resolves.toBe(
      true
    );
    await finishCreditPaymentGrant(persisted.grant);
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toBe("duplicate");

    expect(await walletState(fixture.providerScope.walletId)).toMatchObject({
      status: "active",
      balance: 8,
      reserved: 0,
    });
    const [[effects]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT COUNT(*) FROM \`credit_ledger\` WHERE \`wallet_id\`=? AND \`entry_kind\`='purchase_grant') AS grants,
        (SELECT COUNT(*) FROM \`webhook_deliveries\` WHERE \`workspace_id\`=? AND \`mollie_resource_id\`=? AND \`processing_result\`='credit_granted' AND \`processed_at\` IS NOT NULL) AS deliveries,
        (SELECT COUNT(*) FROM \`billing_customers\` WHERE \`workspace_id\`=?) AS customers,
        (SELECT COUNT(*) FROM \`billing_subscriptions\` WHERE \`workspace_id\`=?) AS subscriptions`,
      [
        fixture.providerScope.walletId,
        owner.workspaceId,
        fixture.paymentId,
        owner.workspaceId,
        owner.workspaceId,
      ]
    );
    expect({
      grants: Number(effects.grants),
      deliveries: Number(effects.deliveries),
      customers: Number(effects.customers),
      subscriptions: Number(effects.subscriptions),
    }).toEqual({ grants: 1, deliveries: 1, customers: 0, subscriptions: 0 });
    const [[provider]] = await connection.query<RowDataPacket[]>(
      "SELECT `provider_customer_id` AS customerId FROM `billing_provider_operations` WHERE `workspace_id`=? AND `intent_id`=?",
      [owner.workspaceId, fixture.providerScope.intentId]
    );
    expect(provider.customerId).toBeNull();

    await expect(
      reserveMessengerCreditCheckout({
        workspaceId: owner.workspaceId,
        channelConnectionId: owner.channelConnectionId,
        bindingEpoch: owner.bindingEpoch,
        privacyEpoch: owner.privacyEpoch,
        userKey: USER_B,
        requestId: `mysql-cross-scope-${randomUUID()}`,
      })
    ).rejects.toBeInstanceOf(CreditCheckoutReservationError);
    const [[otherUser]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS wallets,COALESCE(SUM(`credit_balance`),0) AS balance FROM `credit_wallets` WHERE `workspace_id`=? AND BINARY `current_user_key_hash`=BINARY ?",
      [owner.workspaceId, USER_B]
    );
    expect({
      wallets: Number(otherUser.wallets),
      balance: Number(otherUser.balance),
    }).toEqual({ wallets: 0, balance: 0 });
  });

  it("keeps an early webhook customerless after finalize and recovers exposure without another POST", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "checkout-recovery");
    const operation = await claimTransport(fixture);
    await expect(
      finalizeCreditPaymentProviderOperation({
        ...operation,
        outcome: { kind: "known_succeeded", paymentId: fixture.paymentId },
      })
    ).resolves.toMatchObject({ recorded: true, authorized: true });

    const providerPayment = molliePayment(fixture, "open");
    const earlyWebhookGets: string[] = [];
    await expect(
      handleMollieWebhook(
        { id: fixture.paymentId },
        {
          createClient: () =>
            ({
              getPayment: async paymentId => {
                earlyWebhookGets.push(paymentId);
                return providerPayment;
              },
            }) as unknown as MollieClient,
        }
      )
    ).resolves.toBe("unknown");
    expect(earlyWebhookGets).toEqual([fixture.paymentId]);

    const [[earlyState]] = await connection.query<RowDataPacket[]>(
      `SELECT intent.\`status\` AS intentStatus,intent.\`mollie_payment_id\` AS paymentId,
        (intent.\`url_exposed_at\` IS NOT NULL) AS exposed,
        operation.\`state\` AS operationState,
        operation.\`provider_resource_id\` AS providerResourceId,
        (SELECT COUNT(*) FROM \`billing_webhook_routes\` route
          WHERE route.\`mode\`='test' AND BINARY route.\`mollie_payment_id\`=BINARY ?) AS routeCount
       FROM \`billing_intents\` intent
       JOIN \`billing_provider_operations\` operation
         ON operation.\`workspace_id\`=intent.\`workspace_id\`
        AND operation.\`mode\`=intent.\`mode\`
        AND BINARY operation.\`intent_id\`=BINARY intent.\`intent_id\`
       WHERE intent.\`workspace_id\`=? AND BINARY intent.\`intent_id\`=BINARY ?`,
      [fixture.paymentId, owner.workspaceId, fixture.providerScope.intentId]
    );
    expect({
      intentStatus: earlyState.intentStatus,
      paymentId: earlyState.paymentId,
      exposed: Number(earlyState.exposed),
      operationState: earlyState.operationState,
      providerResourceId: earlyState.providerResourceId,
      routeCount: Number(earlyState.routeCount),
    }).toEqual({
      intentStatus: "creating_payment",
      paymentId: null,
      exposed: 0,
      operationState: "succeeded",
      providerResourceId: fixture.paymentId,
      routeCount: 0,
    });

    const providerGets: string[] = [];
    const providerPosts: unknown[] = [];
    const mollieConfig = {
      apiKey: "test_not-a-real-key",
      mode: "test",
      paymentWebhookUrl:
        "https://app.leaderbot.live/api/webhooks/mollie/payments",
      appBaseUrl: "https://app.leaderbot.live",
      billingSupportEmail: "support@example.invalid",
      liveBillingEnabled: false,
    } satisfies MollieConfig;
    const firstRecoveryAt = new Date(Date.now() + 61_000);
    const recover = (recoveryNow: Date) =>
      confirmCreditCheckoutPayment(fixture.session, {
        mollieConfig: () => mollieConfig,
        pilotConfig: () => ({
          checkoutEnabled: true,
          paidCreditsEnabled: true,
          paidImageProviderMaxCostUsd: 1,
          workspaceId: owner.workspaceId,
          mode: "test",
          testPilotScope: {
            channelConnectionId: owner.channelConnectionId,
            bindingEpoch: owner.bindingEpoch,
            privacyEpoch: owner.privacyEpoch,
            userKeyHash: deriveCreditCheckoutTestUserKeyHash(owner.userKey),
          },
        }),
        createClient: () => ({
          createCreditPayment: async input => {
            providerPosts.push(input);
            throw new Error("recovery attempted a second payment creation");
          },
          getPayment: async paymentId => {
            providerGets.push(paymentId);
            return providerPayment;
          },
          getHostedCheckoutUrl: payment => payment._links?.checkout?.href ?? "",
        }),
        claim: scope => claimCreditPaymentCreation(scope, recoveryNow),
        markTransportStarted: markCreditPaymentTransportStarted,
        finalize: finalizeCreditPaymentProviderOperation,
        expose: exposeCreditPaymentCheckout,
      });

    await expect(recover(firstRecoveryAt)).resolves.toEqual({
      checkoutUrl: providerPayment._links?.checkout?.href,
    });
    const secondRecoveryAt = new Date(firstRecoveryAt.getTime() + 61_000);
    await expect(recover(secondRecoveryAt)).resolves.toEqual({
      checkoutUrl: providerPayment._links?.checkout?.href,
    });

    expect(providerPosts).toEqual([]);
    expect(providerGets).toEqual([fixture.paymentId, fixture.paymentId]);
    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT intent.\`status\` AS intentStatus,intent.\`mollie_payment_id\` AS paymentId,
        (intent.\`url_exposed_at\` IS NOT NULL) AS exposed,
        operation.\`state\` AS operationState,
        (SELECT COUNT(*) FROM \`billing_webhook_routes\` route
          WHERE route.\`mode\`='test' AND BINARY route.\`mollie_payment_id\`=BINARY ?) AS routeCount
       FROM \`billing_intents\` intent
       JOIN \`billing_provider_operations\` operation
         ON operation.\`workspace_id\`=intent.\`workspace_id\`
        AND operation.\`mode\`=intent.\`mode\`
        AND BINARY operation.\`intent_id\`=BINARY intent.\`intent_id\`
       WHERE intent.\`workspace_id\`=? AND BINARY intent.\`intent_id\`=BINARY ?`,
      [fixture.paymentId, owner.workspaceId, fixture.providerScope.intentId]
    );
    expect({
      intentStatus: state.intentStatus,
      paymentId: state.paymentId,
      exposed: Number(state.exposed),
      operationState: state.operationState,
      routeCount: Number(state.routeCount),
    }).toEqual({
      intentStatus: "open",
      paymentId: fixture.paymentId,
      exposed: 1,
      operationState: "succeeded",
      routeCount: 1,
    });
  });

  it("does not regress a terminal intent when an older open snapshot arrives later", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "stale-open");
    await openCheckout(fixture);

    const canceled: MolliePayment = {
      ...molliePayment(fixture, "open"),
      status: "canceled",
      method: "bancontact",
      canceledAt: "2026-08-28T09:02:00.000Z",
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: canceled,
      })
    ).resolves.toBe("processed");

    const staleOpen: MolliePayment = {
      ...molliePayment(fixture, "open"),
      method: "bancontact",
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: staleOpen,
      })
    ).resolves.toBe("processed");

    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT intent.\`status\` AS intentStatus,ledger.\`status\` AS ledgerStatus,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test'
            AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_snapshot_preserved'
            AND \`processed_at\` IS NOT NULL) AS preservedDeliveries
       FROM \`billing_intents\` intent
       JOIN \`payment_ledger\` ledger
         ON ledger.\`workspace_id\`=intent.\`workspace_id\`
        AND ledger.\`mode\`=intent.\`mode\`
        AND BINARY ledger.\`mollie_payment_id\`=BINARY intent.\`mollie_payment_id\`
       WHERE intent.\`workspace_id\`=? AND BINARY intent.\`intent_id\`=BINARY ?`,
      [
        owner.workspaceId,
        fixture.paymentId,
        owner.workspaceId,
        fixture.providerScope.intentId,
      ]
    );
    expect({
      intentStatus: state.intentStatus,
      ledgerStatus: state.ledgerStatus,
      preservedDeliveries: Number(state.preservedDeliveries),
    }).toEqual({
      intentStatus: "canceled",
      ledgerStatus: "canceled",
      preservedDeliveries: 1,
    });
  });

  it("recovers a durable pending grant from a later distinct paid snapshot", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "grant-recovery");
    await openCheckout(fixture);

    const firstPaid = molliePayment(fixture, "paid");
    const interrupted = await persistCreditPaymentWebhookSnapshot({
      webhookPaymentId: fixture.paymentId,
      expectedMode: "test",
      payment: firstPaid,
    });
    expect(interrupted.result).toBe("grant_pending");
    if (interrupted.result !== "grant_pending") {
      throw new Error("first paid snapshot did not reach pending grant state");
    }

    const laterPaid: MolliePayment = {
      ...firstPaid,
      amountRefunded: { currency: "EUR", value: "0.00" },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: laterPaid,
      })
    ).resolves.toBe("processed");

    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT intent.\`status\` AS intentStatus,ledger.\`status\` AS ledgerStatus,
        ledger.\`paid_effect_applied\` AS paidEffectApplied,
        wallet.\`credit_balance\` AS balance,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY wallet.\`wallet_id\`
            AND \`entry_kind\`='purchase_grant') AS grants,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test'
            AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_granted'
            AND \`processed_at\` IS NOT NULL) AS grantedDeliveries,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test'
            AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_snapshot_preserved'
            AND \`processed_at\` IS NOT NULL) AS preservedDeliveries,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test'
            AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_grant_pending'
            AND \`processed_at\` IS NULL) AS pendingDeliveries
       FROM \`billing_intents\` intent
       JOIN \`payment_ledger\` ledger
         ON ledger.\`workspace_id\`=intent.\`workspace_id\`
        AND ledger.\`mode\`=intent.\`mode\`
        AND BINARY ledger.\`mollie_payment_id\`=BINARY intent.\`mollie_payment_id\`
       JOIN \`credit_wallets\` wallet
         ON BINARY wallet.\`wallet_id\`=BINARY intent.\`credit_wallet_id\`
        AND wallet.\`workspace_id\`=intent.\`workspace_id\`
        AND wallet.\`mode\`=intent.\`mode\`
       WHERE intent.\`workspace_id\`=? AND BINARY intent.\`intent_id\`=BINARY ?`,
      [
        owner.workspaceId,
        fixture.paymentId,
        owner.workspaceId,
        fixture.paymentId,
        owner.workspaceId,
        fixture.paymentId,
        owner.workspaceId,
        fixture.providerScope.intentId,
      ]
    );
    expect({
      intentStatus: state.intentStatus,
      ledgerStatus: state.ledgerStatus,
      paidEffectApplied: Number(state.paidEffectApplied),
      balance: Number(state.balance),
      grants: Number(state.grants),
      grantedDeliveries: Number(state.grantedDeliveries),
      preservedDeliveries: Number(state.preservedDeliveries),
      pendingDeliveries: Number(state.pendingDeliveries),
    }).toEqual({
      intentStatus: "paid",
      ledgerStatus: "paid",
      paidEffectApplied: 1,
      balance: 8,
      grants: 1,
      grantedDeliveries: 1,
      preservedDeliveries: 1,
      pendingDeliveries: 0,
    });
  });

  it("applies one exact provider-confirmed full refund through the webhook runtime exactly once", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "full-refund");
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");

    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toBe("processed");
    expect(await walletState(fixture.providerScope.walletId)).toMatchObject({
      status: "active",
      balance: 8,
      reserved: 0,
    });

    const failedRefund: MolliePayment = {
      ...paid,
      amountRefunded: { currency: "EUR", value: "0.00" },
      _embedded: {
        refunds: [
          {
            id: `re_${randomUUID().replaceAll("-", "")}`,
            status: "failed",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
        chargebacks: [],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: failedRefund,
      })
    ).resolves.toBe("duplicate");

    const pendingRefund: MolliePayment = {
      ...paid,
      amountRefunded: { currency: "EUR", value: "0.00" },
      _embedded: {
        refunds: [
          {
            id: `re_${randomUUID().replaceAll("-", "")}`,
            status: "pending",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
        chargebacks: [],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: pendingRefund,
      })
    ).resolves.toBe("processed");

    const [[beforeCompletedRefund]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT \`status\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
        (SELECT \`credit_balance\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='manual_review'
            AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.intentId'))=?) AS manualReviews,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_refund_pending' AND \`processed_at\` IS NOT NULL) AS pendingRefundDeliveries`,
      [
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        owner.workspaceId,
        fixture.providerScope.intentId,
        owner.workspaceId,
        fixture.paymentId,
      ]
    );
    expect({
      walletStatus: beforeCompletedRefund.walletStatus,
      balance: Number(beforeCompletedRefund.balance),
      refundDebits: Number(beforeCompletedRefund.refundDebits),
      manualReviews: Number(beforeCompletedRefund.manualReviews),
      pendingRefundDeliveries: Number(
        beforeCompletedRefund.pendingRefundDeliveries
      ),
    }).toEqual({
      walletStatus: "active",
      balance: 8,
      refundDebits: 0,
      manualReviews: 0,
      pendingRefundDeliveries: 1,
    });

    const refundId = `re_${randomUUID().replaceAll("-", "")}`;
    const secondRefundId = `re_${randomUUID().replaceAll("-", "")}`;
    const refundedPayment: MolliePayment = {
      ...paid,
      amountRefunded: { currency: "EUR", value: "4.99" },
      _embedded: {
        refunds: [
          {
            id: refundId,
            status: "refunded",
            amount: { currency: "EUR", value: "2.00" },
            createdAt: "2026-08-28T10:00:00.000Z",
          },
          {
            id: secondRefundId,
            status: "refunded",
            amount: { currency: "EUR", value: "2.99" },
            createdAt: "2026-08-28T10:00:01.000Z",
          },
        ],
        chargebacks: [],
      },
    };
    let observedPendingBeforeDebit = false;

    await expect(
      applyCreditPaymentWebhookSnapshot(
        {
          webhookPaymentId: fixture.paymentId,
          expectedMode: "test",
          payment: refundedPayment,
        },
        {
          persist: persistCreditPaymentWebhookSnapshot,
          grant: grantCreditPurchase,
          finish: finishCreditPaymentGrant,
          resolveGrantFailure: resolveCreditGrantFailure,
          refundDebit: async input => {
            const [[before]] = await connection.query<RowDataPacket[]>(
              `SELECT
                (SELECT COUNT(*) FROM \`webhook_deliveries\`
                  WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
                    AND \`processing_result\`='credit_adjustment_pending' AND \`processed_at\` IS NULL) AS pendingDeliveries,
                (SELECT COUNT(*) FROM \`credit_ledger\`
                  WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
                (SELECT \`status\` FROM \`credit_wallets\`
                  WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
                (SELECT \`refund_adjustment_entry_id\` FROM \`credit_wallets\`
                  WHERE BINARY \`wallet_id\`=BINARY ?) AS refundAdjustmentEntryId,
                (SELECT \`credit_balance\` FROM \`credit_wallets\`
                  WHERE BINARY \`wallet_id\`=BINARY ?) AS balance`,
              [
                owner.workspaceId,
                fixture.paymentId,
                fixture.providerScope.walletId,
                fixture.providerScope.walletId,
                fixture.providerScope.walletId,
                fixture.providerScope.walletId,
              ]
            );
            expect({
              pendingDeliveries: Number(before.pendingDeliveries),
              refundDebits: Number(before.refundDebits),
              walletStatus: before.walletStatus,
              refundAdjustmentEntryId: before.refundAdjustmentEntryId,
              balance: Number(before.balance),
            }).toEqual({
              pendingDeliveries: 1,
              refundDebits: 0,
              walletStatus: "active",
              refundAdjustmentEntryId: input.entryId,
              balance: 8,
            });
            observedPendingBeforeDebit = true;

            const outcome = await applyCreditRefundDebit(input);
            const [[afterRoutine]] = await connection.query<RowDataPacket[]>(
              `SELECT
                (SELECT COUNT(*) FROM \`webhook_deliveries\`
                  WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
                    AND \`processing_result\`='credit_adjustment_pending' AND \`processed_at\` IS NULL) AS pendingDeliveries,
                (SELECT COUNT(*) FROM \`credit_ledger\`
                  WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
                (SELECT \`credit_balance\` FROM \`credit_wallets\`
                  WHERE BINARY \`wallet_id\`=BINARY ?) AS balance`,
              [
                owner.workspaceId,
                fixture.paymentId,
                fixture.providerScope.walletId,
                fixture.providerScope.walletId,
              ]
            );
            expect({
              pendingDeliveries: Number(afterRoutine.pendingDeliveries),
              refundDebits: Number(afterRoutine.refundDebits),
              balance: Number(afterRoutine.balance),
            }).toEqual({ pendingDeliveries: 1, refundDebits: 1, balance: 0 });
            return outcome;
          },
          chargebackDebit: applyCreditChargebackDebit,
          chargebackRestore: applyCreditChargebackRestore,
          finishAdjustment: finishCreditPaymentAdjustment,
        }
      )
    ).resolves.toBe("processed");
    expect(observedPendingBeforeDebit).toBe(true);

    const [[completed]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT \`status\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
        (SELECT \`credit_balance\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
        (SELECT COALESCE(SUM(\`balance_delta\`),0) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDelta,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit'
            AND JSON_LENGTH(\`provider_effect_evidence\`)=2
            AND JSON_SEARCH(\`provider_effect_evidence\`,'one',?) IS NOT NULL
            AND JSON_SEARCH(\`provider_effect_evidence\`,'one',?) IS NOT NULL) AS exactEvidence,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_refund_debited' AND \`processed_at\` IS NOT NULL) AS completedDeliveries,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_adjustment_pending' AND \`processed_at\` IS NULL) AS pendingDeliveries`,
      [
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        refundId,
        secondRefundId,
        owner.workspaceId,
        fixture.paymentId,
        owner.workspaceId,
        fixture.paymentId,
      ]
    );
    expect({
      walletStatus: completed.walletStatus,
      balance: Number(completed.balance),
      refundDebits: Number(completed.refundDebits),
      refundDelta: Number(completed.refundDelta),
      exactEvidence: Number(completed.exactEvidence),
      completedDeliveries: Number(completed.completedDeliveries),
      pendingDeliveries: Number(completed.pendingDeliveries),
    }).toEqual({
      walletStatus: "active",
      balance: 0,
      refundDebits: 1,
      refundDelta: -8,
      exactEvidence: 1,
      completedDeliveries: 1,
      pendingDeliveries: 0,
    });

    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: refundedPayment,
      })
    ).resolves.toBe("duplicate");
    const [[replayed]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT \`credit_balance\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_refund_debited' AND \`processed_at\` IS NOT NULL) AS completedDeliveries`,
      [
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        owner.workspaceId,
        fixture.paymentId,
      ]
    );
    expect({
      balance: Number(replayed.balance),
      refundDebits: Number(replayed.refundDebits),
      completedDeliveries: Number(replayed.completedDeliveries),
    }).toEqual({ balance: 0, refundDebits: 1, completedDeliveries: 1 });

    const laterRefundSnapshot: MolliePayment = {
      ...refundedPayment,
      _embedded: {
        refunds: [
          ...refundedPayment._embedded!.refunds!,
          {
            id: `re_${randomUUID().replaceAll("-", "")}`,
            status: "failed",
            amount: { currency: "EUR", value: "1.00" },
          },
        ],
        chargebacks: [],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: laterRefundSnapshot,
      })
    ).resolves.toBe("duplicate");
    const [[laterReplay]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='manual_review'
            AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.intentId'))=?) AS manualReviews`,
      [
        fixture.providerScope.walletId,
        owner.workspaceId,
        fixture.providerScope.intentId,
      ]
    );
    expect({
      refundDebits: Number(laterReplay.refundDebits),
      manualReviews: Number(laterReplay.manualReviews),
    }).toEqual({ refundDebits: 1, manualReviews: 0 });

    const partialOwner = await createOwnerScope();
    const partialFixture = await reserveAndConsumeCheckout(
      partialOwner,
      "partial-refund"
    );
    await openCheckout(partialFixture);
    const partialPaid = molliePayment(partialFixture, "paid");
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: partialFixture.paymentId,
        expectedMode: "test",
        payment: partialPaid,
      })
    ).resolves.toBe("processed");
    const partialRefund: MolliePayment = {
      ...partialPaid,
      amountRefunded: { currency: "EUR", value: "2.00" },
      _embedded: {
        refunds: [
          {
            id: `re_${randomUUID().replaceAll("-", "")}`,
            status: "refunded",
            amount: { currency: "EUR", value: "2.00" },
          },
        ],
        chargebacks: [],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: partialFixture.paymentId,
        expectedMode: "test",
        payment: partialRefund,
      })
    ).resolves.toBe("mismatch");
    const [[partialReview]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT \`status\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
        (SELECT \`credit_balance\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS refundDebits,
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='manual_review'
            AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.intentId'))=?) AS manualReviews,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_payment_manual_review' AND \`processed_at\` IS NOT NULL) AS completedDeliveries`,
      [
        partialFixture.providerScope.walletId,
        partialFixture.providerScope.walletId,
        partialFixture.providerScope.walletId,
        partialOwner.workspaceId,
        partialFixture.providerScope.intentId,
        partialOwner.workspaceId,
        partialFixture.paymentId,
      ]
    );
    expect({
      walletStatus: partialReview.walletStatus,
      balance: Number(partialReview.balance),
      refundDebits: Number(partialReview.refundDebits),
      manualReviews: Number(partialReview.manualReviews),
      completedDeliveries: Number(partialReview.completedDeliveries),
    }).toEqual({
      walletStatus: "frozen",
      balance: 8,
      refundDebits: 0,
      manualReviews: 1,
      completedDeliveries: 1,
    });
  });

  it("replays exact chargeback debit and restore effects across later provider snapshots", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "chargeback-replay");
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toBe("processed");

    const chargebackId = `chb_${randomUUID().replaceAll("-", "")}`;
    const activeChargeback: MolliePayment = {
      ...paid,
      _embedded: {
        refunds: [],
        chargebacks: [
          {
            id: chargebackId,
            amount: { currency: "EUR", value: "4.99" },
            createdAt: "2026-08-28T11:00:00.000Z",
          },
        ],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: activeChargeback,
      })
    ).resolves.toBe("processed");
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: {
          ...activeChargeback,
          settlementAmount: { currency: "EUR", value: "4.98" },
        },
      })
    ).resolves.toBe("duplicate");

    const reversedChargeback: MolliePayment = {
      ...activeChargeback,
      _embedded: {
        refunds: [],
        chargebacks: [
          {
            ...activeChargeback._embedded!.chargebacks![0]!,
            reversedAt: "2026-08-28T12:00:00.000Z",
          },
        ],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: reversedChargeback,
      })
    ).resolves.toBe("processed");
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: {
          ...reversedChargeback,
          settlementAmount: { currency: "EUR", value: "4.97" },
        },
      })
    ).resolves.toBe("duplicate");

    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT \`status\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
        (SELECT \`credit_balance\` FROM \`credit_wallets\`
          WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='chargeback_debit') AS debits,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='chargeback_restore') AS restores,
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='manual_review'
            AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.intentId'))=?) AS manualReviews`,
      [
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        owner.workspaceId,
        fixture.providerScope.intentId,
      ]
    );
    expect({
      walletStatus: state.walletStatus,
      balance: Number(state.balance),
      debits: Number(state.debits),
      restores: Number(state.restores),
      manualReviews: Number(state.manualReviews),
    }).toEqual({
      walletStatus: "frozen",
      balance: 8,
      debits: 1,
      restores: 1,
      manualReviews: 1,
    });
  });

  it.each(["refund", "chargeback"] as const)(
    "atomically freezes a %s adjustment before a concurrent generation hold can commit",
    async kind => {
      await proveAdjustmentFreezeWinsBeforeConcurrentHold(kind);
    }
  );

  it("durably retries a full refund after its active hold terminates", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "refund-retry");
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toBe("processed");

    const reservationId = randomUUID();
    const ownerTokenHash = sha256(`refund-retry-owner:${reservationId}`);
    await expect(
      createCreditReservationHold({
        workspaceId: owner.workspaceId,
        mode: "test",
        channelConnectionId: owner.channelConnectionId,
        bindingEpoch: owner.bindingEpoch,
        privacyEpoch: owner.privacyEpoch,
        userKey: owner.userKey,
        walletId: fixture.providerScope.walletId,
        financialSubjectRef: fixture.providerScope.financialSubjectRef,
        reservationId,
        generationRequestKeyHash: sha256(
          `refund-retry-generation:${reservationId}`
        ),
        ownerTokenHash,
        reservedCreditCount: 1,
        entryId: randomUUID(),
        evidenceHash: sha256(`refund-retry-hold:${reservationId}`),
      })
    ).resolves.toMatchObject({ result: "applied", reservationId });

    const refunded: MolliePayment = {
      ...paid,
      amountRefunded: { currency: "EUR", value: "4.99" },
      _embedded: {
        refunds: [
          {
            id: `re_${randomUUID().replaceAll("-", "")}`,
            status: "refunded",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
        chargebacks: [],
      },
    };
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: refunded,
      })
    ).rejects.toBeInstanceOf(CreditPaymentAdjustmentPendingError);

    await connection.query(
      "UPDATE `billing_execution_controls` SET `commercial_enabled`=false WHERE `workspace_id`=? AND `mode`='test'",
      [owner.workspaceId]
    );
    await connection.query(
      "UPDATE `billing_outbox` SET `max_attempts`=1,`available_at`='2000-01-01 00:00:00' WHERE `workspace_id`=? AND `mode`='test' AND `event_type`='credit_adjustment_retry'",
      [owner.workspaceId]
    );
    const configuredKey = process.env.MOLLIE_API_KEY;
    delete process.env.MOLLIE_API_KEY;
    try {
      await expect(runBillingOutboxOnce(owner.workspaceId)).resolves.toBe(true);
    } finally {
      if (configuredKey === undefined) delete process.env.MOLLIE_API_KEY;
      else process.env.MOLLIE_API_KEY = configuredKey;
    }

    const [[rearmed]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='credit_adjustment_retry'
            AND \`status\`='pending' AND \`attempt_count\`=0
            AND \`last_error_code\`='credit_adjustment_pending_holds_exhausted') AS retries,
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='manual_review'
            AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.reason'))='credit_adjustment_retry_exhausted') AS reviews,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS debits`,
      [owner.workspaceId, owner.workspaceId, fixture.providerScope.walletId]
    );
    expect({
      retries: Number(rearmed.retries),
      reviews: Number(rearmed.reviews),
      debits: Number(rearmed.debits),
    }).toEqual({ retries: 1, reviews: 1, debits: 0 });

    await expect(
      releaseCreditReservation({
        workspaceId: owner.workspaceId,
        mode: "test",
        channelConnectionId: owner.channelConnectionId,
        bindingEpoch: owner.bindingEpoch,
        privacyEpoch: owner.privacyEpoch,
        userKey: owner.userKey,
        walletId: fixture.providerScope.walletId,
        financialSubjectRef: fixture.providerScope.financialSubjectRef,
        reservationId,
        ownerTokenHash,
        entryId: randomUUID(),
        evidenceHash: sha256(`refund-retry-release:${reservationId}`),
      })
    ).resolves.toMatchObject({ result: "applied", reservationId });
    await connection.query(
      "UPDATE `billing_outbox` SET `available_at`='2000-01-01 00:00:00' WHERE `workspace_id`=? AND `mode`='test' AND `event_type`='credit_adjustment_retry'",
      [owner.workspaceId]
    );

    delete process.env.MOLLIE_API_KEY;
    try {
      await expect(runBillingOutboxOnce(owner.workspaceId)).resolves.toBe(true);
    } finally {
      if (configuredKey === undefined) delete process.env.MOLLIE_API_KEY;
      else process.env.MOLLIE_API_KEY = configuredKey;
    }
    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: refunded,
      })
    ).resolves.toBe("duplicate");

    const [[completed]] = await connection.query<RowDataPacket[]>(
      `SELECT
        (SELECT \`status\` FROM \`credit_wallets\` WHERE BINARY \`wallet_id\`=BINARY ?) AS walletStatus,
        (SELECT \`refund_adjustment_entry_id\` FROM \`credit_wallets\` WHERE BINARY \`wallet_id\`=BINARY ?) AS refundAdjustmentEntryId,
        (SELECT \`credit_balance\` FROM \`credit_wallets\` WHERE BINARY \`wallet_id\`=BINARY ?) AS balance,
        (SELECT \`reserved_credits\` FROM \`credit_wallets\` WHERE BINARY \`wallet_id\`=BINARY ?) AS reserved,
        (SELECT COUNT(*) FROM \`credit_ledger\`
          WHERE BINARY \`wallet_id\`=BINARY ? AND \`entry_kind\`='refund_debit') AS debits,
        (SELECT COUNT(*) FROM \`billing_outbox\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='credit_adjustment_retry'
            AND \`status\`='completed') AS completedRetries,
        (SELECT COUNT(*) FROM \`webhook_deliveries\`
          WHERE \`workspace_id\`=? AND \`mode\`='test' AND BINARY \`mollie_resource_id\`=BINARY ?
            AND \`processing_result\`='credit_refund_debited' AND \`processed_at\` IS NOT NULL) AS completedDeliveries`,
      [
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        fixture.providerScope.walletId,
        owner.workspaceId,
        owner.workspaceId,
        fixture.paymentId,
      ]
    );
    expect({
      walletStatus: completed.walletStatus,
      refundAdjustmentEntryId: completed.refundAdjustmentEntryId,
      balance: Number(completed.balance),
      reserved: Number(completed.reserved),
      debits: Number(completed.debits),
      completedRetries: Number(completed.completedRetries),
      completedDeliveries: Number(completed.completedDeliveries),
    }).toEqual({
      walletStatus: "active",
      refundAdjustmentEntryId: null,
      balance: 0,
      reserved: 0,
      debits: 1,
      completedRetries: 1,
      completedDeliveries: 1,
    });
  });

  it("serializes duplicate paid webhooks into one grant without a deadlock", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "duplicate-race");
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");
    const outcomes = await runBehindBarrier(
      "SELECT `authorization_epoch` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
      [owner.workspaceId],
      [
        () =>
          applyCreditPaymentWebhookSnapshot({
            webhookPaymentId: fixture.paymentId,
            expectedMode: "test",
            payment: paid,
          }),
        () =>
          applyCreditPaymentWebhookSnapshot({
            webhookPaymentId: fixture.paymentId,
            expectedMode: "test",
            payment: paid,
          }),
      ]
    );
    expect(outcomes.every(outcome => outcome.status === "fulfilled")).toBe(
      true
    );
    const results = outcomes
      .map(outcome =>
        outcome.status === "fulfilled" ? outcome.value : "rejected"
      )
      .sort();
    expect(results).toEqual(["duplicate", "processed"]);
    expect(await walletState(fixture.providerScope.walletId)).toMatchObject({
      balance: 8,
      reserved: 0,
    });
    const [[counts]] = await connection.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM `credit_ledger` WHERE `wallet_id`=? AND `entry_kind`='purchase_grant') AS grants,(SELECT COUNT(*) FROM `payment_ledger` WHERE `workspace_id`=? AND `mollie_payment_id`=? AND `paid_effect_applied`=1) AS payments",
      [fixture.providerScope.walletId, owner.workspaceId, fixture.paymentId]
    );
    expect({
      grants: Number(counts.grants),
      payments: Number(counts.payments),
    }).toEqual({ grants: 1, payments: 1 });
  });

  it("accepts an exact grant completion already finalized by a duplicate", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(
      owner,
      "duplicate-finalization"
    );
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");
    const pending = await persistCreditPaymentWebhookSnapshot({
      webhookPaymentId: fixture.paymentId,
      expectedMode: "test",
      payment: paid,
    });
    expect(pending.result).toBe("grant_pending");
    if (pending.result !== "grant_pending") {
      throw new Error("paid snapshot did not reach pending grant state");
    }

    const entryId = createDeterministicCreditGrantEntryId(pending.grant);
    await expect(
      grantCreditPurchase({
        workspaceId: pending.grant.workspaceId,
        mode: pending.grant.mode,
        channelConnectionId: pending.grant.channelConnectionId,
        bindingEpoch: pending.grant.bindingEpoch,
        privacyEpoch: pending.grant.privacyEpoch,
        userKey: pending.grant.userKey,
        walletId: pending.grant.walletId,
        financialSubjectRef: pending.grant.financialSubjectRef,
        intentId: pending.grant.intentId,
        providerPaymentId: pending.grant.providerPaymentId,
        entryId,
        evidenceHash: pending.grant.evidenceHash,
      })
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      persistCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toEqual({ result: "duplicate" });
    await expect(finishCreditPaymentGrant(pending.grant)).resolves.toBe(
      undefined
    );
    expect(await walletState(fixture.providerScope.walletId)).toMatchObject({
      balance: 8,
      reserved: 0,
    });
  });

  it("serializes disable against a known response and never leaves an exposed uncanceled payment", async () => {
    const owner = await createOwnerScope();
    const fixture = await reserveAndConsumeCheckout(owner, "disable-race");
    const operation = await claimTransport(fixture);
    const outcomes = await runBehindBarrier(
      "SELECT `authorization_epoch` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
      [owner.workspaceId],
      [
        () =>
          disableBillingSchedulerTenant({
            workspaceId: owner.workspaceId,
            mode: "test",
            actorUserId: owner.actorUserId,
            requestId: randomUUID(),
            expectedExecutionEpoch: 2,
            reason: "credit checkout test emergency stop",
          }),
        async () => {
          const finalized = await finalizeCreditPaymentProviderOperation({
            ...operation,
            outcome: {
              kind: "known_succeeded",
              paymentId: fixture.paymentId,
            },
          });
          const exposed = finalized.authorized
            ? await exposeCreditPaymentCheckout({
                ...operation,
                paymentId: fixture.paymentId,
              })
            : false;
          return { finalized, exposed };
        },
      ]
    );
    expect(outcomes.every(outcome => outcome.status === "fulfilled")).toBe(
      true
    );
    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT control.\`commercial_enabled\` AS enabled,control.\`authorization_epoch\` AS epoch,
        intent.\`status\` AS intentStatus,intent.\`url_exposed_at\` AS exposedAt,
        operation.\`state\` AS operationState,operation.\`provider_customer_id\` AS customerId
       FROM \`billing_execution_controls\` control
       JOIN \`billing_intents\` intent ON intent.\`workspace_id\`=control.\`workspace_id\` AND intent.\`mode\`=control.\`mode\`
       JOIN \`billing_provider_operations\` operation ON operation.\`intent_id\`=intent.\`intent_id\` AND operation.\`workspace_id\`=intent.\`workspace_id\` AND operation.\`mode\`=intent.\`mode\`
       WHERE control.\`workspace_id\`=? AND control.\`mode\`='test' AND intent.\`intent_id\`=?`,
      [owner.workspaceId, fixture.providerScope.intentId]
    );
    expect(state).toMatchObject({
      enabled: 0,
      epoch: 3,
      intentStatus: "contained",
      operationState: "contained",
      customerId: null,
    });
    const [[containment]] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count
       FROM \`billing_outbox\`
       WHERE \`workspace_id\`=? AND \`mode\`='test' AND \`event_type\`='cancel_payment'
         AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.intentId'))=?
         AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.targetPaymentId'))=?
         AND JSON_UNQUOTE(JSON_EXTRACT(\`payload\`,'$.creditWalletId'))=?`,
      [
        owner.workspaceId,
        fixture.providerScope.intentId,
        fixture.paymentId,
        fixture.providerScope.walletId,
      ]
    );
    expect(Number(containment.count)).toBe(1);
    expect(await walletState(fixture.providerScope.walletId)).toMatchObject({
      balance: 0,
      reserved: 0,
    });
  });

  it("serializes privacy erasure against grant and blocks a stale credit hold", async () => {
    const owner = await createOwnerScope();
    await addPrivacySubject(owner, USER_B);
    const fixture = await reserveAndConsumeCheckout(owner, "privacy-race");
    await openCheckout(fixture);
    const paid = molliePayment(fixture, "paid");
    const persisted = await persistCreditPaymentWebhookSnapshot({
      webhookPaymentId: fixture.paymentId,
      expectedMode: "test",
      payment: paid,
    });
    expect(persisted.result).toBe("grant_pending");
    if (persisted.result !== "grant_pending") {
      throw new Error("paid credit snapshot did not reach the grant boundary");
    }
    await expect(
      beginMessengerPrivacyErasure({
        workspaceId: owner.workspaceId,
        channelConnectionId: owner.channelConnectionId,
        userKey: owner.userKey,
      })
    ).resolves.toBe(2);
    const grantEntryId = createDeterministicCreditGrantEntryId(persisted.grant);
    const outcomes = await runBehindBarrier(
      "SELECT `authorization_epoch` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
      [owner.workspaceId],
      [
        async erasurePeer => {
          await erasurePeer.query(
            "CALL `credit_erase_wallet`(?,?,?,?,?,?,?,?,?)",
            [
              owner.workspaceId,
              "test",
              owner.channelConnectionId,
              owner.bindingEpoch,
              owner.privacyEpoch,
              2,
              owner.userKey,
              fixture.providerScope.walletId,
              fixture.providerScope.financialSubjectRef,
            ]
          );
          return { result: "erased" as const };
        },
        async grantPeer => {
          await grantPeer.query(
            "CALL `credit_grant_purchase`(?,?,?,?,?,?,?,?,?,?,?,?)",
            [
              persisted.grant.workspaceId,
              persisted.grant.mode,
              persisted.grant.channelConnectionId,
              persisted.grant.bindingEpoch,
              persisted.grant.privacyEpoch,
              persisted.grant.userKey,
              persisted.grant.walletId,
              persisted.grant.financialSubjectRef,
              persisted.grant.intentId,
              persisted.grant.providerPaymentId,
              grantEntryId,
              persisted.grant.evidenceHash,
            ]
          );
          return { result: "applied" as const };
        },
      ]
    );
    const erasure = outcomes[0];
    if (erasure.status !== "fulfilled") {
      throw new Error("privacy erasure did not complete its fenced transition");
    }
    expect(erasure.value).toMatchObject({ result: "erased" });
    const racedGrant = outcomes[1];
    expect(racedGrant.status).toBe("rejected");
    if (racedGrant.status !== "rejected") {
      throw new Error("stale grant unexpectedly crossed the privacy fence");
    }
    expect(String(racedGrant.reason)).toContain(
      "credit grant privacy scope is stale"
    );

    await expect(
      applyCreditPaymentWebhookSnapshot({
        webhookPaymentId: fixture.paymentId,
        expectedMode: "test",
        payment: paid,
      })
    ).resolves.toMatch(/^(duplicate|mismatch)$/);

    const staleHoldError = await createCreditReservationHold({
      workspaceId: owner.workspaceId,
      mode: "test",
      channelConnectionId: owner.channelConnectionId,
      bindingEpoch: owner.bindingEpoch,
      privacyEpoch: owner.privacyEpoch,
      userKey: owner.userKey,
      walletId: fixture.providerScope.walletId,
      financialSubjectRef: fixture.providerScope.financialSubjectRef,
      reservationId: randomUUID(),
      generationRequestKeyHash: sha256("stale-generation"),
      ownerTokenHash: sha256("stale-owner"),
      reservedCreditCount: 1,
      entryId: randomUUID(),
      evidenceHash: sha256("stale-hold"),
    })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(staleHoldError).toBeInstanceOf(Error);
    expect(
      (staleHoldError as { cause?: { sqlMessage?: unknown } }).cause?.sqlMessage
    ).toBe("credit reservation privacy scope is stale");

    await expect(
      eraseCreditWalletsForPrivacySubject({
        workspaceId: owner.workspaceId,
        channelConnectionId: owner.channelConnectionId,
        bindingEpoch: owner.bindingEpoch,
        dataPrivacyEpoch: owner.privacyEpoch,
        erasurePrivacyEpoch: 2,
        userKey: owner.userKey,
      })
    ).resolves.toMatchObject({ result: "erased", walletCount: 0 });
    expect(await walletState(fixture.providerScope.walletId)).toMatchObject({
      status: "erased",
      reserved: 0,
    });
    const [[crossScope]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`privacy_epoch` AS privacyEpoch FROM `messenger_privacy_subjects` WHERE `workspace_id`=? AND `channel_connection_id`=? AND BINARY `user_key`=BINARY ?",
      [owner.workspaceId, owner.channelConnectionId, USER_B]
    );
    expect(crossScope).toMatchObject({ status: "active", privacyEpoch: 1 });
    const record = await readCreditCheckoutSessionRecord(
      fixture.providerScope.intentId
    );
    expect(record).toMatchObject({
      messengerSenderUserKey: null,
      checkoutCapabilityHash: null,
    });
  });
});
