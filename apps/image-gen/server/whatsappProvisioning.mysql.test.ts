import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  channelConnections,
  users,
  workspaceMembers,
  workspaces,
} from "../drizzle/schema";
import {
  ChannelConnectionAuthorizationError,
  getDatabaseOrThrow,
  upsertChannelConnection,
} from "./db";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("WhatsApp provisioning MySQL transaction", () => {
  const suffix = `${Date.now()}${process.pid}`;
  const slug = `whatsapp-provisioning-${suffix}`;
  const openId = `whatsapp-provisioning-${suffix}`;
  const failedPhoneNumberId = `40${suffix}`;
  const failedWabaId = `30${suffix}`;
  const connectedPhoneNumberId = `41${suffix}`;
  const connectedWabaId = `31${suffix}`;
  let workspaceId = 0;
  let userId = 0;

  beforeAll(async () => {
    const database = await getDatabaseOrThrow();
    await database.insert(workspaces).values({
      name: "WhatsApp provisioning transaction",
      slug,
    });
    workspaceId =
      (
        await database
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.slug, slug))
          .limit(1)
      )[0]?.id ?? 0;
    expect(workspaceId).toBeGreaterThan(0);
    await database.insert(users).values({
      openId,
      name: "WhatsApp provisioning approver",
      loginMethod: "facebook",
    });
    userId =
      (
        await database
          .select({ id: users.id })
          .from(users)
          .where(eq(users.openId, openId))
          .limit(1)
      )[0]?.id ?? 0;
    expect(userId).toBeGreaterThan(0);
    await database.insert(workspaceMembers).values({
      workspaceId,
      userId,
      role: "owner",
    });
  });

  afterAll(async () => {
    if (!workspaceId) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId));
    await database
      .delete(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    await database
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    if (userId) {
      await database.delete(users).where(eq(users.id, userId));
    }
    await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });

  it("rolls back the sealed binding when its audit insert fails", async () => {
    const database = await getDatabaseOrThrow();

    await expect(
      upsertChannelConnection(
        {
          workspaceId,
          channel: "whatsapp",
          status: "connected",
          externalId: failedPhoneNumberId,
          providerAccountExternalId: failedWabaId,
          encryptedAccessToken: "sealed-token-must-roll-back",
        },
        {
          authorization: {
            actorUserId: userId,
            allowedRoles: ["owner", "admin"],
          },
          auditLog: {
            workspaceId,
            userId,
            event: "x".repeat(121),
            metadata: { source: "mysql_atomicity_test" },
          },
        }
      )
    ).rejects.toBeDefined();

    const connections = await database
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    expect(connections).toEqual([]);
  });

  it("checks the approving membership under the connection transaction", async () => {
    const database = await getDatabaseOrThrow();
    await database
      .update(workspaceMembers)
      .set({ role: "member" })
      .where(eq(workspaceMembers.workspaceId, workspaceId));

    try {
      await expect(
        upsertChannelConnection(
          {
            workspaceId,
            channel: "whatsapp",
            status: "connected",
            externalId: failedPhoneNumberId,
            providerAccountExternalId: failedWabaId,
            encryptedAccessToken: "sealed-token-must-not-be-stored",
          },
          {
            authorization: {
              actorUserId: userId,
              allowedRoles: ["owner", "admin"],
            },
            auditLog: {
              workspaceId,
              userId,
              event: "whatsapp_binding.provisioned",
              metadata: { source: "mysql_authorization_test" },
            },
          }
        )
      ).rejects.toBeInstanceOf(ChannelConnectionAuthorizationError);
    } finally {
      await database
        .update(workspaceMembers)
        .set({ role: "owner" })
        .where(eq(workspaceMembers.workspaceId, workspaceId));
    }

    const connections = await database
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    expect(connections).toEqual([]);
  });

  it("commits the exact binding and metadata-only audit together", async () => {
    const database = await getDatabaseOrThrow();
    await upsertChannelConnection(
      {
        workspaceId,
        channel: "whatsapp",
        status: "connected",
        externalId: connectedPhoneNumberId,
        providerAccountExternalId: connectedWabaId,
        encryptedAccessToken: "sealed-test-token",
      },
      {
        authorization: {
          actorUserId: userId,
          allowedRoles: ["owner", "admin"],
        },
        auditLog: {
          workspaceId,
          userId,
          event: "whatsapp_binding.provisioned",
          metadata: { source: "mysql_atomicity_test" },
        },
      }
    );

    const connections = await database
      .select({
        externalId: channelConnections.externalId,
        providerAccountExternalId: channelConnections.providerAccountExternalId,
      })
      .from(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId));
    const audits = await database
      .select({ event: auditLog.event })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId));

    expect(connections).toEqual([
      {
        externalId: connectedPhoneNumberId,
        providerAccountExternalId: connectedWabaId,
      },
    ]);
    expect(audits).toEqual([{ event: "whatsapp_binding.provisioned" }]);
  });
});
