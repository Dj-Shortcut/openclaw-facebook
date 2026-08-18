import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
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

    expect(new Set(results.map(result => result.id))).toHaveSize(1);
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
});
