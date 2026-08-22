import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { channelConnections, workspaces } from "../drizzle/schema";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
} from "./_core/workspaceEntitlementRuntime";
import { getDatabaseOrThrow } from "./db";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("queued Messenger ingress MySQL ownership fence", () => {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const pageId = `ingress-owner-page-${suffix}`;
  const workspaceIds: number[] = [];
  let connectionId = 0;

  beforeAll(async () => {
    const database = await getDatabaseOrThrow();
    for (const tenant of ["a", "b"]) {
      const slug = `ingress-owner-${tenant}-${suffix}`;
      await database.insert(workspaces).values({ name: slug, slug });
      const workspace = await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1);
      workspaceIds.push(workspace[0]!.id);
    }
    await database.insert(channelConnections).values({
      workspaceId: workspaceIds[0]!,
      channel: "facebook_messenger",
      status: "connected",
      externalId: pageId,
      bindingEpoch: 1,
    });
    connectionId = (
      await database
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(eq(channelConnections.externalId, pageId))
        .limit(1)
    )[0]!.id;
  });

  afterAll(async () => {
    if (workspaceIds.length === 0) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(channelConnections)
      .where(inArray(channelConnections.workspaceId, workspaceIds));
    await database
      .delete(workspaces)
      .where(inArray(workspaces.id, workspaceIds));
  });

  it("rejects the captured tenant after a same-row Page rebind", async () => {
    const captured = {
      pageId,
      workspaceId: workspaceIds[0]!,
      channelConnectionId: connectionId,
      bindingEpoch: 1,
    };
    await expect(
      assertMessengerGenerationOwnership(captured)
    ).resolves.toBeUndefined();

    const database = await getDatabaseOrThrow();
    await database
      .update(channelConnections)
      .set({ workspaceId: workspaceIds[1]!, bindingEpoch: 2 })
      .where(eq(channelConnections.id, connectionId));

    await expect(assertMessengerGenerationOwnership(captured)).rejects.toThrow(
      "Messenger generation ownership changed after enqueue"
    );
    await expect(
      assertMessengerGenerationOwnership({
        pageId,
        workspaceId: workspaceIds[1]!,
        channelConnectionId: connectionId,
        bindingEpoch: 2,
      })
    ).resolves.toBeUndefined();
    await expect(resolveMessengerGenerationOwnership(pageId)).resolves.toEqual({
      pageId,
      workspaceId: workspaceIds[1],
      channelConnectionId: connectionId,
      bindingEpoch: 2,
    });
  });
});
