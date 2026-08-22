import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  auditLog,
  billingCustomers,
  billingExecutionControls,
  billingHandoffRecoveryEvents,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSchedulerTenants,
  billingWebhookRoutes,
  channelConnections,
  paymentLedger,
  portalHandoffTokens,
  users,
  webhookDeliveries,
  workspaceBillingProfiles,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceMembers,
  workspaces,
} from "../drizzle/schema";
import { startMollieCheckout } from "./_core/billing/checkoutService";
import type { MollieClient } from "./_core/billing/mollieClient";
import { applyMolliePaymentSnapshot } from "./_core/billing/paymentStore";
import { rearmFailedPortalHandoffAfterInbound } from "./_core/billing/portalHandoffRecovery";
import type { MolliePayment } from "./_core/billing/mollieClient";
import {
  claimPortalHandoffTokenForUser,
  createOrGetPortalHandoffToken,
  getDatabaseOrThrow,
} from "./db";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");
const originalEnv = { ...process.env };

suite("payment snapshot MySQL concurrency", () => {
  let workspaceId = 0;
  let operatorUserId = 0;
  let claimantUserId = 0;
  let pageId = "";

  beforeEach(async () => {
    const database = await getDatabaseOrThrow();
    const slug = `payment-snapshot-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await database.insert(workspaces).values({ name: slug, slug });
    workspaceId = (
      await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
    await database.insert(users).values({
      openId: `payment-operator-${slug}`,
      role: "admin",
      loginMethod: "test",
    });
    operatorUserId = (
      await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.openId, `payment-operator-${slug}`))
        .limit(1)
    )[0]!.id;
    pageId = String(10_000_000 + workspaceId);
    await database.insert(channelConnections).values({
      workspaceId,
      channel: "facebook_messenger",
      status: "connected",
      externalId: pageId,
    });
    await database.insert(workspaceBillingProfiles).values({
      workspaceId,
      countryCode: "BE",
      customerType: "consumer",
      verificationStatus: "verified",
      verificationMethod: "mysql_test",
      evidenceReferenceHash: "e".repeat(64),
      verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      verificationExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      verifiedByUserId: operatorUserId,
      peppolReady: false,
      eligibilityVersion: 1,
    });
    await database.insert(billingExecutionControls).values({
      workspaceId,
      mode: "test",
      commercialEnabled: true,
      authorizationEpoch: 1,
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
        executionEpoch: 1,
        operatorRequestId: randomUUID(),
        operatorRequestFingerprint: "f".repeat(64),
        enabledByUserId: operatorUserId,
        enabledAt: new Date(),
      }))
    );
    await database.insert(billingCustomers).values({
      workspaceId,
      mode: "test",
      mollieCustomerId: `cst_customer${workspaceId}`,
      externalReference: `workspace-${workspaceId}`,
      idempotencyKey: `customer-${workspaceId}`,
      status: "active",
    });
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      MOLLIE_BILLING_ENABLED: "true",
      MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED: "true",
      MOLLIE_API_KEY: "test_localfixture",
      MOLLIE_MODE: "test",
      MOLLIE_PAYMENT_WEBHOOK_URL:
        "http://billing.test/api/webhooks/mollie/payments",
      APP_BASE_URL: "http://leaderbot.test",
      PORTAL_BASE_URL: "http://leaderbot.test",
      BILLING_SUPPORT_EMAIL: "billing@leaderbot.test",
      PORTAL_HANDOFF_TOKEN_SECRET:
        "test-portal-handoff-secret-at-least-32-characters",
      MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
      MOLLIE_BILLING_WORKER_WORKSPACE_ID: String(workspaceId),
    };
  });

  afterEach(async () => {
    if (!workspaceId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(billingHandoffRecoveryEvents)
      .where(eq(billingHandoffRecoveryEvents.workspaceId, workspaceId));
    await database
      .delete(billingOutbox)
      .where(eq(billingOutbox.workspaceId, workspaceId));
    await database
      .delete(workspaceEntitlementUsage)
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));
    await database
      .delete(workspaceEntitlements)
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));
    await database
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.workspaceId, workspaceId));
    await database
      .delete(paymentLedger)
      .where(eq(paymentLedger.workspaceId, workspaceId));
    await database
      .delete(billingWebhookRoutes)
      .where(eq(billingWebhookRoutes.workspaceId, workspaceId));
    await database
      .delete(billingProviderOperations)
      .where(eq(billingProviderOperations.workspaceId, workspaceId));
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
      .delete(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, workspaceId));
    await database
      .delete(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId));
    await database
      .delete(portalHandoffTokens)
      .where(eq(portalHandoffTokens.workspaceId, workspaceId));
    await database
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    if (claimantUserId) {
      await database.delete(users).where(eq(users.id, claimantUserId));
    }
    await database.delete(users).where(eq(users.id, operatorUserId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    workspaceId = 0;
    operatorUserId = 0;
    claimantUserId = 0;
    pageId = "";
    process.env = { ...originalEnv };
  });

  it("reserves twelve repeated checkouts with one intent and provider create", async () => {
    const paymentId = `tr_checkout${workspaceId}`;
    const customerId = `cst_customer${workspaceId}`;
    let storedIntentId = "";
    const paymentFor = (intentId: string) => ({
      resource: "payment" as const,
      id: paymentId,
      mode: "test" as const,
      status: "open" as const,
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot - eenmalig 30 dagen",
      customerId,
      metadata: { billingIntentId: intentId },
      createdAt: "2026-08-18T10:00:00.000Z",
    });
    const createOneTimePayment = vi.fn(async (input: { intentId: string }) => {
      storedIntentId = input.intentId;
      return paymentFor(input.intentId);
    });
    const client = {
      listMethods: vi.fn(async () => [
        { resource: "method", id: "bancontact", status: "active" },
      ]),
      createOneTimePayment,
      getPayment: vi.fn(async () => paymentFor(storedIntentId)),
      getHostedCheckoutUrl: vi.fn(
        () => `https://checkout.mollie.test/pay/${paymentId}`
      ),
    } as unknown as MollieClient;

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        startMollieCheckout(
          {
            workspaceId,
            planCode: "startpilot_once_v1",
            kind: "startpilot_purchase",
            businessCheckout: false,
          },
          client
        )
      )
    );

    expect(createOneTimePayment).toHaveBeenCalledOnce();
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    const database = await getDatabaseOrThrow();
    const intents = await database
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId));
    expect(intents).toHaveLength(1);
    expect(storedIntentId).toBe(intents[0]?.intentId);
    expect(
      await database
        .select()
        .from(billingProviderOperations)
        .where(
          and(
            eq(billingProviderOperations.workspaceId, workspaceId),
            eq(billingProviderOperations.operationType, "create_payment")
          )
        )
    ).toHaveLength(1);
  });

  it("runs claim through paid outbox recovery without a second checkout", async () => {
    const database = await getDatabaseOrThrow();
    const claimantOpenId = `payment-claimant-${workspaceId}`;
    await database.insert(users).values({
      openId: claimantOpenId,
      role: "user",
      loginMethod: "facebook",
    });
    claimantUserId = (
      await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.openId, claimantOpenId))
        .limit(1)
    )[0]!.id;
    const senderKey = "a".repeat(64);
    const tokenHash = `sha256:${"b".repeat(64)}`;
    await createOrGetPortalHandoffToken(
      {
        workspaceId,
        tokenHash,
        deliveryIdempotencyKeyHash: `sha256:${"c".repeat(64)}`,
        messengerSenderUserKey: senderKey,
        facebookPageId: pageId,
        purpose: "workspace_onboarding",
        status: "pending",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        createdByUserId: null,
      },
      new Date()
    );
    await expect(
      claimPortalHandoffTokenForUser({
        tokenHash,
        userId: claimantUserId,
        now: new Date(),
      })
    ).resolves.toMatchObject({ ok: true, membership: { role: "owner" } });

    const unpaidIntentId = randomUUID();
    const nonRecoverableIntentId = randomUUID();
    await insertIntent(unpaidIntentId, `tr_unpaid${workspaceId}`);
    await insertIntent(
      nonRecoverableIntentId,
      `tr_nonrecoverable${workspaceId}`
    );
    await database
      .update(billingIntents)
      .set({ status: "failed" })
      .where(eq(billingIntents.intentId, unpaidIntentId));
    await database
      .update(billingIntents)
      .set({ status: "canceled" })
      .where(eq(billingIntents.intentId, nonRecoverableIntentId));
    await database.insert(billingOutbox).values([
      {
        workspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `unpaid-handoff:${unpaidIntentId}`,
        payload: {
          intentId: unpaidIntentId,
          messengerSenderUserKey: senderKey,
          messengerPageId: pageId,
        },
        status: "failed",
        attemptCount: 2,
        lastErrorCode: "portal_handoff_send_failed_exhausted",
      },
      {
        workspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `nonrecoverable-handoff:${nonRecoverableIntentId}`,
        payload: {
          intentId: nonRecoverableIntentId,
          messengerSenderUserKey: senderKey,
          messengerPageId: pageId,
        },
        status: "failed",
        attemptCount: 3,
        lastErrorCode: "privacy_erased",
      },
      {
        workspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `wrong-page-handoff:${unpaidIntentId}`,
        payload: {
          intentId: unpaidIntentId,
          messengerSenderUserKey: senderKey,
          messengerPageId: `${pageId}-other`,
        },
        status: "failed",
        attemptCount: 1,
        lastErrorCode: "portal_handoff_page_binding_unavailable",
      },
    ]);

    const paymentId = `tr_chain${workspaceId}`;
    const customerId = `cst_customer${workspaceId}`;
    let createdIntentId = "";
    const createOneTimePayment = vi.fn(async (input: { intentId: string }) => {
      createdIntentId = input.intentId;
      return {
        resource: "payment" as const,
        id: paymentId,
        mode: "test" as const,
        status: "open" as const,
        amount: { currency: "EUR", value: "19.00" },
        description: "Leaderbot Startpilot - eenmalig 30 dagen",
        customerId,
        metadata: { billingIntentId: input.intentId },
        createdAt: "2026-08-18T10:00:00.000Z",
      };
    });
    const client = {
      listMethods: vi.fn(async () => [
        { resource: "method", id: "bancontact", status: "active" },
      ]),
      createOneTimePayment,
      getHostedCheckoutUrl: vi.fn(
        () => `https://checkout.mollie.test/pay/${paymentId}`
      ),
    } as unknown as MollieClient;
    await expect(
      startMollieCheckout(
        {
          workspaceId,
          planCode: "startpilot_once_v1",
          kind: "startpilot_purchase",
          businessCheckout: false,
          messengerSenderUserKey: senderKey,
          messengerPageId: pageId,
        },
        client
      )
    ).resolves.toMatchObject({ intentId: expect.any(String), status: "open" });

    await expect(
      applyMolliePaymentSnapshot(
        paymentSnapshot({
          intentId: createdIntentId,
          paymentId,
          status: "paid",
        }),
        workspaceId
      )
    ).resolves.toMatchObject({ result: "processed" });
    const handoff = (
      await database
        .select()
        .from(billingOutbox)
        .where(
          and(
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.eventType, "send_portal_handoff"),
            eq(
              billingOutbox.deduplicationKey,
              `send_portal_handoff:${createdIntentId}`
            )
          )
        )
        .limit(1)
    )[0]!;
    await database
      .update(billingOutbox)
      .set({
        status: "failed",
        attemptCount: 12,
        lastErrorCode: "portal_handoff_send_failed_exhausted",
      })
      .where(eq(billingOutbox.id, handoff.id));
    const now = new Date();
    const beforeRecovery = {
      intents: (
        await database
          .select({ id: billingIntents.intentId })
          .from(billingIntents)
          .where(eq(billingIntents.workspaceId, workspaceId))
      ).length,
      ledger: (
        await database
          .select({ id: paymentLedger.id })
          .from(paymentLedger)
          .where(eq(paymentLedger.workspaceId, workspaceId))
      ).length,
      entitlements: (
        await database
          .select({ id: workspaceEntitlements.id })
          .from(workspaceEntitlements)
          .where(eq(workspaceEntitlements.workspaceId, workspaceId))
      ).length,
      outbox: (
        await database
          .select({ id: billingOutbox.id })
          .from(billingOutbox)
          .where(eq(billingOutbox.workspaceId, workspaceId))
      ).length,
    };
    await database
      .update(channelConnections)
      .set({ status: "disconnected" })
      .where(eq(channelConnections.workspaceId, workspaceId));
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: senderKey,
        eventIdHash: "d".repeat(64),
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(false);
    await database
      .update(channelConnections)
      .set({ status: "connected" })
      .where(eq(channelConnections.workspaceId, workspaceId));
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: senderKey,
        eventIdHash: "d".repeat(64),
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(true);

    expect(createOneTimePayment).toHaveBeenCalledOnce();
    expect(
      await database
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, claimantUserId)
          )
        )
    ).toHaveLength(1);
    const afterRecovery = {
      intents: (
        await database
          .select({ id: billingIntents.intentId })
          .from(billingIntents)
          .where(eq(billingIntents.workspaceId, workspaceId))
      ).length,
      ledger: (
        await database
          .select({ id: paymentLedger.id })
          .from(paymentLedger)
          .where(eq(paymentLedger.workspaceId, workspaceId))
      ).length,
      entitlements: (
        await database
          .select({ id: workspaceEntitlements.id })
          .from(workspaceEntitlements)
          .where(eq(workspaceEntitlements.workspaceId, workspaceId))
      ).length,
      outbox: (
        await database
          .select({ id: billingOutbox.id })
          .from(billingOutbox)
          .where(eq(billingOutbox.workspaceId, workspaceId))
      ).length,
    };
    expect(afterRecovery).toEqual(beforeRecovery);
    expect(afterRecovery).toEqual({
      intents: 3,
      ledger: 1,
      entitlements: 1,
      outbox: 4,
    });
    expect(
      (
        await database
          .select({
            status: billingOutbox.status,
            attemptCount: billingOutbox.attemptCount,
          })
          .from(billingOutbox)
          .where(eq(billingOutbox.id, handoff.id))
      )[0]
    ).toEqual({ status: "pending", attemptCount: 0 });
    expect(
      await database
        .select({ status: billingOutbox.status })
        .from(billingOutbox)
        .where(
          and(
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.status, "failed")
          )
        )
    ).toHaveLength(3);
  });

  it("applies twelve concurrent paid snapshots exactly once", async () => {
    const intentId = randomUUID();
    const paymentId = `tr_paid${workspaceId}`;
    await insertIntent(intentId, paymentId);
    const payment = paymentSnapshot({ intentId, paymentId, status: "paid" });

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        applyMolliePaymentSnapshot(payment, workspaceId)
      )
    );

    expect(
      results.filter(result => result.result === "processed")
    ).toHaveLength(1);
    expect(
      results.filter(result => result.result === "duplicate")
    ).toHaveLength(11);
    const database = await getDatabaseOrThrow();
    const ledger = await database
      .select()
      .from(paymentLedger)
      .where(eq(paymentLedger.workspaceId, workspaceId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: "paid", paidEffectApplied: 1 });
    expect(
      await database
        .select()
        .from(workspaceEntitlements)
        .where(eq(workspaceEntitlements.workspaceId, workspaceId))
    ).toHaveLength(1);
    expect(
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
    ).toHaveLength(1);
    const handoffs = await database
      .select()
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "send_portal_handoff")
        )
      );
    expect(handoffs).toHaveLength(1);
  });

  it("keeps paid truth after an older terminal snapshot and deduplicates paid replay", async () => {
    const intentId = randomUUID();
    const paymentId = `tr_order${workspaceId}`;
    await insertIntent(intentId, paymentId);

    await expect(
      applyMolliePaymentSnapshot(
        paymentSnapshot({ intentId, paymentId, status: "open" }),
        workspaceId
      )
    ).resolves.toMatchObject({ result: "processed" });
    const paid = paymentSnapshot({ intentId, paymentId, status: "paid" });
    await expect(
      applyMolliePaymentSnapshot(paid, workspaceId)
    ).resolves.toMatchObject({ result: "processed" });
    await expect(
      applyMolliePaymentSnapshot(
        paymentSnapshot({
          intentId,
          paymentId,
          status: "failed",
          occurredAt: "2026-08-18T11:00:00.000Z",
        }),
        workspaceId
      )
    ).resolves.toMatchObject({ result: "processed" });
    await expect(
      applyMolliePaymentSnapshot(paid, workspaceId)
    ).resolves.toMatchObject({ result: "duplicate" });

    const database = await getDatabaseOrThrow();
    expect(
      (
        await database
          .select({ status: billingIntents.status })
          .from(billingIntents)
          .where(eq(billingIntents.intentId, intentId))
      )[0]?.status
    ).toBe("paid");
    expect(
      (
        await database
          .select({
            status: paymentLedger.status,
            paidEffectApplied: paymentLedger.paidEffectApplied,
          })
          .from(paymentLedger)
          .where(eq(paymentLedger.molliePaymentId, paymentId))
      )[0]
    ).toEqual({ status: "paid", paidEffectApplied: 1 });
    expect(
      await database
        .select()
        .from(billingOutbox)
        .where(
          and(
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.eventType, "send_portal_handoff")
          )
        )
    ).toHaveLength(1);
    const stale = await database
      .select({ processingResult: webhookDeliveries.processingResult })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.workspaceId, workspaceId),
          eq(webhookDeliveries.processingResult, "stale_snapshot_ignored")
        )
      );
    expect(stale).toHaveLength(1);
  });

  it("records failed, canceled and expired snapshots without paid effects", async () => {
    for (const status of ["failed", "canceled", "expired"] as const) {
      const intentId = randomUUID();
      const paymentId = `tr_${status}${workspaceId}`;
      await insertIntent(intentId, paymentId);
      await expect(
        applyMolliePaymentSnapshot(
          paymentSnapshot({ intentId, paymentId, status }),
          workspaceId
        )
      ).resolves.toMatchObject({ result: "processed" });
    }

    const database = await getDatabaseOrThrow();
    expect(
      await database
        .select()
        .from(workspaceEntitlements)
        .where(eq(workspaceEntitlements.workspaceId, workspaceId))
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(billingOutbox)
        .where(eq(billingOutbox.workspaceId, workspaceId))
    ).toHaveLength(0);
    const ledgers = await database
      .select({ status: paymentLedger.status })
      .from(paymentLedger)
      .where(eq(paymentLedger.workspaceId, workspaceId));
    expect(ledgers.map(row => row.status).sort()).toEqual([
      "canceled",
      "expired",
      "failed",
    ]);
  });

  async function insertIntent(intentId: string, paymentId: string) {
    const database = await getDatabaseOrThrow();
    await database.insert(billingIntents).values({
      intentId,
      workspaceId,
      mode: "test",
      planCode: "startpilot_once_v1",
      kind: "startpilot_purchase",
      expectedAmount: "19.00",
      currency: "EUR",
      interval: "30 days",
      entitlements: {
        aiAnswersTotal: 300,
        imagesTotal: 20,
        imagesPerDay: 5,
        workspaces: 1,
        facebookPages: 1,
        imageQuality: "images_2",
      },
      mollieDescription: "Leaderbot Startpilot - eenmalig 30 dagen",
      status: "open",
      molliePaymentId: paymentId,
      idempotencyKey: `intent-${intentId}`,
      checkoutScopeKey: `checkout-${intentId}`,
      messengerSenderUserKey: "a".repeat(64),
      messengerPageId: String(10_000_000 + workspaceId),
      billingProfileVersion: 1,
      authorizationEpoch: 1,
    });
  }

  function paymentSnapshot(input: {
    intentId: string;
    paymentId: string;
    status: "open" | "paid" | "failed" | "canceled" | "expired";
    occurredAt?: string;
  }): MolliePayment {
    const createdAt = "2026-08-18T10:00:00.000Z";
    const occurredAt =
      input.occurredAt ??
      (input.status === "open" ? createdAt : "2026-08-18T12:00:00.000Z");
    return {
      resource: "payment",
      id: input.paymentId,
      mode: "test",
      status: input.status,
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot - eenmalig 30 dagen",
      customerId: `cst_customer${workspaceId}`,
      metadata: { billingIntentId: input.intentId },
      createdAt,
      ...(input.status === "paid" ? { paidAt: occurredAt } : {}),
      ...(input.status === "failed" ? { failedAt: occurredAt } : {}),
      ...(input.status === "canceled" ? { canceledAt: occurredAt } : {}),
      ...(input.status === "expired" ? { expiredAt: occurredAt } : {}),
    };
  }
});
