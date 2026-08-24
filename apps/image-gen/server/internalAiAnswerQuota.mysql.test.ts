import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import mysql, { type Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  billingIntents,
  billingSchedulerTenants,
  channelConnections,
  users,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
  workspaces,
} from "../drizzle/schema";
import {
  disconnectChannelConnection,
  getDatabaseOrThrow,
  upsertChannelConnection,
} from "./db";
import { reserveStartpilotAiAnswerUsage } from "./_core/billing/entitlementUsageStore";
import { getBillingPlan, STARTPILOT_PLAN_CODE } from "./_core/billing/catalog";
import { markInternalAiAnswerDeliveryStarted } from "./_core/internalAiAnswerQuota";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("AI answer delivery Page-binding barrier", () => {
  const ownerToken = "11111111-1111-4111-8111-111111111111";
  const pageId = `19${Date.now()}${process.pid}`;
  let workspaceId = 0;
  let userId = 0;
  let connectionId = 0;
  let entitlementId = 0;
  let intentId = "";
  let reservationId = "";
  let reservationKey = "";

  beforeEach(async () => {
    process.env.MOLLIE_BILLING_SCHEDULER_MODE = "multi_tenant";
    process.env.MOLLIE_MODE = "test";
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;

    const database = await getDatabaseOrThrow();
    const suffix = randomUUID();
    await database.insert(workspaces).values({
      name: `AI delivery barrier ${suffix}`,
      slug: `ai-delivery-barrier-${suffix}`,
    });
    workspaceId = (
      await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, `ai-delivery-barrier-${suffix}`))
        .limit(1)
    )[0]!.id;
    await database.insert(users).values({
      openId: `ai-delivery-operator-${suffix}`,
      loginMethod: "test",
      role: "admin",
    });
    userId = (
      await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.openId, `ai-delivery-operator-${suffix}`))
        .limit(1)
    )[0]!.id;
    await database.insert(channelConnections).values({
      workspaceId,
      channel: "facebook_messenger",
      status: "connected",
      externalId: pageId,
      bindingEpoch: 1,
    });
    connectionId = (
      await database
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(eq(channelConnections.workspaceId, workspaceId))
        .limit(1)
    )[0]!.id;

    intentId = randomUUID();
    const now = new Date();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60_000);
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const startpilot = getBillingPlan(STARTPILOT_PLAN_CODE);
    if (!startpilot) throw new Error("Startpilot fixture is unavailable");
    await database.insert(billingIntents).values({
      intentId,
      workspaceId,
      mode: "test",
      planCode: STARTPILOT_PLAN_CODE,
      kind: "startpilot_purchase",
      expectedAmount: "19.00",
      currency: "EUR",
      interval: "one_time",
      entitlements: startpilot.entitlements,
      mollieDescription: "AI delivery barrier fixture",
      status: "paid",
      idempotencyKey: `ai-delivery-${suffix}`,
      checkoutScopeKey: `ai-delivery-scope-${suffix}`,
      billingProfileVersion: 1,
      authorizationEpoch: 1,
    });
    await database.insert(workspaceEntitlements).values({
      workspaceId,
      mode: "test",
      planCode: STARTPILOT_PLAN_CODE,
      status: "active",
      quota: startpilot.entitlements,
      sourceIntentId: intentId,
      validUntil,
    });
    entitlementId = (
      await database
        .select({ id: workspaceEntitlements.id })
        .from(workspaceEntitlements)
        .where(eq(workspaceEntitlements.workspaceId, workspaceId))
        .limit(1)
    )[0]!.id;
    await database.insert(workspaceEntitlementUsage).values({
      workspaceId,
      mode: "test",
      entitlementId,
      planCode: STARTPILOT_PLAN_CODE,
      sourceIntentId: intentId,
      periodStartedAt: now,
      periodEndsAt: validUntil,
      aiAnswersReserved: 1,
    });
    reservationId = randomUUID();
    reservationKey = `ai-delivery-reservation-${suffix}`;
    await database.insert(workspaceEntitlementUsageReservations).values({
      reservationId,
      workspaceId,
      mode: "test",
      entitlementId,
      channelConnectionId: connectionId,
      bindingEpoch: 1,
      kind: "ai_answer",
      status: "reserved",
      idempotencyKey: reservationKey,
      ownerTokenHash: createHash("sha256").update(ownerToken).digest("hex"),
      ownerLeaseUntil: expiresAt,
      expiresAt,
      resolutionDueAt: expiresAt,
    });
    await database.insert(billingSchedulerTenants).values({
      workspaceId,
      mode: "test",
      kind: "ai_finalization",
      enabled: true,
      executionEpoch: 1,
      operatorRequestId: randomUUID(),
      operatorRequestFingerprint: "a".repeat(64),
      enabledByUserId: userId,
      enabledAt: now,
      nextDueAt: now,
    });
  });

  afterEach(async () => {
    if (!workspaceId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(workspaceEntitlementUsageReservations)
      .where(
        eq(workspaceEntitlementUsageReservations.workspaceId, workspaceId)
      );
    await database
      .delete(workspaceEntitlementUsage)
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));
    await database
      .delete(workspaceEntitlements)
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));
    await database
      .delete(billingSchedulerTenants)
      .where(eq(billingSchedulerTenants.workspaceId, workspaceId));
    await database
      .delete(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    await database.delete(users).where(eq(users.id, userId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    workspaceId = 0;
  });

  it("blocks disconnect when delivery-start owns the Page lock first", async () => {
    const blocker = await connectRaw();
    const observer = await connectRaw();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT reservation_id FROM workspace_entitlement_usage_reservations WHERE reservation_id=? FOR UPDATE",
        [reservationId]
      );

      const deliveryResult = settle(
        markInternalAiAnswerDeliveryStarted({
          pageId,
          reservationId,
          ownerToken,
          deliveryAttemptToken: randomUUID(),
        })
      );
      await waitForLockWait(
        observer,
        "workspace_entitlement_usage_reservations",
        1
      );

      const disconnectResult = settle(
        disconnectChannelConnection(workspaceId, "facebook_messenger")
      );
      await waitForLockWait(observer, "channelConnections", 1);
      await blocker.commit();

      expect(await deliveryResult).toMatchObject({
        ok: true,
        value: { status: "delivery_started" },
      });
      const disconnected = await disconnectResult;
      expect(disconnected.ok).toBe(false);
      expect(errorMessage(disconnected)).toContain(
        "active AI delivery; retry later"
      );
    } finally {
      await rollbackQuietly(blocker);
      await blocker.end();
      await observer.end();
    }
  });

  it("denies delivery-start when disconnect owns the Page lock first", async () => {
    const blocker = await connectRaw();
    const observer = await connectRaw();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT id FROM `channelConnections` WHERE id=? FOR UPDATE",
        [connectionId]
      );

      const disconnectResult = settle(
        disconnectChannelConnection(workspaceId, "facebook_messenger")
      );
      await waitForLockWait(observer, "channelConnections", 1);
      const deliveryResult = settle(
        markInternalAiAnswerDeliveryStarted({
          pageId,
          reservationId,
          ownerToken,
          deliveryAttemptToken: randomUUID(),
        })
      );
      await waitForLockWait(observer, "channelConnections", 2);
      await blocker.commit();

      expect(await disconnectResult).toMatchObject({ ok: true });
      const delivery = await deliveryResult;
      expect(delivery.ok).toBe(false);
      expect(errorCode(delivery)).toBe("reservation_scope_unavailable");

      const database = await getDatabaseOrThrow();
      const stored = await database
        .select({
          deliveryStartedAt:
            workspaceEntitlementUsageReservations.deliveryStartedAt,
        })
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(workspaceEntitlementUsageReservations.reservationId, reservationId)
        )
        .limit(1);
      expect(stored[0]?.deliveryStartedAt).toBeNull();
    } finally {
      await rollbackQuietly(blocker);
      await blocker.end();
      await observer.end();
    }
  });

  it("keeps quota reserve behind delivery-start in the canonical Page lock order", async () => {
    const blocker = await connectRaw();
    const observer = await connectRaw();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT reservation_id FROM workspace_entitlement_usage_reservations WHERE reservation_id=? FOR UPDATE",
        [reservationId]
      );

      const deliveryResult = settle(
        markInternalAiAnswerDeliveryStarted({
          pageId,
          reservationId,
          ownerToken,
          deliveryAttemptToken: randomUUID(),
        })
      );
      await waitForLockWait(
        observer,
        "workspace_entitlement_usage_reservations",
        1
      );

      const reserveResult = settle(
        reserveStartpilotAiAnswerUsage({
          workspaceId,
          entitlementId,
          channelConnectionId: connectionId,
          bindingEpoch: 1,
          mode: "test",
          idempotencyKey: reservationKey,
          ownerToken,
        })
      );
      await waitForLockWait(observer, "channelConnections", 1);
      await blocker.commit();

      expect(await deliveryResult).toMatchObject({
        ok: true,
        value: { status: "delivery_started" },
      });
      expect(await reserveResult).toMatchObject({
        ok: true,
        value: {
          allowed: true,
          reservationId,
          alreadyReserved: true,
        },
      });
    } finally {
      await rollbackQuietly(blocker);
      await blocker.end();
      await observer.end();
    }
  });

  it("blocks Page rebind when delivery-start owns the Page lock first", async () => {
    const blocker = await connectRaw();
    const observer = await connectRaw();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT reservation_id FROM workspace_entitlement_usage_reservations WHERE reservation_id=? FOR UPDATE",
        [reservationId]
      );

      const deliveryResult = settle(
        markInternalAiAnswerDeliveryStarted({
          pageId,
          reservationId,
          ownerToken,
          deliveryAttemptToken: randomUUID(),
        })
      );
      await waitForLockWait(
        observer,
        "workspace_entitlement_usage_reservations",
        1
      );
      const rebindResult = settle(
        upsertChannelConnection({
          workspaceId,
          channel: "facebook_messenger",
          status: "connected",
          externalId: pageId,
        })
      );
      await waitForLockWait(observer, "channelConnections", 1);
      await blocker.commit();

      expect(await deliveryResult).toMatchObject({
        ok: true,
        value: { status: "delivery_started" },
      });
      const rebound = await rebindResult;
      expect(rebound.ok).toBe(false);
      expect(errorMessage(rebound)).toContain(
        "active AI delivery; retry later"
      );
      const database = await getDatabaseOrThrow();
      const binding = await database
        .select({ bindingEpoch: channelConnections.bindingEpoch })
        .from(channelConnections)
        .where(eq(channelConnections.id, connectionId))
        .limit(1);
      expect(binding[0]?.bindingEpoch).toBe(1);
    } finally {
      await rollbackQuietly(blocker);
      await blocker.end();
      await observer.end();
    }
  });

  it("denies delivery-start when Page rebind owns the Page lock first", async () => {
    const blocker = await connectRaw();
    const observer = await connectRaw();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT id FROM `channelConnections` WHERE id=? FOR UPDATE",
        [connectionId]
      );

      const rebindResult = settle(
        upsertChannelConnection({
          workspaceId,
          channel: "facebook_messenger",
          status: "connected",
          externalId: pageId,
        })
      );
      await waitForLockWait(observer, "channelConnections", 1);
      const deliveryResult = settle(
        markInternalAiAnswerDeliveryStarted({
          pageId,
          reservationId,
          ownerToken,
          deliveryAttemptToken: randomUUID(),
        })
      );
      await waitForLockWait(observer, "channelConnections", 2);
      await blocker.commit();

      expect(await rebindResult).toMatchObject({ ok: true });
      const delivery = await deliveryResult;
      expect(delivery.ok).toBe(false);
      expect(errorCode(delivery)).toBe("reservation_scope_unavailable");

      const database = await getDatabaseOrThrow();
      const stored = await database
        .select({
          deliveryStartedAt:
            workspaceEntitlementUsageReservations.deliveryStartedAt,
        })
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(workspaceEntitlementUsageReservations.reservationId, reservationId)
        )
        .limit(1);
      expect(stored[0]?.deliveryStartedAt).toBeNull();
      const binding = await database
        .select({ bindingEpoch: channelConnections.bindingEpoch })
        .from(channelConnections)
        .where(eq(channelConnections.id, connectionId))
        .limit(1);
      expect(binding[0]?.bindingEpoch).toBe(2);
    } finally {
      await rollbackQuietly(blocker);
      await blocker.end();
      await observer.end();
    }
  });
});

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorMessage(result: Settled<unknown>): string {
  return result.ok
    ? ""
    : result.error instanceof Error
      ? result.error.message
      : String(result.error);
}

function errorCode(result: Settled<unknown>): string | undefined {
  if (result.ok || !result.error || typeof result.error !== "object") {
    return undefined;
  }
  return "code" in result.error && typeof result.error.code === "string"
    ? result.error.code
    : undefined;
}

async function connectRaw(): Promise<Connection> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for MySQL integration");
  return mysql.createConnection(url);
}

async function waitForLockWait(
  observer: Connection,
  objectName: string,
  expected: number
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [[row]] = await observer.query<Array<{ waiting: number }>>(
      `SELECT COUNT(DISTINCT requested.THREAD_ID) AS waiting
       FROM performance_schema.data_lock_waits AS waits
       JOIN performance_schema.data_locks AS requested
         ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
       WHERE requested.OBJECT_SCHEMA=DATABASE()
         AND requested.OBJECT_NAME=?`,
      [objectName]
    );
    if (Number(row?.waiting ?? 0) >= expected) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`MySQL lock barrier did not observe ${objectName}`);
}

async function rollbackQuietly(connection: Connection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // The transaction may already be committed; cleanup remains best effort.
  }
}
