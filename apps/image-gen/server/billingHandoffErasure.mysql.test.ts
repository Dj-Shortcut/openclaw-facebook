import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  billingHandoffRecoveryEvents,
  billingIntents,
  billingOutbox,
  channelConnections,
  messengerPrivacySubjects,
  portalHandoffTokens,
  workspaces,
} from "../drizzle/schema";
import { eraseBillingHandoffIdentity, getDatabaseOrThrow } from "./db";

const runMysqlIntegration = process.env.RUN_MYSQL_INTEGRATION === "1";
const suite = describe.runIf(runMysqlIntegration);

suite("billing handoff privacy erasure", () => {
  const suffix = `${Date.now()}-${process.pid}`;
  const targetSenderKey = "a".repeat(64);
  const otherSenderKey = "b".repeat(64);
  const targetPageId = `billing-erasure-page-${suffix}`;
  const otherPageId = `billing-erasure-other-page-${suffix}`;
  const otherTenantPageId = `billing-erasure-tenant-page-${suffix}`;
  let targetWorkspaceId = 0;
  let otherWorkspaceId = 0;
  let targetChannelConnectionId = 0;
  let otherChannelConnectionId = 0;

  const intentValues = (input: {
    intentId: string;
    workspaceId: number;
    senderKey: string;
    pageId: string;
    status?: "open" | "paid";
  }) => ({
    intentId: input.intentId,
    workspaceId: input.workspaceId,
    mode: "test" as const,
    planCode: "startpilot_once_v1",
    kind: "startpilot_purchase" as const,
    expectedAmount: "19.00",
    currency: "EUR",
    interval: "once",
    entitlements: { aiAnswers: 300, images: 20 },
    mollieDescription: "Startpilot",
    status: input.status ?? ("open" as const),
    idempotencyKey: `billing-erasure-intent:${input.intentId}`,
    checkoutScopeKey: `billing-erasure-scope:${input.intentId}`,
    messengerSenderUserKey: input.senderKey,
    messengerPageId: input.pageId,
    messengerChannelConnectionId:
      input.workspaceId === targetWorkspaceId
        ? targetChannelConnectionId
        : otherChannelConnectionId,
    messengerPrivacyEpoch: 1,
    billingProfileVersion: 1,
    authorizationEpoch: 1,
  });

  async function clearTestRows() {
    if (!targetWorkspaceId || !otherWorkspaceId) return;
    const database = await getDatabaseOrThrow();
    const workspaceIds = [targetWorkspaceId, otherWorkspaceId];
    await database
      .delete(billingHandoffRecoveryEvents)
      .where(inArray(billingHandoffRecoveryEvents.workspaceId, workspaceIds));
    await database
      .delete(billingOutbox)
      .where(inArray(billingOutbox.workspaceId, workspaceIds));
    await database
      .delete(billingIntents)
      .where(inArray(billingIntents.workspaceId, workspaceIds));
    await database
      .delete(portalHandoffTokens)
      .where(inArray(portalHandoffTokens.workspaceId, workspaceIds));
  }

  beforeAll(async () => {
    const database = await getDatabaseOrThrow();
    const targetSlug = `billing-erasure-target-${suffix}`;
    const otherSlug = `billing-erasure-other-${suffix}`;
    await database.insert(workspaces).values([
      { name: "Billing erasure target", slug: targetSlug },
      { name: "Billing erasure other tenant", slug: otherSlug },
    ]);
    const rows = await database
      .select({ id: workspaces.id, slug: workspaces.slug })
      .from(workspaces)
      .where(inArray(workspaces.slug, [targetSlug, otherSlug]));
    targetWorkspaceId = rows.find(row => row.slug === targetSlug)?.id ?? 0;
    otherWorkspaceId = rows.find(row => row.slug === otherSlug)?.id ?? 0;
    expect(targetWorkspaceId).toBeGreaterThan(0);
    expect(otherWorkspaceId).toBeGreaterThan(0);
    await database.insert(channelConnections).values([
      {
        workspaceId: targetWorkspaceId,
        channel: "facebook_messenger",
        status: "connected",
        externalId: targetPageId,
      },
      {
        workspaceId: otherWorkspaceId,
        channel: "facebook_messenger",
        status: "connected",
        externalId: otherTenantPageId,
      },
    ]);
    const connections = await database
      .select({
        id: channelConnections.id,
        workspaceId: channelConnections.workspaceId,
      })
      .from(channelConnections)
      .where(
        inArray(channelConnections.workspaceId, [
          targetWorkspaceId,
          otherWorkspaceId,
        ])
      );
    targetChannelConnectionId =
      connections.find(row => row.workspaceId === targetWorkspaceId)?.id ?? 0;
    otherChannelConnectionId =
      connections.find(row => row.workspaceId === otherWorkspaceId)?.id ?? 0;
    await database.insert(messengerPrivacySubjects).values([
      {
        workspaceId: targetWorkspaceId,
        channelConnectionId: targetChannelConnectionId,
        userKey: targetSenderKey,
        privacyEpoch: 1,
        status: "active",
      },
      {
        workspaceId: targetWorkspaceId,
        channelConnectionId: targetChannelConnectionId,
        userKey: otherSenderKey,
        privacyEpoch: 1,
        status: "active",
      },
      {
        workspaceId: otherWorkspaceId,
        channelConnectionId: otherChannelConnectionId,
        userKey: targetSenderKey,
        privacyEpoch: 1,
        status: "active",
      },
    ]);
  });

  afterEach(clearTestRows);

  afterAll(async () => {
    await clearTestRows();
    if (!targetWorkspaceId || !otherWorkspaceId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(messengerPrivacySubjects)
      .where(
        inArray(messengerPrivacySubjects.workspaceId, [
          targetWorkspaceId,
          otherWorkspaceId,
        ])
      );
    await database
      .delete(channelConnections)
      .where(
        inArray(channelConnections.workspaceId, [
          targetWorkspaceId,
          otherWorkspaceId,
        ])
      );
    await database
      .delete(workspaces)
      .where(inArray(workspaces.id, [targetWorkspaceId, otherWorkspaceId]));
  });

  it("erases every exact-scope intent, including intents without an outbox", async () => {
    const database = await getDatabaseOrThrow();
    const noOutboxIntentId = randomUUID();
    const withOutboxIntentId = randomUUID();
    const otherPageIntentId = randomUUID();
    const otherSenderIntentId = randomUUID();
    const otherTenantIntentId = randomUUID();
    await database.insert(billingIntents).values([
      intentValues({
        intentId: noOutboxIntentId,
        workspaceId: targetWorkspaceId,
        senderKey: targetSenderKey,
        pageId: targetPageId,
      }),
      intentValues({
        intentId: withOutboxIntentId,
        workspaceId: targetWorkspaceId,
        senderKey: targetSenderKey,
        pageId: targetPageId,
        status: "paid",
      }),
      intentValues({
        intentId: otherPageIntentId,
        workspaceId: targetWorkspaceId,
        senderKey: targetSenderKey,
        pageId: otherPageId,
      }),
      intentValues({
        intentId: otherSenderIntentId,
        workspaceId: targetWorkspaceId,
        senderKey: otherSenderKey,
        pageId: targetPageId,
      }),
      intentValues({
        intentId: otherTenantIntentId,
        workspaceId: otherWorkspaceId,
        senderKey: targetSenderKey,
        pageId: otherTenantPageId,
      }),
    ]);
    await database.insert(billingOutbox).values([
      {
        workspaceId: targetWorkspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `send_portal_handoff:${withOutboxIntentId}`,
        payload: {
          intentId: withOutboxIntentId,
          messengerSenderUserKey: targetSenderKey,
          messengerPageId: targetPageId,
          messengerChannelConnectionId: targetChannelConnectionId,
          messengerPrivacyEpoch: 1,
        },
      },
      {
        workspaceId: targetWorkspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `send_portal_handoff:${otherPageIntentId}`,
        payload: {
          intentId: otherPageIntentId,
          messengerSenderUserKey: targetSenderKey,
          messengerPageId: otherPageId,
          messengerChannelConnectionId: targetChannelConnectionId,
          messengerPrivacyEpoch: 1,
        },
      },
      {
        workspaceId: otherWorkspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `send_portal_handoff:${otherTenantIntentId}`,
        payload: {
          intentId: otherTenantIntentId,
          messengerSenderUserKey: targetSenderKey,
          messengerPageId: otherTenantPageId,
          messengerChannelConnectionId: otherChannelConnectionId,
          messengerPrivacyEpoch: 1,
        },
      },
    ]);
    await database.insert(portalHandoffTokens).values([
      {
        workspaceId: targetWorkspaceId,
        tokenHash: `sha256:${"1".repeat(64)}`,
        messengerSenderUserKey: targetSenderKey,
        facebookPageId: targetPageId,
        messengerChannelConnectionId: targetChannelConnectionId,
        messengerPrivacyEpoch: 1,
        purpose: "workspace_onboarding",
        expiresAt: new Date("2026-08-24T00:00:00.000Z"),
      },
      {
        workspaceId: targetWorkspaceId,
        tokenHash: `sha256:${"2".repeat(64)}`,
        messengerSenderUserKey: targetSenderKey,
        facebookPageId: otherPageId,
        messengerChannelConnectionId: targetChannelConnectionId,
        messengerPrivacyEpoch: 1,
        purpose: "workspace_onboarding",
        expiresAt: new Date("2026-08-24T00:00:00.000Z"),
      },
      {
        workspaceId: otherWorkspaceId,
        tokenHash: `sha256:${"3".repeat(64)}`,
        messengerSenderUserKey: targetSenderKey,
        facebookPageId: otherTenantPageId,
        messengerChannelConnectionId: otherChannelConnectionId,
        messengerPrivacyEpoch: 1,
        purpose: "workspace_onboarding",
        expiresAt: new Date("2026-08-24T00:00:00.000Z"),
      },
    ]);

    await expect(
      eraseBillingHandoffIdentity(
        targetWorkspaceId,
        targetSenderKey,
        targetPageId
      )
    ).resolves.toBe(1);

    const intents = await database
      .select({
        intentId: billingIntents.intentId,
        senderKey: billingIntents.messengerSenderUserKey,
        pageId: billingIntents.messengerPageId,
      })
      .from(billingIntents)
      .where(
        inArray(billingIntents.intentId, [
          noOutboxIntentId,
          withOutboxIntentId,
          otherPageIntentId,
          otherSenderIntentId,
          otherTenantIntentId,
        ])
      );
    const byIntentId = new Map(intents.map(row => [row.intentId, row]));
    expect(byIntentId.get(noOutboxIntentId)).toMatchObject({
      senderKey: null,
      pageId: null,
    });
    expect(byIntentId.get(withOutboxIntentId)).toMatchObject({
      senderKey: null,
      pageId: null,
    });
    expect(byIntentId.get(otherPageIntentId)).toMatchObject({
      senderKey: targetSenderKey,
      pageId: otherPageId,
    });
    expect(byIntentId.get(otherSenderIntentId)).toMatchObject({
      senderKey: otherSenderKey,
      pageId: targetPageId,
    });
    expect(byIntentId.get(otherTenantIntentId)).toMatchObject({
      senderKey: targetSenderKey,
      pageId: otherTenantPageId,
    });

    const outboxRows = await database
      .select({
        workspaceId: billingOutbox.workspaceId,
        deduplicationKey: billingOutbox.deduplicationKey,
        status: billingOutbox.status,
        lastErrorCode: billingOutbox.lastErrorCode,
        privacyErasedAt: billingOutbox.privacyErasedAt,
        payload: billingOutbox.payload,
      })
      .from(billingOutbox)
      .where(
        inArray(billingOutbox.workspaceId, [
          targetWorkspaceId,
          otherWorkspaceId,
        ])
      );
    const erasedOutbox = outboxRows.find(
      row =>
        row.deduplicationKey === `send_portal_handoff:${withOutboxIntentId}`
    );
    expect(erasedOutbox).toMatchObject({
      workspaceId: targetWorkspaceId,
      status: "failed",
      lastErrorCode: "privacy_erased",
      payload: { intentId: withOutboxIntentId, privacyErased: true },
    });
    expect(erasedOutbox?.privacyErasedAt).toBeInstanceOf(Date);
    const untouchedOutbox = outboxRows.filter(
      row => row.deduplicationKey !== erasedOutbox?.deduplicationKey
    );
    expect(untouchedOutbox).toHaveLength(2);
    expect(untouchedOutbox.every(row => row.status === "pending")).toBe(true);

    const tokens = await database
      .select({
        workspaceId: portalHandoffTokens.workspaceId,
        pageId: portalHandoffTokens.facebookPageId,
      })
      .from(portalHandoffTokens)
      .where(
        inArray(portalHandoffTokens.workspaceId, [
          targetWorkspaceId,
          otherWorkspaceId,
        ])
      );
    expect(tokens).toHaveLength(2);
    expect(tokens).toEqual(
      expect.arrayContaining([
        { workspaceId: targetWorkspaceId, pageId: otherPageId },
        { workspaceId: otherWorkspaceId, pageId: otherTenantPageId },
      ])
    );
  });

  it("keeps a mismatched non-null scope and erases the exact current scope", async () => {
    const database = await getDatabaseOrThrow();
    const intentId = randomUUID();
    const tokenHash = `sha256:${"9".repeat(64)}`;
    await database.insert(billingIntents).values(
      intentValues({
        intentId,
        workspaceId: targetWorkspaceId,
        senderKey: targetSenderKey,
        pageId: targetPageId,
      })
    );
    await database.insert(portalHandoffTokens).values({
      workspaceId: targetWorkspaceId,
      tokenHash,
      messengerSenderUserKey: targetSenderKey,
      facebookPageId: targetPageId,
      messengerChannelConnectionId: targetChannelConnectionId,
      messengerPrivacyEpoch: 1,
      purpose: "workspace_onboarding",
      expiresAt: new Date("2026-08-24T00:00:00.000Z"),
    });

    await eraseBillingHandoffIdentity(
      targetWorkspaceId,
      targetSenderKey,
      targetPageId,
      {
        channelConnectionId: targetChannelConnectionId + 10_000,
        maxPrivacyEpoch: 1,
      }
    );

    expect(
      await database
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.intentId, intentId),
            eq(billingIntents.messengerSenderUserKey, targetSenderKey)
          )
        )
    ).toHaveLength(1);
    expect(
      await database
        .select({ id: portalHandoffTokens.id })
        .from(portalHandoffTokens)
        .where(eq(portalHandoffTokens.tokenHash, tokenHash))
    ).toHaveLength(1);

    await eraseBillingHandoffIdentity(
      targetWorkspaceId,
      targetSenderKey,
      targetPageId,
      {
        channelConnectionId: targetChannelConnectionId,
        maxPrivacyEpoch: 1,
      }
    );

    expect(
      await database
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.intentId, intentId),
            eq(billingIntents.messengerSenderUserKey, targetSenderKey)
          )
        )
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: portalHandoffTokens.id })
        .from(portalHandoffTokens)
        .where(eq(portalHandoffTokens.tokenHash, tokenHash))
    ).toHaveLength(0);
  });

  it("erases legacy handoff rows whose expanded privacy scope is still null", async () => {
    const database = await getDatabaseOrThrow();
    const intentId = randomUUID();
    const tokenHash = `sha256:${"8".repeat(64)}`;
    await database.transaction(async tx => {
      // The final schema correctly refuses new unscoped identities. Disable
      // CHECK evaluation only on this transaction's connection to reproduce a
      // row that existed before the 0017 contract was applied.
      await tx.execute(sql`SET SESSION check_constraint_checks = OFF`);
      try {
        await tx.insert(billingIntents).values({
          ...intentValues({
            intentId,
            workspaceId: targetWorkspaceId,
            senderKey: targetSenderKey,
            pageId: targetPageId,
          }),
          messengerChannelConnectionId: null,
          messengerPrivacyEpoch: null,
        });
        await tx.insert(portalHandoffTokens).values({
          workspaceId: targetWorkspaceId,
          tokenHash,
          messengerSenderUserKey: targetSenderKey,
          facebookPageId: targetPageId,
          messengerChannelConnectionId: null,
          messengerPrivacyEpoch: null,
          purpose: "workspace_onboarding",
          expiresAt: new Date("2026-08-24T00:00:00.000Z"),
        });
      } finally {
        await tx.execute(sql`SET SESSION check_constraint_checks = ON`);
      }
    });

    await eraseBillingHandoffIdentity(
      targetWorkspaceId,
      targetSenderKey,
      targetPageId,
      {
        channelConnectionId: targetChannelConnectionId,
        maxPrivacyEpoch: 1,
      }
    );

    expect(
      await database
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(eq(billingIntents.intentId, intentId))
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: portalHandoffTokens.id })
        .from(portalHandoffTokens)
        .where(eq(portalHandoffTokens.tokenHash, tokenHash))
    ).toHaveLength(0);
  });

  it("fails atomically while Messenger transport is already in flight", async () => {
    const database = await getDatabaseOrThrow();
    const intentId = randomUUID();
    await database.insert(billingIntents).values(
      intentValues({
        intentId,
        workspaceId: targetWorkspaceId,
        senderKey: targetSenderKey,
        pageId: targetPageId,
        status: "paid",
      })
    );
    await database.insert(billingOutbox).values({
      workspaceId: targetWorkspaceId,
      mode: "test",
      eventType: "send_portal_handoff",
      deduplicationKey: `send_portal_handoff:${intentId}`,
      payload: {
        intentId,
        messengerSenderUserKey: targetSenderKey,
        messengerPageId: targetPageId,
        messengerChannelConnectionId: targetChannelConnectionId,
        messengerPrivacyEpoch: 1,
      },
      status: "processing",
      lockedAt: new Date(),
      leaseToken: randomUUID(),
      deliveryState: "transport_started",
    });

    await expect(
      eraseBillingHandoffIdentity(
        targetWorkspaceId,
        targetSenderKey,
        targetPageId
      )
    ).rejects.toThrow("delivery is in flight");

    const intents = await database
      .select({
        senderKey: billingIntents.messengerSenderUserKey,
        pageId: billingIntents.messengerPageId,
      })
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId));
    expect(intents[0]).toEqual({
      senderKey: targetSenderKey,
      pageId: targetPageId,
    });
    const jobs = await database
      .select({
        status: billingOutbox.status,
        deliveryState: billingOutbox.deliveryState,
        privacyErasedAt: billingOutbox.privacyErasedAt,
        payload: billingOutbox.payload,
      })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, targetWorkspaceId),
          eq(billingOutbox.deduplicationKey, `send_portal_handoff:${intentId}`)
        )
      );
    expect(jobs[0]).toMatchObject({
      status: "processing",
      deliveryState: "transport_started",
      privacyErasedAt: null,
      payload: {
        intentId,
        messengerSenderUserKey: targetSenderKey,
        messengerPageId: targetPageId,
        messengerChannelConnectionId: targetChannelConnectionId,
        messengerPrivacyEpoch: 1,
      },
    });
  });

  it("scrubs a handoff enqueued by a payment transaction racing erasure", async () => {
    const database = await getDatabaseOrThrow();
    const intentId = randomUUID();
    await database.insert(billingIntents).values(
      intentValues({
        intentId,
        workspaceId: targetWorkspaceId,
        senderKey: targetSenderKey,
        pageId: targetPageId,
        status: "paid",
      })
    );

    let releasePayment!: () => void;
    let markIntentLocked!: () => void;
    const paymentCanContinue = new Promise<void>(resolve => {
      releasePayment = resolve;
    });
    const intentLocked = new Promise<void>(resolve => {
      markIntentLocked = resolve;
    });
    const payment = database.transaction(async tx => {
      await tx
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.intentId, intentId),
            eq(billingIntents.workspaceId, targetWorkspaceId)
          )
        )
        .for("update");
      markIntentLocked();
      await paymentCanContinue;
      await tx.insert(billingOutbox).values({
        workspaceId: targetWorkspaceId,
        mode: "test",
        eventType: "send_portal_handoff",
        deduplicationKey: `send_portal_handoff:${intentId}`,
        payload: {
          intentId,
          messengerSenderUserKey: targetSenderKey,
          messengerPageId: targetPageId,
          messengerChannelConnectionId: targetChannelConnectionId,
          messengerPrivacyEpoch: 1,
        },
      });
    });
    await intentLocked;
    const erasure = eraseBillingHandoffIdentity(
      targetWorkspaceId,
      targetSenderKey,
      targetPageId
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    releasePayment();

    await expect(Promise.all([payment, erasure])).resolves.toEqual([
      undefined,
      1,
    ]);
    const intents = await database
      .select({
        senderKey: billingIntents.messengerSenderUserKey,
        pageId: billingIntents.messengerPageId,
      })
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId));
    expect(intents[0]).toEqual({ senderKey: null, pageId: null });
    const jobs = await database
      .select({
        status: billingOutbox.status,
        lastErrorCode: billingOutbox.lastErrorCode,
        payload: billingOutbox.payload,
      })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, targetWorkspaceId),
          eq(billingOutbox.deduplicationKey, `send_portal_handoff:${intentId}`)
        )
      );
    expect(jobs[0]).toEqual({
      status: "failed",
      lastErrorCode: "privacy_erased",
      payload: { intentId, privacyErased: true },
    });
  });
});
