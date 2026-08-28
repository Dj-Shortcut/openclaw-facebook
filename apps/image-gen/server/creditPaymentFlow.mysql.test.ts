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
import { reserveMessengerCreditCheckout } from "./_core/billing/creditCheckoutReservationService";
import {
  claimCreditCheckoutBrowserSession,
  readCreditCheckoutBrowserSession,
} from "./_core/billing/creditCheckoutSession";
import { readCreditCheckoutSessionRecord } from "./_core/billing/creditCheckoutSessionStore";
import {
  applyCreditPaymentWebhookSnapshot,
  createDeterministicCreditGrantEntryId,
} from "./_core/billing/creditPaymentWebhook";
import {
  finishCreditPaymentGrant,
  isCreditPaymentGrantComplete,
  persistCreditPaymentWebhookSnapshot,
} from "./_core/billing/creditPaymentWebhookStore";
import {
  createCreditReservationHold,
  eraseCreditWalletsForPrivacySubject,
  grantCreditPurchase,
} from "./_core/billing/creditWalletStore";
import type { MollieConfig } from "./_core/billing/config";
import { confirmCreditCheckoutPayment } from "./_core/billing/creditCheckoutPaymentService";
import type { MolliePayment } from "./_core/billing/mollieClient";
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
  "credit_expire_reservation",
  "credit_grant_purchase",
  "credit_mark_reservation_provider_accepted",
  "credit_mark_reservation_transport_started",
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
      "BILLING_NOTIFICATION_PLANE_ENABLED",
      "CREDIT_CHECKOUT_HMAC_SECRET",
      "MESSENGER_PAID_CREDITS_ENABLED",
      "MOLLIE_BILLING_DRAIN_ENABLED",
      "MOLLIE_BILLING_ENABLED",
      "MOLLIE_CREDIT_CHECKOUT_ENABLED",
      "MOLLIE_CREDIT_WORKSPACE_ID",
      "MOLLIE_CREDENTIAL_GENERATION_ID",
      "MOLLIE_LIVE_BILLING_ENABLED",
      "MOLLIE_MODE",
    ]) {
      originalEnvironment.set(name, process.env[name]);
    }
    process.env.APP_BASE_URL = "https://app.leaderbot.live";
    process.env.BILLING_NOTIFICATION_PLANE_ENABLED = "true";
    process.env.CREDIT_CHECKOUT_HMAC_SECRET = TEST_CHECKOUT_SECRET;
    process.env.MESSENGER_PAID_CREDITS_ENABLED = "true";
    process.env.MOLLIE_BILLING_DRAIN_ENABLED = "true";
    process.env.MOLLIE_BILLING_ENABLED = "false";
    process.env.MOLLIE_CREDIT_CHECKOUT_ENABLED = "true";
    process.env.MOLLIE_CREDENTIAL_GENERATION_ID = "credit-mysql-test-v1";
    process.env.MOLLIE_LIVE_BILLING_ENABLED = "false";
    process.env.MOLLIE_MODE = "test";

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

  async function walletState(walletId: string) {
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
      [walletId]
    );
    return wallet;
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
        workspaceId: owner.workspaceId,
        mode: "test",
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

    process.env.MOLLIE_CREDIT_WORKSPACE_ID = String(owner.workspaceId);
    await reserveMessengerCreditCheckout({
      workspaceId: owner.workspaceId,
      channelConnectionId: owner.channelConnectionId,
      bindingEpoch: owner.bindingEpoch,
      privacyEpoch: owner.privacyEpoch,
      userKey: USER_B,
      requestId: `mysql-cross-scope-${randomUUID()}`,
    });
    const [[otherUser]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS wallets,COALESCE(SUM(`credit_balance`),0) AS balance FROM `credit_wallets` WHERE `workspace_id`=? AND BINARY `current_user_key_hash`=BINARY ?",
      [owner.workspaceId, USER_B]
    );
    expect({
      wallets: Number(otherUser.wallets),
      balance: Number(otherUser.balance),
    }).toEqual({ wallets: 1, balance: 0 });
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
