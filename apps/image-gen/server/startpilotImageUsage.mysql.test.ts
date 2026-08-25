import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  billingIntents,
  channelConnections,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
  workspaces,
} from "../drizzle/schema";
import { getDatabaseOrThrow } from "./db";
import {
  reserveStartpilotImageUsage,
  utcDateKey,
} from "./_core/billing/entitlementUsageStore";
import { getBillingPlan, STARTPILOT_PLAN_CODE } from "./_core/billing/catalog";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("Startpilot image usage MySQL races", () => {
  let workspaceId = 0;
  let connectionId = 0;
  let entitlementId = 0;
  let intentId = "";

  beforeEach(async () => {
    process.env.MOLLIE_MODE = "test";
    const database = await getDatabaseOrThrow();
    const suffix = randomUUID();
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const validUntil = new Date(now.getTime() + 24 * 60 * 60_000);
    const startpilot = getBillingPlan(STARTPILOT_PLAN_CODE);
    if (!startpilot) throw new Error("Startpilot fixture is unavailable");

    await database.insert(workspaces).values({
      name: `Startpilot image race ${suffix}`,
      slug: `startpilot-image-race-${suffix}`,
    });
    workspaceId = (
      await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, `startpilot-image-race-${suffix}`))
        .limit(1)
    )[0]!.id;

    await database.insert(channelConnections).values({
      workspaceId,
      channel: "facebook_messenger",
      status: "connected",
      externalId: `startpilot-image-page-${suffix}`,
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
      mollieDescription: "Startpilot image race fixture",
      status: "paid",
      idempotencyKey: `startpilot-image-intent-${suffix}`,
      checkoutScopeKey: `startpilot-image-scope-${suffix}`,
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
      .delete(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    workspaceId = 0;
  });

  it("allows exactly one request to take the last workspace slot", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    await database
      .update(workspaceEntitlementUsage)
      .set({
        imagesUsed: 19,
        imageUsageDate: utcDateKey(now),
        imagesUsedToday: 4,
      })
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));

    const results = await Promise.all([
      reserve("startpilot-image:mysql-last-slot-a", now),
      reserve("startpilot-image:mysql-last-slot-b", now),
    ]);

    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed)).toEqual([
      { allowed: false, reason: "total_exhausted" },
    ]);
    const usage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    expect(usage).toMatchObject({ imagesUsed: 20, imagesUsedToday: 5 });
  });

  it("counts concurrent retries with the same request id exactly once", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const key = "startpilot-image:mysql-same-request";

    const results = await Promise.all([reserve(key, now), reserve(key, now)]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ allowed: true, alreadyReserved: false }),
        expect.objectContaining({ allowed: true, alreadyReserved: true }),
      ])
    );
    const database = await getDatabaseOrThrow();
    const usage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    const receipts = await database
      .select()
      .from(workspaceEntitlementUsageReservations)
      .where(
        and(
          eq(workspaceEntitlementUsageReservations.workspaceId, workspaceId),
          eq(workspaceEntitlementUsageReservations.kind, "image")
        )
      );
    expect(usage).toMatchObject({ imagesUsed: 1, imagesUsedToday: 1 });
    expect(receipts).toHaveLength(1);
  });

  function reserve(idempotencyKey: string, now: Date) {
    return reserveStartpilotImageUsage({
      workspaceId,
      entitlementId,
      channelConnectionId: connectionId,
      bindingEpoch: 1,
      mode: "test",
      idempotencyKey,
      now,
    });
  }
});
