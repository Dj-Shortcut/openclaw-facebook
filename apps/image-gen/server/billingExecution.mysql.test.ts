import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import mysql, { type Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  auditLog,
  billingCustomers,
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProfileOperatorActions,
  billingProviderOperations,
  billingReconciliationAnomalies,
  billingReconciliationRuns,
  billingSchedulerTenants,
  billingSubscriptions,
  users,
  workspaceBillingProfiles,
  workspaces,
} from "../drizzle/schema";
import { getDatabaseOrThrow } from "./db";
import {
  disableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
} from "./_core/billing/billingSchedulerStore";
import {
  cancelContainedMollieSubscription,
  claimBillingOutboxItem,
  getNextBillingOutboxDue,
  processBillingOutboxItem,
  reconcileExecutionDisabledSubscription,
  runBillingOutboxOnce,
} from "./_core/billing/outboxWorker";
import { finalizeSubscriptionProviderOperation } from "./_core/billing/outboxWorker";
import type { MollieClient } from "./_core/billing/mollieClient";
import { revokeWorkspaceBillingProfile } from "./_core/billing/billingProfileStore";
import {
  finalizePaymentProviderOperation,
  isCheckoutUrlExposureAllowed,
  markIntentPaymentMismatch,
  resolveDuePaymentProviderOperations,
} from "./_core/billing/checkoutStore";
import { runDailyBillingReconciliation } from "./_core/billing/reconciliation";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("billing execution MySQL safety boundary", () => {
  const suffix = `${Date.now()}-${process.pid}`;
  let workspaceId = 0;
  let userId = 0;

  beforeEach(async () => {
    process.env.MOLLIE_BILLING_SCHEDULER_MODE = "multi_tenant";
    process.env.MOLLIE_API_KEY = `test_${"a".repeat(32)}`;
    process.env.MOLLIE_MODE = "test";
    process.env.APP_BASE_URL = "http://leaderbot.test";
    process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
      "http://billing.test/api/webhooks/mollie/payments";
    process.env.BILLING_SUPPORT_EMAIL = "billing@leaderbot.test";
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
    const database = await getDatabaseOrThrow();
    const slug = `billing-fence-${suffix}-${randomUUID().slice(0, 8)}`;
    await database.insert(workspaces).values({ name: slug, slug });
    workspaceId = (
      await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
    await database.insert(users).values({
      openId: `operator-${slug}`,
      role: "admin",
      loginMethod: "test",
    });
    userId = (
      await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.openId, `operator-${slug}`))
        .limit(1)
    )[0]!.id;
  });

  afterEach(async () => {
    if (!workspaceId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(billingReconciliationAnomalies)
      .where(eq(billingReconciliationAnomalies.workspaceId, workspaceId));
    await database
      .delete(billingReconciliationRuns)
      .where(eq(billingReconciliationRuns.workspaceId, workspaceId));
    await database
      .delete(billingOutbox)
      .where(eq(billingOutbox.workspaceId, workspaceId));
    await database
      .delete(billingProviderOperations)
      .where(eq(billingProviderOperations.workspaceId, workspaceId));
    await database
      .delete(billingSubscriptions)
      .where(eq(billingSubscriptions.workspaceId, workspaceId));
    await database
      .delete(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId));
    await database
      .delete(billingSchedulerTenants)
      .where(eq(billingSchedulerTenants.workspaceId, workspaceId));
    await database
      .delete(billingExecutionControls)
      .where(eq(billingExecutionControls.workspaceId, workspaceId));
    await database
      .delete(billingCustomers)
      .where(eq(billingCustomers.workspaceId, workspaceId));
    await database
      .delete(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId));
    await database
      .delete(billingProfileOperatorActions)
      .where(eq(billingProfileOperatorActions.workspaceId, workspaceId));
    await database
      .delete(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, workspaceId));
    await database.delete(users).where(eq(users.id, userId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    workspaceId = 0;
    userId = 0;
  });

  it("boots disabled with a claimable safety outbox and blocks commercial work", async () => {
    const database = await getDatabaseOrThrow();
    const commercialDue = new Date("2000-01-01T00:00:00.000Z");
    const safetyDue = new Date("2001-01-01T00:00:00.000Z");
    await registerBillingSchedulerTenant(workspaceId, "test", commercialDue);
    await database.insert(billingOutbox).values([
      {
        workspaceId,
        mode: "test",
        eventType: "ensure_subscription",
        deduplicationKey: `commercial-${suffix}-${workspaceId}`,
        payload: { intentId: "commercial" },
        status: "pending",
        availableAt: commercialDue,
      },
      {
        workspaceId,
        mode: "test",
        eventType: "manual_review",
        deduplicationKey: `safety-${suffix}-${workspaceId}`,
        payload: { reason: "billing_execution_disabled" },
        status: "pending",
        availableAt: safetyDue,
      },
    ]);

    await expect(
      getNextBillingOutboxDue(workspaceId, "test", new Date("2030-01-01"))
    ).resolves.toEqual(safetyDue);
    const claimed = await claimBillingOutboxItem("test", workspaceId);
    expect(claimed?.eventType).toBe("manual_review");
    const commercial = await database
      .select({ status: billingOutbox.status })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "ensure_subscription")
        )
      );
    expect(commercial[0]?.status).toBe("pending");
  });

  it("contains provider results that crash before domain attachment", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: `cst_${workspaceId}`,
      externalReference: `customer-${workspaceId}`,
      idempotencyKey: `customer-key-${workspaceId}`,
      status: "active",
    });
    const paymentIntentId = `10000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const subscriptionIntentId = `20000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertIntent(paymentIntentId, "creating_payment");
    await insertIntent(subscriptionIntentId, "paid");
    await database.insert(billingSubscriptions).values({
      workspaceId,
      mode: "test",
      planCode: "startpilot",
      mollieCustomerId: `cst_${workspaceId}`,
      sourceIntentId: subscriptionIntentId,
      idempotencyKey: `subscription-key-${workspaceId}`,
      status: "provisioning",
      interval: "1 month",
      recurringAmount: "19.00",
      currency: "EUR",
      entitlements: { aiAnswers: 100 },
      mollieDescription: "MySQL safety fixture",
    });
    await insertProviderOperation({
      operationId: `30000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      operationType: "create_payment",
      intentId: paymentIntentId,
      state: "succeeded",
      resourceId: `tr_${workspaceId}`,
    });
    await insertProviderOperation({
      operationId: `40000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      operationType: "create_subscription",
      intentId: subscriptionIntentId,
      state: "succeeded",
      resourceId: `sub_${workspaceId}`,
    });

    await disableBillingSchedulerTenant({
      workspaceId,
      mode: "test",
      actorUserId: userId,
      requestId: `50000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      expectedExecutionEpoch: 2,
      reason: "emergency execution containment",
    });

    const operations = await database
      .select({ state: billingProviderOperations.state })
      .from(billingProviderOperations)
      .where(eq(billingProviderOperations.workspaceId, workspaceId));
    expect(operations.map(row => row.state)).toEqual([
      "contained",
      "contained",
    ]);
    const cancels = await database
      .select({ eventType: billingOutbox.eventType })
      .from(billingOutbox)
      .where(eq(billingOutbox.workspaceId, workspaceId));
    expect(cancels.map(row => row.eventType).sort()).toEqual([
      "cancel_payment",
      "cancel_subscription",
    ]);
    const lanes = await database
      .select({
        kind: billingSchedulerTenants.kind,
        enabled: billingSchedulerTenants.enabled,
        epoch: billingSchedulerTenants.executionEpoch,
      })
      .from(billingSchedulerTenants)
      .where(eq(billingSchedulerTenants.workspaceId, workspaceId));
    expect(lanes.every(lane => lane.epoch === 3)).toBe(true);
    expect(lanes.filter(lane => lane.enabled).map(lane => lane.kind)).toEqual([
      "outbox",
    ]);
  });

  it("keeps an established subscription while scheduling bounded ambiguous reconciliation", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: `cst_${workspaceId}`,
      externalReference: `customer-${workspaceId}`,
      idempotencyKey: `customer-key-${workspaceId}`,
      status: "active",
    });
    const intentId = `70000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertIntent(intentId, "paid");
    await database.insert(billingSubscriptions).values({
      workspaceId,
      mode: "test",
      planCode: "startpilot",
      mollieCustomerId: `cst_${workspaceId}`,
      mollieSubscriptionId: `sub_active_${workspaceId}`,
      sourceIntentId: intentId,
      idempotencyKey: `active-subscription-key-${workspaceId}`,
      status: "active",
      interval: "1 month",
      recurringAmount: "19.00",
      currency: "EUR",
      entitlements: { aiAnswers: 100 },
      mollieDescription: "Established subscription fixture",
    });
    const operationId = `80000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertProviderOperation({
      operationId,
      operationType: "create_subscription",
      intentId,
      state: "ambiguous",
    });

    await disableBillingSchedulerTenant({
      workspaceId,
      mode: "test",
      actorUserId: userId,
      requestId: `90000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      expectedExecutionEpoch: 2,
      reason: "emergency execution containment",
    });

    const subscription = await database
      .select({ status: billingSubscriptions.status })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.workspaceId, workspaceId));
    expect(subscription[0]?.status).toBe("active");
    const safetyJob = await database
      .select()
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_subscription"),
          eq(
            billingOutbox.deduplicationKey,
            `subscription_ambiguous_reconcile:${operationId}`
          )
        )
      );
    expect(safetyJob[0]?.payload).toMatchObject({
      providerOperationId: operationId,
      targetSubscriptionId: null,
      expectedSourceIntentId: intentId,
    });
    const remoteFor = (id: string) => ({
      resource: "subscription" as const,
      id,
      mode: "test" as const,
      status: "active" as const,
      amount: { currency: "EUR", value: "19.00" },
      interval: "1 month",
      startDate: "2026-09-01",
      mandateId: `mdt_${workspaceId}`,
      metadata: { billingIntentId: intentId },
    });
    const orphanId = `sub_orphan_${workspaceId}`;
    const listCustomerSubscriptions = async () => [
      remoteFor(`sub_active_${workspaceId}`),
      remoteFor(orphanId),
    ];
    await reconcileExecutionDisabledSubscription(
      { ...safetyJob[0]!, leaseToken: safetyJob[0]!.leaseToken ?? "lease" },
      { listCustomerSubscriptions } as unknown as MollieClient
    );
    const exactJobs = await database
      .select()
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_subscription")
        )
      );
    const exactCurrent = exactJobs.find(
      row =>
        (row.payload as Record<string, unknown>).targetSubscriptionId ===
        `sub_active_${workspaceId}`
    );
    const exactOrphan = exactJobs.find(
      row =>
        (row.payload as Record<string, unknown>).targetSubscriptionId ===
        orphanId
    );
    expect(exactCurrent).toBeDefined();
    expect(exactOrphan).toBeDefined();
    const cancelSubscription = vi.fn().mockResolvedValue(undefined);
    const cancellationClient = {
      getSubscription: async (_customerId: string, remoteId: string) =>
        remoteFor(remoteId),
      cancelSubscription,
    } as unknown as MollieClient;
    await expect(
      cancelContainedMollieSubscription(
        exactCurrent!,
        {
          customerId: `cst_${workspaceId}`,
          subscriptionId: `sub_active_${workspaceId}`,
        },
        cancellationClient
      )
    ).resolves.toBe("skipped_current");
    expect(cancelSubscription).not.toHaveBeenCalled();
    await expect(
      cancelContainedMollieSubscription(
        exactOrphan!,
        { customerId: `cst_${workspaceId}`, subscriptionId: orphanId },
        cancellationClient
      )
    ).resolves.toBe("canceled");
    expect(cancelSubscription).toHaveBeenCalledOnce();
    expect(cancelSubscription).toHaveBeenCalledWith(
      `cst_${workspaceId}`,
      orphanId
    );
  });

  it("serializes disable and profile revoke without a lock-order deadlock", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const intentId = `a0000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertIntent(intentId, "creating_payment");
    await database.insert(workspaceBillingProfiles).values({
      workspaceId,
      countryCode: "BE",
      customerType: "consumer",
      verificationStatus: "verified",
      verificationMethod: "mysql_race_fixture",
      evidenceReferenceHash: "race-evidence",
      verifiedAt: new Date(Date.now() - 60_000),
      verificationExpiresAt: new Date(Date.now() + 60_000),
      verifiedByUserId: userId,
      peppolReady: false,
      eligibilityVersion: 1,
    });
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const blocker = await mysql.createConnection(url);
    const disableConnection = await mysql.createConnection(url);
    const revokeConnection = await mysql.createConnection(url);
    const observer = await mysql.createConnection(url);
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `intent_id` FROM `billing_intents` WHERE `intent_id`=? FOR UPDATE",
        [intentId]
      );
      const [[identity]] = await blocker.query<Array<{ connectionId: number }>>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      await disableConnection.beginTransaction();
      await disableConnection.query(
        "SELECT `workspace_id` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [workspaceId]
      );
      await revokeConnection.beginTransaction();
      await revokeConnection.query(
        "SELECT `workspace_id` FROM `workspace_billing_profiles` WHERE `workspace_id`=? FOR UPDATE",
        [workspaceId]
      );
      const disableIntentLock = disableConnection
        .query(
          "SELECT `intent_id` FROM `billing_intents` WHERE `intent_id`=? FOR UPDATE",
          [intentId]
        )
        .then(() => "disable" as const);
      const revokeIntentLock = revokeConnection
        .query(
          "SELECT `intent_id` FROM `billing_intents` WHERE `intent_id`=? FOR UPDATE",
          [intentId]
        )
        .then(() => "revoke" as const);
      await waitForBlockedTransactions(observer, identity!.connectionId, 2);
      await blocker.commit();
      const first = await Promise.race([disableIntentLock, revokeIntentLock]);
      const firstConnection =
        first === "disable" ? disableConnection : revokeConnection;
      await firstConnection.query(
        "SELECT `id` FROM `billing_scheduler_tenants` WHERE `workspace_id`=? AND `mode`='test' ORDER BY `kind` FOR UPDATE",
        [workspaceId]
      );
      await firstConnection.commit();
      if (first === "disable") {
        await revokeIntentLock;
        await revokeConnection.query(
          "SELECT `id` FROM `billing_scheduler_tenants` WHERE `workspace_id`=? AND `mode`='test' ORDER BY `kind` FOR UPDATE",
          [workspaceId]
        );
        await revokeConnection.commit();
      } else {
        await disableIntentLock;
        await disableConnection.query(
          "SELECT `id` FROM `billing_scheduler_tenants` WHERE `workspace_id`=? AND `mode`='test' ORDER BY `kind` FOR UPDATE",
          [workspaceId]
        );
        await disableConnection.commit();
      }
      const disable = disableBillingSchedulerTenant({
        workspaceId,
        mode: "test",
        actorUserId: userId,
        requestId: `b0000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
        expectedExecutionEpoch: 2,
        reason: "race-safe emergency disable",
      });
      const revoke = revokeWorkspaceBillingProfile({
        requestId: `c0000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
        workspaceId,
        actorUserId: userId,
        expectedVersion: 1,
        reason: "race-safe profile revoke",
      });
      const outcomes = await Promise.allSettled([disable, revoke]);
      expect(outcomes.map(outcome => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
    } finally {
      await blocker.rollback().catch(() => undefined);
      await disableConnection.rollback().catch(() => undefined);
      await revokeConnection.rollback().catch(() => undefined);
      await blocker.end();
      await disableConnection.end();
      await revokeConnection.end();
      await observer.end();
    }
    const controls = await database
      .select({ enabled: billingExecutionControls.commercialEnabled })
      .from(billingExecutionControls)
      .where(eq(billingExecutionControls.workspaceId, workspaceId));
    const profiles = await database
      .select({ status: workspaceBillingProfiles.verificationStatus })
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, workspaceId));
    expect(controls[0]?.enabled).toBe(false);
    expect(profiles[0]?.status).toBe("revoked");
  });

  it("contains provider results that arrive after disable won the transport race", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const customerId = `cst_${workspaceId}`;
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: customerId,
      externalReference: `customer-${workspaceId}`,
      idempotencyKey: `customer-key-${workspaceId}`,
      status: "active",
    });
    const paymentIntentId = `d0000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const subscriptionIntentId = `e0000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertIntent(paymentIntentId, "creating_payment");
    await insertIntent(subscriptionIntentId, "paid");
    await database.insert(billingSubscriptions).values({
      workspaceId,
      mode: "test",
      planCode: "startpilot",
      mollieCustomerId: customerId,
      sourceIntentId: subscriptionIntentId,
      idempotencyKey: `subscription-key-${workspaceId}`,
      status: "provisioning",
      interval: "1 month",
      recurringAmount: "19.00",
      currency: "EUR",
      entitlements: { aiAnswers: 100 },
      mollieDescription: "Late result fixture",
    });
    const paymentOperationId = `f0000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const subscriptionOperationId = `11000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertProviderOperation({
      operationId: paymentOperationId,
      operationType: "create_payment",
      intentId: paymentIntentId,
      state: "transport_started",
    });
    await insertProviderOperation({
      operationId: subscriptionOperationId,
      operationType: "create_subscription",
      intentId: subscriptionIntentId,
      state: "transport_started",
    });
    await database.insert(billingOutbox).values({
      workspaceId,
      mode: "test",
      eventType: "ensure_subscription",
      deduplicationKey: `late-subscription-${workspaceId}`,
      payload: { intentId: subscriptionIntentId },
      status: "processing",
      leaseToken: `12000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      lockedAt: new Date(),
    });
    const job = (
      await database
        .select()
        .from(billingOutbox)
        .where(
          eq(billingOutbox.deduplicationKey, `late-subscription-${workspaceId}`)
        )
    )[0]!;
    const subscription = (
      await database
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.workspaceId, workspaceId))
    )[0]!;

    await disableBillingSchedulerTenant({
      workspaceId,
      mode: "test",
      actorUserId: userId,
      requestId: `13000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      expectedExecutionEpoch: 2,
      reason: "transport race containment",
    });
    await expect(
      finalizePaymentProviderOperation({
        operationId: paymentOperationId,
        leaseToken: paymentOperationId,
        outcome: "succeeded",
        providerResourceId: `tr_late_${workspaceId}`,
        workspaceId,
        mode: "test",
        authorizationEpoch: 2,
        intentId: paymentIntentId,
        targetCustomerId: customerId,
      })
    ).resolves.toMatchObject({ recorded: true, authorized: false });
    await expect(
      finalizeSubscriptionProviderOperation(
        {
          operationId: subscriptionOperationId,
          leaseToken: subscriptionOperationId,
          authorizationEpoch: 2,
          workspaceId,
          mode: "test",
          intentId: subscriptionIntentId,
          customerId,
        },
        "succeeded",
        `sub_late_${workspaceId}`,
        { job: { ...job, leaseToken: job.leaseToken! }, subscription }
      )
    ).resolves.toMatchObject({ recorded: true, authorized: false });
    const exactCancels = await database
      .select({
        eventType: billingOutbox.eventType,
        payload: billingOutbox.payload,
      })
      .from(billingOutbox)
      .where(eq(billingOutbox.workspaceId, workspaceId));
    expect(
      exactCancels.some(
        row =>
          row.eventType === "cancel_payment" &&
          (row.payload as Record<string, unknown>).targetPaymentId ===
            `tr_late_${workspaceId}`
      )
    ).toBe(true);
    expect(
      exactCancels.some(
        row =>
          row.eventType === "cancel_subscription" &&
          (row.payload as Record<string, unknown>).targetSubscriptionId ===
            `sub_late_${workspaceId}`
      )
    ).toBe(true);
  });

  it("serializes payment mismatch and execution disable at the control fence", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const customerId = `cst_${workspaceId}`;
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: customerId,
      externalReference: `customer-${workspaceId}`,
      idempotencyKey: `customer-key-${workspaceId}`,
      status: "active",
    });
    const intentId = `14000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const operationId = `15000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertIntent(intentId, "creating_payment");
    await insertProviderOperation({
      operationId,
      operationType: "create_payment",
      intentId,
      state: "succeeded",
      resourceId: `tr_mismatch_${workspaceId}`,
    });
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const blocker = await mysql.createConnection(url);
    const observer = await mysql.createConnection(url);
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `workspace_id` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [workspaceId]
      );
      const [[identity]] = await blocker.query<Array<{ connectionId: number }>>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      const mismatch = markIntentPaymentMismatch({
        intentId,
        workspaceId,
        mode: "test",
        molliePaymentId: `tr_mismatch_${workspaceId}`,
        operationId,
        authorizationEpoch: 2,
        targetCustomerId: customerId,
      });
      const disable = disableBillingSchedulerTenant({
        workspaceId,
        mode: "test",
        actorUserId: userId,
        requestId: `16000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
        expectedExecutionEpoch: 2,
        reason: "mismatch race containment",
      });
      await waitForBlockedTransactions(observer, identity!.connectionId, 2);
      await blocker.commit();
      const outcomes = await Promise.allSettled([mismatch, disable]);
      expect(outcomes.map(outcome => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
    } finally {
      await blocker.rollback().catch(() => undefined);
      await blocker.end();
      await observer.end();
    }
    const operation = await database
      .select({ state: billingProviderOperations.state })
      .from(billingProviderOperations)
      .where(eq(billingProviderOperations.operationId, operationId));
    expect(operation[0]?.state).toBe("contained");
    const cancels = await database
      .select({ eventType: billingOutbox.eventType })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_payment")
        )
      );
    expect(cancels).toHaveLength(1);
  });

  it("linearizes checkout URL exposure against execution disable", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const intentId = `17000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const paymentId = `tr_exposure_${workspaceId}`;
    await insertIntent(intentId, "creating_payment");
    await database
      .update(billingIntents)
      .set({ status: "open", molliePaymentId: paymentId })
      .where(eq(billingIntents.intentId, intentId));
    await database.insert(workspaceBillingProfiles).values({
      workspaceId,
      countryCode: "BE",
      customerType: "consumer",
      verificationStatus: "verified",
      verificationMethod: "mysql_exposure_fixture",
      evidenceReferenceHash: "exposure-evidence",
      verifiedAt: new Date(Date.now() - 60_000),
      verificationExpiresAt: new Date(Date.now() + 60_000),
      verifiedByUserId: userId,
      peppolReady: false,
      eligibilityVersion: 0,
    });
    await insertProviderOperation({
      operationId: `18000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      operationType: "create_payment",
      intentId,
      state: "succeeded",
      resourceId: paymentId,
    });

    const [intentBeforeExposure] = await database
      .select()
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId));
    const [profileBeforeExposure] = await database
      .select()
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, workspaceId));
    const [operationBeforeExposure] = await database
      .select()
      .from(billingProviderOperations)
      .where(eq(billingProviderOperations.intentId, intentId));
    expect(intentBeforeExposure).toMatchObject({
      status: "open",
      molliePaymentId: paymentId,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
    });
    expect(profileBeforeExposure).toMatchObject({
      verificationStatus: "verified",
      eligibilityVersion: 0,
    });
    expect(operationBeforeExposure).toMatchObject({
      operationKey: intentId,
      state: "succeeded",
      providerResourceId: paymentId,
      authorizationEpoch: 2,
    });

    await expect(
      isCheckoutUrlExposureAllowed({
        intentId,
        workspaceId,
        mode: "test",
        molliePaymentId: paymentId,
        billingProfileVersion: 0,
        authorizationEpoch: 2,
      })
    ).resolves.toBe(true);
    await disableBillingSchedulerTenant({
      workspaceId,
      mode: "test",
      actorUserId: userId,
      requestId: `19000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      expectedExecutionEpoch: 2,
      reason: "URL exposure containment",
    });
    await expect(
      isCheckoutUrlExposureAllowed({
        intentId,
        workspaceId,
        mode: "test",
        molliePaymentId: paymentId,
        billingProfileVersion: 0,
        authorizationEpoch: 2,
      })
    ).resolves.toBe(false);
  });

  it("serializes concurrent checkout exposure and disable on the control row", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const intentId = `1c000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const paymentId = `tr_concurrent_exposure_${workspaceId}`;
    await insertIntent(intentId, "creating_payment");
    await database
      .update(billingIntents)
      .set({ status: "open", molliePaymentId: paymentId })
      .where(eq(billingIntents.intentId, intentId));
    await database.insert(workspaceBillingProfiles).values({
      workspaceId,
      countryCode: "BE",
      customerType: "consumer",
      verificationStatus: "verified",
      verificationMethod: "mysql_concurrent_exposure_fixture",
      evidenceReferenceHash: "concurrent-exposure-evidence",
      verifiedAt: new Date(Date.now() - 60_000),
      verificationExpiresAt: new Date(Date.now() + 60_000),
      verifiedByUserId: userId,
      peppolReady: false,
      eligibilityVersion: 0,
    });
    await insertProviderOperation({
      operationId: `1d000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      operationType: "create_payment",
      intentId,
      state: "succeeded",
      resourceId: paymentId,
    });
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const blocker = await mysql.createConnection(url);
    const observer = await mysql.createConnection(url);
    let exposure!: Promise<boolean>;
    let disable!: ReturnType<typeof disableBillingSchedulerTenant>;
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `workspace_id` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [workspaceId]
      );
      const [[identity]] = await blocker.query<Array<{ connectionId: number }>>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      exposure = isCheckoutUrlExposureAllowed({
        intentId,
        workspaceId,
        mode: "test",
        molliePaymentId: paymentId,
        billingProfileVersion: 0,
        authorizationEpoch: 2,
      });
      disable = disableBillingSchedulerTenant({
        workspaceId,
        mode: "test",
        actorUserId: userId,
        requestId: `1e000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
        expectedExecutionEpoch: 2,
        reason: "concurrent URL exposure containment",
      });
      await waitForBlockedTransactions(observer, identity!.connectionId, 2);
      await blocker.commit();
      const outcomes = await Promise.allSettled([exposure, disable]);
      expect(outcomes.map(outcome => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
    } finally {
      await blocker.rollback().catch(() => undefined);
      await blocker.end();
      await observer.end();
    }
    const exposed = await exposure;
    const [intent] = await database
      .select({
        status: billingIntents.status,
        urlExposedAt: billingIntents.urlExposedAt,
      })
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId));
    expect(intent?.status).toBe("contained");
    expect(Boolean(intent?.urlExposedAt)).toBe(exposed);
    await expect(
      isCheckoutUrlExposureAllowed({
        intentId,
        workspaceId,
        mode: "test",
        molliePaymentId: paymentId,
        billingProfileVersion: 0,
        authorizationEpoch: 2,
      })
    ).resolves.toBe(false);
    const cancels = await database
      .select({ payload: billingOutbox.payload })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_payment")
        )
      );
    expect(
      cancels.some(
        row =>
          (row.payload as Record<string, unknown>).targetPaymentId === paymentId
      )
    ).toBe(true);
  });

  it("fails a mismatched safety cancel and deduplicates operator review", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const customerId = `cst_${workspaceId}`;
    const intentId = `1f000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const operationId = `20000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const subscriptionId = `sub_scope_${workspaceId}`;
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: customerId,
      externalReference: `customer-${workspaceId}`,
      idempotencyKey: `customer-key-${workspaceId}`,
      status: "active",
    });
    await insertIntent(intentId, "paid");
    await database.insert(billingSubscriptions).values({
      workspaceId,
      mode: "test",
      planCode: "startpilot",
      mollieCustomerId: customerId,
      mollieSubscriptionId: subscriptionId,
      sourceIntentId: intentId,
      idempotencyKey: `scope-subscription-${workspaceId}`,
      status: "provisioning",
      interval: "1 month",
      recurringAmount: "19.00",
      currency: "EUR",
      entitlements: { aiAnswers: 100 },
      mollieDescription: "Scope mismatch fixture",
    });
    await insertProviderOperation({
      operationId,
      operationType: "create_subscription",
      intentId,
      state: "succeeded",
      resourceId: subscriptionId,
    });
    await disableBillingSchedulerTenant({
      workspaceId,
      mode: "test",
      actorUserId: userId,
      requestId: `21000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      expectedExecutionEpoch: 2,
      reason: "scope mismatch containment",
    });
    await database
      .update(billingOutbox)
      .set({ availableAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_subscription")
        )
      );
    const cancelSubscription = vi.fn();
    const processed = await runBillingOutboxOnce(workspaceId, {
      getSubscription: vi.fn().mockResolvedValue({
        resource: "subscription",
        id: subscriptionId,
        mode: "test",
        status: "active",
        amount: { currency: "EUR", value: "19.00" },
        interval: "1 month",
        startDate: "2026-09-01",
        metadata: { billingIntentId: "wrong-intent" },
      }),
      cancelSubscription,
    } as unknown as MollieClient);
    expect(processed).toBe(true);
    expect(cancelSubscription).not.toHaveBeenCalled();
    const cancellationJobs = await database
      .select({
        status: billingOutbox.status,
        lastErrorCode: billingOutbox.lastErrorCode,
        deliveryId: billingOutbox.deliveryId,
        payload: billingOutbox.payload,
      })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_subscription")
        )
      );
    expect(cancellationJobs).toHaveLength(1);
    const [failed] = cancellationJobs;
    expect(failed).toMatchObject({
      status: "failed",
      lastErrorCode: "subscription_cancellation_provider_scope_mismatch",
    });
    const reviews = await database
      .select({
        deduplicationKey: billingOutbox.deduplicationKey,
        payload: billingOutbox.payload,
      })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "manual_review")
        )
      );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      deduplicationKey: `subscription_cancel_scope_review:${failed!.deliveryId}`,
      payload: {
        reason: "subscription_cancellation_provider_scope_mismatch",
      },
    });
  });

  it("persists a known provider result but blocks stale-lease domain effects", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const customerId = `cst_${workspaceId}`;
    const intentId = `1a000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: customerId,
      externalReference: `customer-${workspaceId}`,
      idempotencyKey: `customer-key-${workspaceId}`,
      status: "active",
    });
    await insertIntent(intentId, "paid");
    await database
      .update(billingIntents)
      .set({
        paidAt: new Date(Date.now() - 60_000),
        billingProfileVersion: 1,
      })
      .where(eq(billingIntents.intentId, intentId));
    await database.insert(workspaceBillingProfiles).values({
      workspaceId,
      countryCode: "BE",
      customerType: "consumer",
      verificationStatus: "verified",
      verificationMethod: "mysql_lease_fixture",
      evidenceReferenceHash: "lease-evidence",
      verifiedAt: new Date(Date.now() - 60_000),
      verificationExpiresAt: new Date(Date.now() + 60_000),
      verifiedByUserId: userId,
      peppolReady: false,
      eligibilityVersion: 1,
    });
    await database.insert(billingSubscriptions).values({
      workspaceId,
      mode: "test",
      planCode: "startpilot",
      mollieCustomerId: customerId,
      sourceIntentId: intentId,
      idempotencyKey: `subscription-lease-${workspaceId}`,
      status: "provisioning",
      paidThrough: new Date(Date.now() + 24 * 60 * 60_000),
      interval: "1 month",
      recurringAmount: "19.00",
      currency: "EUR",
      entitlements: { aiAnswers: 100 },
      mollieDescription: "MySQL safety fixture",
    });
    await database.insert(billingOutbox).values({
      workspaceId,
      mode: "test",
      eventType: "ensure_subscription",
      deduplicationKey: `lease-steal-${workspaceId}`,
      payload: { intentId },
      status: "pending",
      availableAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    const tenantLease = {
      workspaceId,
      mode: "test" as const,
      kind: "outbox" as const,
      leaseToken: `1b000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      executionEpoch: 2,
    };
    await database
      .update(billingSchedulerTenants)
      .set({
        leaseToken: tenantLease.leaseToken,
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, "test"),
          eq(billingSchedulerTenants.kind, "outbox")
        )
      );
    let releaseProvider!: (value: unknown) => void;
    let providerStarted!: () => void;
    const providerStartedPromise = new Promise<void>(resolve => {
      providerStarted = resolve;
    });
    const providerResult = new Promise(resolve => {
      releaseProvider = resolve;
    });
    const client = {
      listMandates: async () => [
        {
          resource: "mandate",
          id: `mdt_${workspaceId}`,
          mode: "test",
          status: "valid",
          method: "directdebit",
          createdAt: new Date().toISOString(),
        },
      ],
      listCustomerSubscriptions: async () => [],
      createSubscription: async () => {
        providerStarted();
        return providerResult;
      },
    } as unknown as MollieClient;
    const claimedJob = await claimBillingOutboxItem("test", workspaceId);
    expect(claimedJob?.eventType).toBe("ensure_subscription");
    const worker = processBillingOutboxItem(claimedJob!, client, tenantLease);
    const reachedProvider = await Promise.race([
      providerStartedPromise.then(() => true),
      worker.then(() => false),
    ]);
    expect(reachedProvider).toBe(true);
    await database
      .update(billingSchedulerTenants)
      .set({ leaseToken: randomUUID() })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, "test"),
          eq(billingSchedulerTenants.kind, "outbox")
        )
      );
    releaseProvider({
      resource: "subscription",
      id: `sub_stale_${workspaceId}`,
      mode: "test",
      status: "active",
      amount: { currency: "EUR", value: "19.00" },
      interval: "1 month",
      startDate: new Date(Date.now() + 24 * 60 * 60_000)
        .toISOString()
        .slice(0, 10),
      mandateId: `mdt_${workspaceId}`,
      metadata: { billingIntentId: intentId },
    });
    await worker;

    const [subscription] = await database
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.workspaceId, workspaceId));
    expect(subscription?.status).toBe("provisioning");
    expect(subscription?.mollieSubscriptionId).toBeNull();
    const [operation] = await database
      .select()
      .from(billingProviderOperations)
      .where(eq(billingProviderOperations.intentId, intentId));
    expect(operation).toMatchObject({
      state: "succeeded",
      providerResourceId: `sub_stale_${workspaceId}`,
    });
    const cancelJobs = await database
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "cancel_subscription")
        )
      );
    expect(cancelJobs).toHaveLength(0);
  });

  it("serializes due payment resolution and emergency disable on the control row", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const intentId = `21000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    await insertIntent(intentId, "creating_payment");
    await insertProviderOperation({
      operationId: `22000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      operationType: "create_payment",
      intentId,
      state: "ambiguous",
    });
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const blocker = await mysql.createConnection(url);
    const observer = await mysql.createConnection(url);
    let resolver!: ReturnType<typeof resolveDuePaymentProviderOperations>;
    let disable!: ReturnType<typeof disableBillingSchedulerTenant>;
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `workspace_id` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [workspaceId]
      );
      const [[identity]] = await blocker.query<Array<{ connectionId: number }>>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      resolver = resolveDuePaymentProviderOperations(
        workspaceId,
        "test",
        new Date(Date.now() + 1_000)
      );
      disable = disableBillingSchedulerTenant({
        workspaceId,
        mode: "test",
        actorUserId: userId,
        requestId: `23000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
        expectedExecutionEpoch: 2,
        reason: "serialize resolver and disable",
      });
      await waitForBlockedTransactions(observer, identity!.connectionId, 2);
      await blocker.commit();
      const outcomes = await Promise.allSettled([resolver, disable]);
      expect(outcomes.map(outcome => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
    } finally {
      await blocker.rollback().catch(() => undefined);
      await blocker.end();
      await observer.end();
    }
    const [control] = await database
      .select({ enabled: billingExecutionControls.commercialEnabled })
      .from(billingExecutionControls)
      .where(eq(billingExecutionControls.workspaceId, workspaceId));
    expect(control?.enabled).toBe(false);
  });

  it("rejects a deferred reconciliation response after the tenant lease is lost", async () => {
    const database = await getDatabaseOrThrow();
    await provisionEnabledBoundary();
    const intentId = `24000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`;
    const customerId = `cst_reconciliation_${workspaceId}`;
    const subscriptionId = `sub_reconciliation_${workspaceId}`;
    const mandateId = `mdt_reconciliation_${workspaceId}`;
    const originalNextPaymentDate = new Date("2026-09-01T00:00:00.000Z");
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: customerId,
      externalReference: `reconciliation-customer-${workspaceId}`,
      idempotencyKey: `reconciliation-customer-key-${workspaceId}`,
      status: "active",
    });
    await insertIntent(intentId, "paid");
    await database.insert(billingSubscriptions).values({
      workspaceId,
      mode: "test",
      planCode: "premium_monthly_v1",
      mollieCustomerId: customerId,
      mollieSubscriptionId: subscriptionId,
      mollieMandateId: mandateId,
      sourceIntentId: intentId,
      idempotencyKey: `reconciliation-subscription-${workspaceId}`,
      status: "active",
      interval: "1 month",
      recurringAmount: "19.00",
      currency: "EUR",
      entitlements: { imagesPerDay: 100 },
      mollieDescription: "Reconciliation lease fixture",
      nextPaymentDate: originalNextPaymentDate,
    });
    const tenantLease = {
      workspaceId,
      mode: "test" as const,
      kind: "reconciliation" as const,
      leaseToken: `25000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
      executionEpoch: 2,
    };
    await database
      .update(billingSchedulerTenants)
      .set({
        leaseToken: tenantLease.leaseToken,
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, "test"),
          eq(billingSchedulerTenants.kind, "reconciliation")
        )
      );
    let providerStarted!: () => void;
    let releaseProvider!: (value: unknown) => void;
    const providerStartedPromise = new Promise<void>(resolve => {
      providerStarted = resolve;
    });
    const providerResult = new Promise(resolve => {
      releaseProvider = resolve;
    });
    const remote = {
      resource: "subscription",
      id: subscriptionId,
      mode: "test",
      status: "active",
      amount: { currency: "EUR", value: "19.00" },
      interval: "1 month",
      startDate: "2026-08-01",
      nextPaymentDate: "2026-10-01",
      mandateId,
      metadata: { billingIntentId: intentId },
    };
    const client = {
      listCustomerPayments: async () => [],
      getPayment: vi.fn(),
      getSubscription: async () => {
        providerStarted();
        return providerResult;
      },
      listCustomerSubscriptions: async () => [remote],
    } as unknown as MollieClient;
    const reconciliation = runDailyBillingReconciliation(
      workspaceId,
      client,
      new Date("2026-08-21T08:00:00.000Z"),
      async () => undefined,
      tenantLease
    );
    await providerStartedPromise;
    await database
      .update(billingSchedulerTenants)
      .set({ leaseToken: randomUUID() })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, "test"),
          eq(billingSchedulerTenants.kind, "reconciliation")
        )
      );
    releaseProvider(remote);
    await expect(reconciliation).rejects.toThrow(
      "billing scheduler lease ownership was lost"
    );
    const [subscription] = await database
      .select({ nextPaymentDate: billingSubscriptions.nextPaymentDate })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.workspaceId, workspaceId));
    expect(subscription?.nextPaymentDate).toEqual(originalNextPaymentDate);
    const effects = await database
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(eq(billingOutbox.workspaceId, workspaceId));
    expect(effects).toHaveLength(0);
    const [run] = await database
      .select({ status: billingReconciliationRuns.status })
      .from(billingReconciliationRuns)
      .where(eq(billingReconciliationRuns.workspaceId, workspaceId));
    expect(run?.status).toBe("running");
  });

  async function provisionEnabledBoundary() {
    const database = await getDatabaseOrThrow();
    await database.insert(billingExecutionControls).values({
      workspaceId,
      mode: "test",
      commercialEnabled: true,
      authorizationEpoch: 2,
    });
    await database.insert(billingSchedulerTenants).values(
      (
        [
          "outbox",
          "reconciliation",
          "profile_expiry",
          "ai_finalization",
        ] as const
      ).map(kind => ({
        workspaceId,
        mode: "test" as const,
        kind,
        enabled: true,
        executionEpoch: 2,
        operatorRequestId: `60000000-0000-4000-8000-${String(workspaceId).padStart(12, "0")}`,
        operatorRequestFingerprint: "6".repeat(64),
        enabledByUserId: userId,
        enabledAt: new Date(),
      }))
    );
  }

  async function insertIntent(
    intentId: string,
    status: "creating_payment" | "paid"
  ) {
    const database = await getDatabaseOrThrow();
    await database.insert(billingIntents).values({
      intentId,
      workspaceId,
      mode: "test",
      planCode: "startpilot",
      kind: "startpilot_purchase",
      expectedAmount: "19.00",
      currency: "EUR",
      interval: "one-time",
      entitlements: { aiAnswers: 100 },
      mollieDescription: "MySQL safety fixture",
      status,
      idempotencyKey: `intent-key-${intentId}`,
      checkoutScopeKey: `scope-${intentId}`,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
    });
  }

  async function insertProviderOperation(input: {
    operationId: string;
    operationType: "create_payment" | "create_subscription";
    intentId: string;
    state: "succeeded" | "transport_started" | "ambiguous";
    resourceId?: string;
  }) {
    const database = await getDatabaseOrThrow();
    await database.insert(billingProviderOperations).values({
      operationId: input.operationId,
      workspaceId,
      mode: "test",
      operationType: input.operationType,
      operationKey:
        input.operationType === "create_payment"
          ? input.intentId
          : `${input.operationType}:${input.intentId}`,
      intentId: input.intentId,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
      state: input.state,
      requestFingerprint: "a".repeat(64),
      idempotencyKeyHash: "b".repeat(64),
      credentialGenerationId: "test-generation",
      providerResourceId: input.resourceId,
      providerCustomerId: `cst_${workspaceId}`,
      leaseToken: input.operationId,
      leaseUntil: new Date(Date.now() + 60_000),
      firstStartedAt: new Date(),
      resolutionDueAt: new Date(),
      completedAt: input.state === "succeeded" ? new Date() : undefined,
    });
  }
});

async function waitForBlockedTransactions(
  observer: Connection,
  blockerConnectionId: number,
  expected: number
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [[row]] = await observer.query<Array<{ waiting: number }>>(
      `SELECT COUNT(DISTINCT requested.THREAD_ID) AS waiting
       FROM performance_schema.data_lock_waits AS waits
       JOIN performance_schema.data_locks AS blocking
         ON blocking.ENGINE_LOCK_ID=waits.BLOCKING_ENGINE_LOCK_ID
       JOIN performance_schema.threads AS blocker_thread
         ON blocker_thread.THREAD_ID=blocking.THREAD_ID
       JOIN performance_schema.data_locks AS requested
         ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
       WHERE blocker_thread.PROCESSLIST_ID=?`,
      [blockerConnectionId]
    );
    if (Number(row?.waiting ?? 0) >= expected) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(
    "MySQL lock barrier did not observe both waiting transactions"
  );
}
