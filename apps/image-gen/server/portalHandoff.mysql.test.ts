import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  billingIntents,
  billingOutbox,
  channelConnections,
  portalHandoffTokens,
  users,
  workspaceMembers,
  workspacePrivacySettings,
  workspaces,
} from "../drizzle/schema";
import {
  claimPortalHandoffTokenForUser,
  createOrGetPortalHandoffToken,
  getDatabaseOrThrow,
} from "./db";
import { rearmFailedPortalHandoffAfterInbound } from "./_core/billing/portalHandoffRecovery";

const runMysqlIntegration = process.env.RUN_MYSQL_INTEGRATION === "1";
const suite = describe.runIf(runMysqlIntegration);

suite("portal handoff MySQL concurrency", () => {
  const suffix = `${Date.now()}-${process.pid}`;
  const slug = `handoff-mysql-${suffix}`;
  const openId = `handoff-mysql-${suffix}`;
  const pageId = `page-${suffix}`;
  const senderKey = "a".repeat(64);
  const deliveryHash = `sha256:${"b".repeat(64)}`;
  const tokenHash = `sha256:${"c".repeat(64)}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const intentId = "550e8400-e29b-41d4-a716-446655440099";

  let workspaceId = 0;
  let userId = 0;

  beforeAll(async () => {
    const database = await getDatabaseOrThrow();
    await database.insert(workspaces).values({
      name: "Portal handoff MySQL integration",
      slug,
    });
    const workspace = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, slug))
      .limit(1);
    workspaceId = workspace[0]?.id ?? 0;

    await database.insert(users).values({
      openId,
      name: "Portal handoff integration user",
      loginMethod: "facebook",
    });
    const user = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.openId, openId))
      .limit(1);
    userId = user[0]?.id ?? 0;

    expect(workspaceId).toBeGreaterThan(0);
    expect(userId).toBeGreaterThan(0);

    await database.insert(channelConnections).values({
      workspaceId,
      channel: "facebook_messenger",
      status: "connected",
      externalId: pageId,
    });
    await database.insert(workspaceMembers).values({
      workspaceId,
      userId,
      role: "admin",
    });
  });

  afterAll(async () => {
    if (!workspaceId || !userId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(billingOutbox)
      .where(eq(billingOutbox.workspaceId, workspaceId));
    await database
      .delete(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId));
    await database
      .delete(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId));
    await database
      .delete(workspacePrivacySettings)
      .where(eq(workspacePrivacySettings.workspaceId, workspaceId));
    await database
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    await database
      .delete(portalHandoffTokens)
      .where(eq(portalHandoffTokens.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    await database.delete(users).where(eq(users.id, userId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("creates one delivery capability under concurrent duplicate inserts", async () => {
    const input = {
      workspaceId,
      tokenHash,
      deliveryIdempotencyKeyHash: deliveryHash,
      messengerSenderUserKey: senderKey,
      facebookPageId: pageId,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt,
      createdByUserId: null,
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createOrGetPortalHandoffToken(input, new Date())
      )
    );

    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(results.every(result => result.status === "pending")).toBe(true);

    const database = await getDatabaseOrThrow();
    const stored = await database
      .select()
      .from(portalHandoffTokens)
      .where(
        and(
          eq(portalHandoffTokens.workspaceId, workspaceId),
          eq(portalHandoffTokens.deliveryIdempotencyKeyHash, deliveryHash)
        )
      );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      tokenHash,
      messengerSenderUserKey: senderKey,
      facebookPageId: pageId,
      status: "pending",
    });
  });

  it("allows exactly one concurrent claim and preserves an existing role", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        claimPortalHandoffTokenForUser({
          tokenHash,
          userId,
          now: new Date(),
        })
      )
    );

    const successful = attempts.filter(result => result.ok);
    const rejected = attempts.filter(result => !result.ok);
    expect(successful).toHaveLength(1);
    expect(successful[0]).toMatchObject({
      ok: true,
      membership: { role: "admin" },
    });
    expect(rejected).toHaveLength(11);
    expect(rejected.every(result => result.reason === "already_used")).toBe(
      true
    );

    const database = await getDatabaseOrThrow();
    const storedTokens = await database
      .select()
      .from(portalHandoffTokens)
      .where(eq(portalHandoffTokens.tokenHash, tokenHash));
    expect(storedTokens).toHaveLength(1);
    expect(storedTokens[0]).toMatchObject({
      status: "consumed",
      claimedByUserId: userId,
    });

    const memberships = await database
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId)
        )
      );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("admin");

    const claimAudit = await database
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.workspaceId, workspaceId),
          eq(auditLog.event, "portal_handoff.claimed")
        )
      );
    expect(claimAudit).toHaveLength(1);
  });

  it("rearms only the same paid delivery after a matching inbound message", async () => {
    const database = await getDatabaseOrThrow();
    await database.insert(billingIntents).values({
      intentId,
      workspaceId,
      mode: "test",
      planCode: "startpilot_once_v1",
      kind: "startpilot_purchase",
      expectedAmount: "19.00",
      currency: "EUR",
      interval: "once",
      entitlements: { aiAnswers: 300, images: 20 },
      mollieDescription: "Startpilot",
      status: "paid",
      idempotencyKey: `mysql-recovery-intent-${suffix}`,
      checkoutScopeKey: `mysql-recovery-scope-${suffix}`,
      messengerSenderUserKey: senderKey,
      messengerPageId: pageId,
      paidAt: new Date(),
    });
    await database.insert(billingOutbox).values({
      workspaceId,
      mode: "test",
      eventType: "send_portal_handoff",
      deduplicationKey: `send_portal_handoff:${intentId}`,
      payload: {
        intentId,
        messengerSenderUserKey: senderKey,
        messengerPageId: pageId,
      },
      status: "failed",
      attemptCount: 1,
      maxAttempts: 12,
      lastErrorCode: "portal_handoff_response_window_closed",
    });

    const now = new Date();
    const eventIdHash = "1".repeat(64);
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: "f".repeat(64),
        eventIdHash,
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(false);
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: senderKey,
        eventIdHash,
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(true);
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: senderKey,
        eventIdHash,
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(false);

    const jobs = await database
      .select()
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "send_portal_handoff")
        )
      );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "pending",
      attemptCount: 0,
      lastErrorCode: "customer_message_rearm",
    });

    const paidIntents = await database
      .select()
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, workspaceId),
          eq(billingIntents.status, "paid")
        )
      );
    expect(paidIntents).toHaveLength(1);
    expect(paidIntents[0]?.intentId).toBe(intentId);

    await database
      .update(billingOutbox)
      .set({
        status: "failed",
        lastErrorCode: "portal_handoff_send_failed_exhausted",
      })
      .where(eq(billingOutbox.workspaceId, workspaceId));
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: senderKey,
        eventIdHash,
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(false);
    await expect(
      rearmFailedPortalHandoffAfterInbound({
        facebookPageId: pageId,
        messengerSenderUserKey: senderKey,
        eventIdHash: "2".repeat(64),
        eventTimestamp: now,
        source: "verified_messenger_inbound",
        now,
      })
    ).resolves.toBe(true);
  });

  it("extends the same revoked capability across recovery cycles after 48 hours", async () => {
    const database = await getDatabaseOrThrow();
    const cycleDeliveryHash = `sha256:${"7".repeat(64)}`;
    const cycleTokenHash = `sha256:${"8".repeat(64)}`;
    const initial = new Date("2026-08-01T00:00:00.000Z");
    const values = {
      workspaceId,
      tokenHash: cycleTokenHash,
      deliveryIdempotencyKeyHash: cycleDeliveryHash,
      messengerSenderUserKey: senderKey,
      facebookPageId: pageId,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt: new Date(initial.getTime() + 48 * 60 * 60_000),
      createdByUserId: null,
    };
    const created = await createOrGetPortalHandoffToken(values, initial);
    await database
      .update(portalHandoffTokens)
      .set({ status: "revoked" })
      .where(eq(portalHandoffTokens.id, created.id));

    const secondNow = new Date(initial.getTime() + 72 * 60 * 60_000);
    const secondExpiry = new Date(secondNow.getTime() + 48 * 60 * 60_000);
    const second = await createOrGetPortalHandoffToken(
      { ...values, expiresAt: secondExpiry },
      secondNow
    );
    expect(second).toMatchObject({
      id: created.id,
      tokenHash: cycleTokenHash,
      status: "pending",
      expiresAt: secondExpiry,
    });
    await database
      .update(portalHandoffTokens)
      .set({ status: "revoked" })
      .where(eq(portalHandoffTokens.id, created.id));
    const thirdNow = new Date(secondNow.getTime() + 72 * 60 * 60_000);
    const thirdExpiry = new Date(thirdNow.getTime() + 48 * 60 * 60_000);
    const third = await createOrGetPortalHandoffToken(
      { ...values, expiresAt: thirdExpiry },
      thirdNow
    );
    expect(third.id).toBe(created.id);
    expect(third.tokenHash).toBe(cycleTokenHash);
    expect(third.expiresAt).toEqual(thirdExpiry);
  });
});
