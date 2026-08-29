import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  billingExecutionControls,
  billingHandoffRecoveryEvents,
  billingIntents,
  billingOutbox,
  channelConnections,
  messengerPrivacySubjects,
  portalHandoffTokens,
  workspaces,
} from "../drizzle/schema";
import { requireActiveBillingPlan } from "./_core/billing/catalog";
import { reserveCheckoutIntent } from "./_core/billing/checkoutStore";
import { rearmFailedPortalHandoffAfterInbound } from "./_core/billing/portalHandoffRecovery";
import {
  beginMessengerPrivacyErasure,
  completeMessengerPrivacyErasure,
} from "./_core/messengerPrivacySubject";
import {
  createOrGetPortalHandoffToken,
  eraseBillingHandoffIdentity,
  getDatabaseOrThrow,
} from "./db";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("billing identity privacy serialization", () => {
  const senderKey = "d".repeat(64);
  let workspaceId = 0;
  let channelConnectionId = 0;
  let pageId = "";

  beforeEach(async () => {
    const database = await getDatabaseOrThrow();
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const slug = `billing-privacy-serialization-${suffix}`;
    pageId = `privacy-page-${suffix}`;
    await database.insert(workspaces).values({ name: slug, slug });
    workspaceId = (
      await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
    await database.insert(channelConnections).values({
      workspaceId,
      channel: "facebook_messenger",
      status: "connected",
      externalId: pageId,
    });
    channelConnectionId = (
      await database
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(eq(channelConnections.workspaceId, workspaceId))
        .limit(1)
    )[0]!.id;
    await database.insert(messengerPrivacySubjects).values({
      workspaceId,
      channelConnectionId,
      userKey: senderKey,
      privacyEpoch: 1,
      status: "active",
    });
    await database.insert(billingExecutionControls).values({
      workspaceId,
      mode: "test",
      commercialEnabled: true,
      authorizationEpoch: 1,
    });
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
      .delete(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId));
    await database
      .delete(portalHandoffTokens)
      .where(eq(portalHandoffTokens.workspaceId, workspaceId));
    await database
      .delete(billingExecutionControls)
      .where(eq(billingExecutionControls.workspaceId, workspaceId));
    await database
      .delete(messengerPrivacySubjects)
      .where(eq(messengerPrivacySubjects.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    workspaceId = 0;
    channelConnectionId = 0;
    pageId = "";
  });

  it("leaves no token or checkout identity when creators race erasure", async () => {
    const database = await getDatabaseOrThrow();
    let releaseSubjectLock!: () => void;
    let markSubjectLocked!: () => void;
    const subjectLocked = new Promise<void>(resolve => {
      markSubjectLocked = resolve;
    });
    const release = new Promise<void>(resolve => {
      releaseSubjectLock = resolve;
    });
    const blocker = database.transaction(async tx => {
      await tx
        .select({ id: messengerPrivacySubjects.id })
        .from(messengerPrivacySubjects)
        .where(
          and(
            eq(messengerPrivacySubjects.workspaceId, workspaceId),
            eq(
              messengerPrivacySubjects.channelConnectionId,
              channelConnectionId
            ),
            eq(messengerPrivacySubjects.userKey, senderKey)
          )
        )
        .limit(1)
        .for("update");
      markSubjectLocked();
      await release;
    });
    await subjectLocked;

    const tokenCreation = createOrGetPortalHandoffToken({
      workspaceId,
      tokenHash: `sha256:${"1".repeat(64)}`,
      deliveryIdempotencyKeyHash: `sha256:${"2".repeat(64)}`,
      messengerSenderUserKey: senderKey,
      facebookPageId: pageId,
      messengerChannelConnectionId: channelConnectionId,
      messengerPrivacyEpoch: 1,
      purpose: "workspace_onboarding",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const intentCreation = reserveCheckoutIntent({
      workspaceId,
      mode: "test",
      plan: requireActiveBillingPlan("startpilot_once_v1"),
      kind: "startpilot_purchase",
      messengerSenderUserKey: senderKey,
      messengerPageId: pageId,
      messengerChannelConnectionId: channelConnectionId,
      messengerPrivacyEpoch: 1,
      billingProfileVersion: 1,
      authorizationEpoch: 1,
    });
    const oldShapeInsert = Promise.resolve(
      database.insert(portalHandoffTokens).values({
        workspaceId,
        tokenHash: `sha256:${"3".repeat(64)}`,
        messengerSenderUserKey: senderKey,
        facebookPageId: pageId,
        purpose: "workspace_onboarding",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).then(
      () => "fulfilled" as const,
      () => "rejected" as const
    );
    const erasure = eraseSubject();
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseSubjectLock();
    await blocker;

    const [tokenResult, intentResult, oldShapeResult, erasureResult] =
      await within(
        Promise.all([
          Promise.allSettled([tokenCreation]),
          Promise.allSettled([intentCreation]),
          oldShapeInsert,
          erasure,
        ])
      );
    expect(erasureResult).toBe(0);
    // The terminal 0016 schema deliberately keeps the nullable legacy bridge.
    // A legacy-shaped row may therefore commit, but the serialized erasure
    // must still remove every privacy-bearing identity before it returns.
    expect(oldShapeResult).toBe("fulfilled");
    expect(tokenResult[0]).toBeDefined();
    expect(intentResult[0]).toBeDefined();

    expect(
      await database
        .select({ id: portalHandoffTokens.id })
        .from(portalHandoffTokens)
        .where(
          and(
            eq(portalHandoffTokens.workspaceId, workspaceId),
            isNotNull(portalHandoffTokens.messengerSenderUserKey)
          )
        )
    ).toHaveLength(0);
    expect(
      await database
        .select({ id: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.workspaceId, workspaceId),
            isNotNull(billingIntents.messengerSenderUserKey)
          )
        )
    ).toHaveLength(0);
  });

  it("recovery and erasure finish without an intent-outbox deadlock", async () => {
    const database = await getDatabaseOrThrow();
    const intent = await reserveCheckoutIntent({
      workspaceId,
      mode: "test",
      plan: requireActiveBillingPlan("startpilot_once_v1"),
      kind: "startpilot_purchase",
      messengerSenderUserKey: senderKey,
      messengerPageId: pageId,
      messengerChannelConnectionId: channelConnectionId,
      messengerPrivacyEpoch: 1,
      billingProfileVersion: 1,
      authorizationEpoch: 1,
    });
    await database
      .update(billingIntents)
      .set({ status: "paid", paidAt: new Date() })
      .where(eq(billingIntents.intentId, intent.intentId));
    await database.insert(billingOutbox).values({
      workspaceId,
      mode: "test",
      eventType: "send_portal_handoff",
      deduplicationKey: `send_portal_handoff:${intent.intentId}`,
      payload: {
        intentId: intent.intentId,
        messengerSenderUserKey: senderKey,
        messengerPageId: pageId,
        messengerChannelConnectionId: channelConnectionId,
        messengerPrivacyEpoch: 1,
      },
      status: "failed",
      attemptCount: 12,
      lastErrorCode: "portal_handoff_send_failed_exhausted",
    });

    let releaseIntentLock!: () => void;
    let markIntentLocked!: () => void;
    const intentLocked = new Promise<void>(resolve => {
      markIntentLocked = resolve;
    });
    const release = new Promise<void>(resolve => {
      releaseIntentLock = resolve;
    });
    const blocker = database.transaction(async tx => {
      await tx
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(eq(billingIntents.intentId, intent.intentId))
        .limit(1)
        .for("update");
      markIntentLocked();
      await release;
    });
    await intentLocked;

    const now = new Date();
    const recovery = rearmFailedPortalHandoffAfterInbound({
      facebookPageId: pageId,
      messengerSenderUserKey: senderKey,
      eventIdHash: "e".repeat(64),
      eventTimestamp: now,
      source: "verified_messenger_inbound",
      now,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const erasure = eraseSubject();
    await new Promise(resolve => setTimeout(resolve, 50));
    releaseIntentLock();
    await blocker;
    await within(Promise.all([recovery, erasure]));

    const storedIntent = (
      await database
        .select({
          userKey: billingIntents.messengerSenderUserKey,
          pageId: billingIntents.messengerPageId,
          channelConnectionId: billingIntents.messengerChannelConnectionId,
          privacyEpoch: billingIntents.messengerPrivacyEpoch,
        })
        .from(billingIntents)
        .where(eq(billingIntents.intentId, intent.intentId))
        .limit(1)
    )[0];
    expect(storedIntent).toEqual({
      userKey: null,
      pageId: null,
      channelConnectionId: null,
      privacyEpoch: null,
    });
    const job = (
      await database
        .select({
          status: billingOutbox.status,
          lastErrorCode: billingOutbox.lastErrorCode,
          payload: billingOutbox.payload,
        })
        .from(billingOutbox)
        .where(eq(billingOutbox.workspaceId, workspaceId))
        .limit(1)
    )[0];
    expect(job).toEqual({
      status: "failed",
      lastErrorCode: "privacy_erased",
      payload: { intentId: intent.intentId, privacyErased: true },
    });
  });

  async function eraseSubject(): Promise<number> {
    const privacyEpoch = await beginMessengerPrivacyErasure({
      workspaceId,
      channelConnectionId,
      userKey: senderKey,
    });
    const erased = await eraseBillingHandoffIdentity(
      workspaceId,
      senderKey,
      pageId
    );
    await completeMessengerPrivacyErasure({
      workspaceId,
      channelConnectionId,
      userKey: senderKey,
      privacyEpoch,
    });
    return erased;
  }
});

async function within<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MySQL privacy serialization timed out")),
          5_000
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
