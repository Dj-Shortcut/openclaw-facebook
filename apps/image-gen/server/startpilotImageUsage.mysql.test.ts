import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  billingIntents,
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
  workspaces,
} from "../drizzle/schema";
import { getDatabaseOrThrow, getWorkspaceUsageSummary } from "./db";
import { utcDateKey } from "./_core/billing/entitlementUsageStore";
import {
  getBillingPlan,
  PREMIUM_MONTHLY_PLAN_CODE,
  STARTPILOT_PLAN_CODE,
} from "./_core/billing/catalog";
import {
  containMessengerProviderAttemptsForPrivacy,
  reserveMessengerProviderAttemptFence,
} from "./_core/messengerProviderAttemptFence";
import {
  admitStartpilotImageProviderAttempt,
  recoverStartpilotImageProviderAdmission,
} from "./_core/startpilotImageProviderAdmission";
import type { MessengerGenerationJob } from "./_core/messengerGenerationJob";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("Startpilot image usage MySQL races", () => {
  let workspaceId = 0;
  let connectionId = 0;
  let entitlementId = 0;
  let intentId = "";
  let pageId = "";

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

    pageId = `startpilot-image-page-${suffix}`;
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
      .delete(messengerProviderAttemptFences)
      .where(eq(messengerProviderAttemptFences.workspaceId, workspaceId));
    await database
      .delete(messengerPrivacySubjects)
      .where(eq(messengerPrivacySubjects.workspaceId, workspaceId));
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
    pageId = "";
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

    const first = await prepareFence("mysql-last-slot-a", now);
    const second = await prepareFence("mysql-last-slot-b", now);
    const results = await Promise.all([
      admit(first, "startpilot-image:mysql-last-slot-a", now),
      admit(second, "startpilot-image:mysql-last-slot-b", now),
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
    const fences = await database
      .select({ status: messengerProviderAttemptFences.status })
      .from(messengerProviderAttemptFences)
      .where(eq(messengerProviderAttemptFences.workspaceId, workspaceId));
    expect(fences.map(row => row.status).sort()).toEqual([
      "known_failed",
      "started",
    ]);
  });

  it("counts a concurrently repeated request exactly once", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const key = "startpilot-image:mysql-same-request";
    const fence = await prepareFence("mysql-same-request", now);

    const results = await Promise.allSettled([
      admit(fence, key, now),
      admit(fence, key, now),
    ]);

    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1
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
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe("started");
  });

  it("reports the exact paid daily and period image balances", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    await database
      .update(workspaceEntitlementUsage)
      .set({
        imagesUsed: 12,
        imageUsageDate: utcDateKey(now),
        imagesUsedToday: 3,
      })
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));

    await expect(getWorkspaceUsageSummary(workspaceId)).resolves.toMatchObject({
      workspaceId,
      plan: { name: "Leaderbot Startpilot", billingStatus: "active" },
      imageCount: 3,
      imageCountInPeriod: 12,
      limits: { imagesPerDay: 5, imagesPerPeriod: 20 },
      remaining: { imagesToday: 2, imagesInPeriod: 8 },
    });
    await expect(
      getWorkspaceUsageSummary(workspaceId + 1_000_000)
    ).resolves.toMatchObject({
      plan: { name: "Free", billingStatus: "free" },
      imageCount: 0,
      imageCountInPeriod: null,
      remaining: { imagesInPeriod: null },
    });

    await database
      .update(workspaceEntitlementUsage)
      .set({ imageUsageDate: "2000-01-01", imagesUsedToday: 3 })
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));
    await expect(getWorkspaceUsageSummary(workspaceId)).resolves.toMatchObject({
      imageCount: 0,
      imageCountInPeriod: 12,
      remaining: { imagesToday: 5, imagesInPeriod: 8 },
    });
  });

  it("fails closed when an active paid entitlement has no usage row", async () => {
    const database = await getDatabaseOrThrow();
    await database
      .delete(workspaceEntitlementUsage)
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));

    await expect(getWorkspaceUsageSummary(workspaceId)).rejects.toThrow(
      "Workspace paid usage summary is inconsistent"
    );
  });

  it("reads a retained Premium limit and usage from its paid snapshots", async () => {
    const database = await getDatabaseOrThrow();
    const premium = getBillingPlan(PREMIUM_MONTHLY_PLAN_CODE);
    if (!premium) throw new Error("Premium fixture is unavailable");
    const retainedQuota = { ...premium.entitlements, imagesPerDay: 73 };
    await database
      .update(workspaceEntitlements)
      .set({
        planCode: PREMIUM_MONTHLY_PLAN_CODE,
        quota: retainedQuota,
        validUntil: null,
      })
      .where(eq(workspaceEntitlements.id, entitlementId));
    await database
      .update(workspaceEntitlementUsage)
      .set({
        planCode: PREMIUM_MONTHLY_PLAN_CODE,
        imageUsageDate: utcDateKey(new Date()),
        imagesUsedToday: 7,
      })
      .where(eq(workspaceEntitlementUsage.entitlementId, entitlementId));

    await expect(getWorkspaceUsageSummary(workspaceId)).resolves.toMatchObject({
      plan: { name: "Leaderbot Premium", billingStatus: "active" },
      imageCount: 7,
      imageCountInPeriod: null,
      limits: { imagesPerDay: 73, imagesPerPeriod: null },
      remaining: { imagesToday: 66, imagesInPeriod: null },
    });
  });

  it("rolls back the paid receipt when provider-fence ownership is lost", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    const fence = await prepareFence("mysql-fence-lost", now);
    await database
      .update(messengerProviderAttemptFences)
      .set({ status: "known_failed", completedAt: now, leaseUntil: now })
      .where(
        eq(messengerProviderAttemptFences.attemptKeyHash, fence.attemptKeyHash!)
      );

    await expect(
      admit(fence, "startpilot-image:mysql-fence-lost", now)
    ).rejects.toThrow("Startpilot provider admission ownership was lost");

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
        eq(workspaceEntitlementUsageReservations.workspaceId, workspaceId)
      );
    expect(usage).toMatchObject({ imagesUsed: 0, imagesUsedToday: 0 });
    expect(receipts).toHaveLength(0);
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe(
      "known_failed"
    );
  });

  it("atomically recovers a committed paid admission before provider transport", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    const fence = await prepareFence("mysql-admission-ack-lost", now);
    const idempotencyKey = "startpilot-image:mysql-admission-ack-lost";

    await expect(admit(fence, idempotencyKey, now)).resolves.toMatchObject({
      allowed: true,
      alreadyReserved: false,
    });
    await expect(
      recover(fence, idempotencyKey, new Date(now.getTime() + 1_000))
    ).resolves.toBeUndefined();
    await expect(
      recover(fence, idempotencyKey, new Date(now.getTime() + 2_000))
    ).resolves.toBeUndefined();

    const usage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    let receipt = (
      await database
        .select()
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            idempotencyKey
          )
        )
        .limit(1)
    )[0]!;
    expect(usage).toMatchObject({ imagesUsed: 0, imagesUsedToday: 0 });
    expect(receipt.status).toBe("released");
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe(
      "known_failed"
    );

    const retryFence = await reserveFence(
      "mysql-admission-ack-lost",
      new Date(now.getTime() + 3_000)
    );
    await expect(
      admit(retryFence, idempotencyKey, new Date(now.getTime() + 3_000))
    ).resolves.toMatchObject({
      allowed: true,
      alreadyReserved: false,
      imagesUsed: 1,
      imagesUsedToday: 1,
    });
    const recoveredUsage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    receipt = (
      await database
        .select()
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            idempotencyKey
          )
        )
        .limit(1)
    )[0]!;
    expect(recoveredUsage).toMatchObject({
      imagesUsed: 1,
      imagesUsedToday: 1,
    });
    expect(receipt.status).toBe("committed");
    await expect(fenceStatus(retryFence.attemptKeyHash!)).resolves.toBe(
      "started"
    );
  });

  it("releases one paid credit when original and shadow recovery race", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    const fence = await prepareFence("mysql-recovery-shadow-race", now);
    const idempotencyKey = "startpilot-image:mysql-recovery-shadow-race";

    await expect(admit(fence, idempotencyKey, now)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      Promise.all([
        recover(fence, idempotencyKey, new Date(now.getTime() + 1_000)),
        recover(fence, idempotencyKey, new Date(now.getTime() + 1_001)),
      ])
    ).resolves.toEqual([undefined, undefined]);

    const usage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    const receipt = (
      await database
        .select()
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            idempotencyKey
          )
        )
        .limit(1)
    )[0]!;
    expect(usage).toMatchObject({ imagesUsed: 0, imagesUsedToday: 0 });
    expect(receipt.status).toBe("released");
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe(
      "known_failed"
    );
  });

  it("refuses recovery for a different historical Page binding", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    const fence = await prepareFence("mysql-recovery-wrong-page", now);
    const idempotencyKey = "startpilot-image:mysql-recovery-wrong-page";

    await expect(admit(fence, idempotencyKey, now)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      recoverStartpilotImageProviderAdmission({
        fence: { ...fence, pageId: "another-page" },
        providerOperation: "image_from_text",
        workspaceId,
        entitlementId,
        channelConnectionId: connectionId,
        bindingEpoch: 1,
        mode: "test",
        idempotencyKey,
        pageIdHash: createHash("sha256").update(pageId).digest("hex"),
        now: new Date(now.getTime() + 1_000),
      })
    ).rejects.toThrow("Startpilot provider recovery owner scope mismatch");

    const usage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    const receipt = (
      await database
        .select()
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            idempotencyKey
          )
        )
        .limit(1)
    )[0]!;
    expect(usage).toMatchObject({ imagesUsed: 1, imagesUsedToday: 1 });
    expect(receipt.status).toBe("committed");
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe("started");
  });

  it("keeps paid compensation idempotent across privacy containment", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    const fence = await prepareFence("mysql-recovery-privacy", now);
    const idempotencyKey = "startpilot-image:mysql-recovery-privacy";

    await expect(admit(fence, idempotencyKey, now)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(
      recover(fence, idempotencyKey, new Date(now.getTime() + 1_000))
    ).resolves.toBeUndefined();
    await expect(
      containMessengerProviderAttemptsForPrivacy(
        {
          workspaceId,
          channelConnectionId: connectionId,
          userKey: fence.userKey!,
        },
        new Date(now.getTime() + 2_000)
      )
    ).resolves.toBe(true);
    await expect(
      recover(fence, idempotencyKey, new Date(now.getTime() + 3_000))
    ).resolves.toBeUndefined();

    const usage = (
      await database
        .select()
        .from(workspaceEntitlementUsage)
        .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    const receipt = (
      await database
        .select()
        .from(workspaceEntitlementUsageReservations)
        .where(
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            idempotencyKey
          )
        )
        .limit(1)
    )[0]!;
    expect(usage).toMatchObject({ imagesUsed: 0, imagesUsedToday: 0 });
    expect(receipt.status).toBe("released");
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe("contained");
  });

  it("marks an exhausted paid attempt known-failed without consuming usage", async () => {
    const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const database = await getDatabaseOrThrow();
    await database
      .update(workspaceEntitlementUsage)
      .set({
        imagesUsed: 20,
        imageUsageDate: utcDateKey(now),
        imagesUsedToday: 4,
      })
      .where(eq(workspaceEntitlementUsage.workspaceId, workspaceId));
    const fence = await prepareFence("mysql-exhausted", now);

    await expect(
      admit(fence, "startpilot-image:mysql-exhausted", now)
    ).resolves.toEqual({ allowed: false, reason: "total_exhausted" });

    const receipts = await database
      .select()
      .from(workspaceEntitlementUsageReservations)
      .where(
        eq(workspaceEntitlementUsageReservations.workspaceId, workspaceId)
      );
    expect(receipts).toHaveLength(0);
    await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe(
      "known_failed"
    );
  });

  it.each([
    ["binding", "Startpilot provider ownership changed"],
    ["privacy", "Startpilot provider privacy changed"],
  ] as const)(
    "refuses a changed %s scope before consuming paid usage",
    async (scope, expectedError) => {
      const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      const database = await getDatabaseOrThrow();
      const fence = await prepareFence(`mysql-${scope}-changed`, now);
      if (scope === "binding") {
        await database
          .update(channelConnections)
          .set({ status: "disconnected" })
          .where(eq(channelConnections.id, connectionId));
      } else {
        await database
          .update(messengerPrivacySubjects)
          .set({ status: "erasing" })
          .where(
            and(
              eq(messengerPrivacySubjects.workspaceId, workspaceId),
              eq(messengerPrivacySubjects.userKey, fence.userKey!)
            )
          );
      }

      await expect(
        admit(fence, `startpilot-image:mysql-${scope}-changed`, now)
      ).rejects.toThrow(expectedError);

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
          eq(workspaceEntitlementUsageReservations.workspaceId, workspaceId)
        );
      expect(usage).toMatchObject({ imagesUsed: 0, imagesUsedToday: 0 });
      expect(receipts).toHaveLength(0);
      await expect(fenceStatus(fence.attemptKeyHash!)).resolves.toBe(
        "reserved"
      );
    }
  );

  async function prepareFence(reqId: string, now: Date) {
    const database = await getDatabaseOrThrow();
    const userKey = `user:${reqId}`;
    await database.insert(messengerPrivacySubjects).values({
      workspaceId,
      channelConnectionId: connectionId,
      userKey,
      privacyEpoch: 1,
      status: "active",
    });
    return reserveFence(reqId, now);
  }

  function reserveFence(reqId: string, now: Date) {
    const userKey = `user:${reqId}`;
    const job: MessengerGenerationJob = {
      psid: `psid:${reqId}`,
      userId: userKey,
      pageId,
      workspaceId,
      channelConnectionId: connectionId,
      bindingEpoch: 1,
      privacyEpoch: 1,
      reqId,
      lang: "nl",
    };
    return reserveMessengerProviderAttemptFence(job, "image_from_text", 1, now);
  }

  function admit(
    fence: Awaited<ReturnType<typeof prepareFence>>,
    idempotencyKey: string,
    now: Date
  ) {
    return admitStartpilotImageProviderAttempt({
      fence,
      providerOperation: "image_from_text",
      workspaceId,
      entitlementId,
      channelConnectionId: connectionId,
      bindingEpoch: 1,
      mode: "test",
      idempotencyKey,
      pageIdHash: createHash("sha256").update(pageId).digest("hex"),
      now,
    });
  }

  function recover(
    fence: Awaited<ReturnType<typeof prepareFence>>,
    idempotencyKey: string,
    now: Date
  ) {
    return recoverStartpilotImageProviderAdmission({
      fence,
      providerOperation: "image_from_text",
      workspaceId,
      entitlementId,
      channelConnectionId: connectionId,
      bindingEpoch: 1,
      mode: "test",
      idempotencyKey,
      now,
    });
  }

  async function fenceStatus(attemptKeyHash: string) {
    const database = await getDatabaseOrThrow();
    return (
      await database
        .select({ status: messengerProviderAttemptFences.status })
        .from(messengerProviderAttemptFences)
        .where(
          eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash)
        )
        .limit(1)
    )[0]?.status;
  }
});
