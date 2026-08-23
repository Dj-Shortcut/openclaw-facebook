import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  channelConnections,
  messengerPrivacySubjects,
  workspaces,
} from "../drizzle/schema";
import {
  admitMessengerPrivacySubjectFromMetaEvent,
  assertMessengerPrivacyErasure,
  beginMessengerPrivacyErasure,
  getErasingMessengerPrivacySubject,
  MessengerPrivacyFenceError,
  runWithLockedMessengerPrivacyErasure,
} from "./_core/messengerPrivacySubject";
import { getDatabaseOrThrow } from "./db";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("Messenger erasure retry epoch", () => {
  const userKey = "e".repeat(64);
  let workspaceId = 0;
  let channelConnectionId = 0;

  beforeEach(async () => {
    const database = await getDatabaseOrThrow();
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const slug = `messenger-erasure-retry-${suffix}`;
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
      externalId: `page-${suffix}`,
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
      userKey,
      privacyEpoch: 5,
      status: "active",
    });
  });

  afterEach(async () => {
    if (!workspaceId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(messengerPrivacySubjects)
      .where(eq(messengerPrivacySubjects.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
    workspaceId = 0;
    channelConnectionId = 0;
  });

  it("derives data E5 for erasing E6 and rejects that retry after E7 reactivation", async () => {
    const scope = { workspaceId, channelConnectionId, userKey };

    await expect(beginMessengerPrivacyErasure(scope)).resolves.toBe(6);
    await expect(getErasingMessengerPrivacySubject(scope)).resolves.toEqual({
      privacyEpoch: 6,
      dataPrivacyEpoch: 5,
    });
    await expect(
      assertMessengerPrivacyErasure({
        ...scope,
        privacyEpoch: 6,
        dataPrivacyEpoch: 5,
      })
    ).resolves.toBeUndefined();

    const completedAt = new Date("2026-08-23T12:00:00.123Z");
    await expect(
      runWithLockedMessengerPrivacyErasure(
        { ...scope, privacyEpoch: 6, dataPrivacyEpoch: 5 },
        async () => ({ value: "completed", complete: true }),
        () => completedAt
      )
    ).resolves.toBe("completed");
    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date(completedAt.getTime() + 1),
        allowReactivation: true,
      })
    ).resolves.toBe(7);

    await expect(
      assertMessengerPrivacyErasure({
        ...scope,
        privacyEpoch: 6,
        dataPrivacyEpoch: 5,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
  });

  it("keeps an old writer's deletion boundary after reactivation", async () => {
    const database = await getDatabaseOrThrow();
    const scope = { workspaceId, channelConnectionId, userKey };
    const erasedAt = new Date("2026-08-23T12:00:00.000Z");
    await database
      .update(messengerPrivacySubjects)
      .set({
        privacyEpoch: 6,
        status: "erased",
        erasedAt,
        lastErasedAt: null,
      })
      .where(eq(messengerPrivacySubjects.workspaceId, workspaceId));

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: new Date(erasedAt.getTime() + 2_000),
        allowReactivation: true,
      })
    ).resolves.toBe(7);

    const reactivated = (
      await database
        .select({
          erasedAt: messengerPrivacySubjects.erasedAt,
          lastErasedAt: messengerPrivacySubjects.lastErasedAt,
        })
        .from(messengerPrivacySubjects)
        .where(eq(messengerPrivacySubjects.workspaceId, workspaceId))
        .limit(1)
    )[0]!;
    expect(reactivated.erasedAt).toBeNull();
    expect(reactivated.lastErasedAt?.getTime()).toBe(erasedAt.getTime());

    await expect(
      admitMessengerPrivacySubjectFromMetaEvent({
        ...scope,
        eventOccurredAt: erasedAt,
        allowReactivation: true,
      })
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
  });
});
