import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
  workspaces,
} from "../drizzle/schema";
import {
  disconnectChannelConnection,
  getDatabaseOrThrow,
  upsertChannelConnection,
} from "./db";
import type { MessengerGenerationJob } from "./_core/messengerGenerationJob";
import { beginMessengerPrivacyErasure } from "./_core/messengerPrivacySubject";
import {
  containMessengerProviderAttemptsForPrivacy,
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reconcileMessengerPrivacyProviderAttempt,
  reserveMessengerProviderAttemptFence,
} from "./_core/messengerProviderAttemptFence";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("messenger provider attempt MySQL identity", () => {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userKey = "provider-fence-mysql-user";
  const reqId = `provider-fence-request-${suffix}`;
  const pageIds = [
    `provider-fence-page-a-${suffix}`,
    `provider-fence-page-b-${suffix}`,
  ];
  const workspaceIds: number[] = [];
  const connectionIds: number[] = [];

  beforeAll(async () => {
    const database = await getDatabaseOrThrow();
    for (const tenant of ["a", "b"]) {
      const slug = `provider-fence-${tenant}-${suffix}`;
      await database.insert(workspaces).values({ name: slug, slug });
      const workspace = await database
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1);
      workspaceIds.push(workspace[0]!.id);
    }
    for (const [index, workspaceId] of workspaceIds.entries()) {
      await database.insert(channelConnections).values({
        workspaceId,
        channel: "facebook_messenger",
        status: "connected",
        externalId: pageIds[index],
      });
      const connection = await database
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(eq(channelConnections.externalId, pageIds[index]!))
        .limit(1);
      connectionIds.push(connection[0]!.id);
      await database.insert(messengerPrivacySubjects).values({
        workspaceId,
        channelConnectionId: connection[0]!.id,
        userKey,
        privacyEpoch: 1,
        status: "active",
      });
    }
  });

  afterAll(async () => {
    if (workspaceIds.length === 0) return;
    const database = await getDatabaseOrThrow();
    await database
      .delete(messengerProviderAttemptFences)
      .where(inArray(messengerProviderAttemptFences.workspaceId, workspaceIds));
    await database
      .delete(auditLog)
      .where(inArray(auditLog.workspaceId, workspaceIds));
    await database
      .delete(messengerPrivacySubjects)
      .where(inArray(messengerPrivacySubjects.workspaceId, workspaceIds));
    await database
      .delete(channelConnections)
      .where(inArray(channelConnections.workspaceId, workspaceIds));
    await database
      .delete(workspaces)
      .where(inArray(workspaces.id, workspaceIds));
  });

  it("blocks automatic retries and preserves tenant scope", async () => {
    const firstTenant = jobFor(0);
    const first = await reserveMessengerProviderAttemptFence(
      firstTenant,
      "image_generation",
      1
    );
    await expect(
      reserveMessengerProviderAttemptFence(firstTenant, "image_generation", 2)
    ).rejects.toThrow("Messenger provider attempt already fenced");

    await expect(
      reserveMessengerProviderAttemptFence(
        { ...firstTenant, workspaceId: workspaceIds[1] },
        "image_generation",
        1
      )
    ).rejects.toThrow("Messenger provider ownership changed");

    const otherTenant = await reserveMessengerProviderAttemptFence(
      jobFor(1),
      "image_generation",
      1
    );
    expect(otherTenant.attemptKeyHash).not.toBe(first.attemptKeyHash);

    const database = await getDatabaseOrThrow();
    const stored = await database
      .select({
        workspaceId: messengerProviderAttemptFences.workspaceId,
        attemptKeyHash: messengerProviderAttemptFences.attemptKeyHash,
      })
      .from(messengerProviderAttemptFences)
      .where(inArray(messengerProviderAttemptFences.workspaceId, workspaceIds));
    expect(stored).toHaveLength(2);
    expect(
      stored.filter(row => row.workspaceId === workspaceIds[0])
    ).toHaveLength(1);
    expect(
      stored.filter(row => row.workspaceId === workspaceIds[1])
    ).toHaveLength(1);
  });

  it("keeps started and ambiguous operations permanently fenced", async () => {
    const job = { ...jobFor(0), reqId: `${reqId}-ambiguous` };
    const first = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      1
    );
    await markMessengerProviderAttemptStarted(first);

    await expect(
      reserveMessengerProviderAttemptFence(job, "image_generation", 2)
    ).rejects.toThrow("Messenger provider attempt already fenced");

    await finalizeMessengerProviderAttemptFence(first, "ambiguous");
    await expect(
      reserveMessengerProviderAttemptFence(job, "image_generation", 3)
    ).rejects.toThrow("Messenger provider attempt already fenced");
  });

  it("keeps privacy erasure pending for expired started and ambiguous operations", async () => {
    const start = new Date("2026-08-21T12:00:00.000Z");
    const startedJob = { ...jobFor(0), reqId: `${reqId}-privacy-started` };
    const started = await reserveMessengerProviderAttemptFence(
      startedJob,
      "messenger-graph-send",
      1,
      start
    );
    await markMessengerProviderAttemptStarted(started, start);

    await expect(
      containMessengerProviderAttemptsForPrivacy(
        {
          workspaceId: workspaceIds[0]!,
          channelConnectionId: connectionIds[0]!,
          userKey,
        },
        new Date(start.getTime() + 60 * 60_000)
      )
    ).resolves.toBe(false);

    await finalizeMessengerProviderAttemptFence(
      started,
      "ambiguous",
      new Date(start.getTime() + 60 * 60_000)
    );
    await expect(
      containMessengerProviderAttemptsForPrivacy({
        workspaceId: workspaceIds[0]!,
        channelConnectionId: connectionIds[0]!,
        userKey,
      })
    ).resolves.toBe(false);

    const database = await getDatabaseOrThrow();
    const stored = await database
      .select({ status: messengerProviderAttemptFences.status })
      .from(messengerProviderAttemptFences)
      .where(
        eq(
          messengerProviderAttemptFences.attemptKeyHash,
          started.attemptKeyHash!
        )
      )
      .limit(1);
    expect(stored[0]?.status).toBe("ambiguous");

    // A row written by the retired blind-abandonment contract is not proof
    // that the provider outcome or artifacts were reconciled. It must keep
    // authoritative erasure pending until the evidence-backed admin action.
    await database
      .update(messengerProviderAttemptFences)
      .set({ status: "abandoned" })
      .where(
        eq(
          messengerProviderAttemptFences.attemptKeyHash,
          started.attemptKeyHash!
        )
      );
    await expect(
      containMessengerProviderAttemptsForPrivacy({
        workspaceId: workspaceIds[0]!,
        channelConnectionId: connectionIds[0]!,
        userKey,
      })
    ).resolves.toBe(false);
    await database
      .delete(messengerProviderAttemptFences)
      .where(
        eq(
          messengerProviderAttemptFences.attemptKeyHash,
          started.attemptKeyHash!
        )
      );
  });

  it("allows only one of two replicas to reserve the same operation", async () => {
    const job = { ...jobFor(0), reqId: `${reqId}-two-replicas` };
    const results = await Promise.allSettled([
      reserveMessengerProviderAttemptFence(job, "image_generation", 1),
      reserveMessengerProviderAttemptFence(job, "image_generation", 2),
    ]);

    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(
      1
    );
    const rejection = results.find(result => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.objectContaining({
        message: "Messenger provider attempt already fenced",
      }),
    });
  });

  it("allows exactly one new owner after a proven known failure", async () => {
    const job = { ...jobFor(0), reqId: `${reqId}-known-failed` };
    const first = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      1
    );
    await finalizeMessengerProviderAttemptFence(first, "known_failed");

    const retry = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      2
    );
    expect(retry.leaseToken).not.toBe(first.leaseToken);
    await expect(
      reserveMessengerProviderAttemptFence(job, "image_generation", 3)
    ).rejects.toThrow("Messenger provider attempt already fenced");
  });

  it("fences stale owners after an expired reservation takeover", async () => {
    const job = { ...jobFor(0), reqId: `${reqId}-takeover` };
    const start = new Date("2026-08-21T12:00:00.000Z");
    const stale = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      1,
      start
    );
    const replacement = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      2,
      new Date(start.getTime() + 16 * 60_000)
    );

    await expect(markMessengerProviderAttemptStarted(stale)).rejects.toThrow(
      "Messenger provider attempt fence ownership was lost"
    );
    await expect(
      markMessengerProviderAttemptStarted(replacement)
    ).resolves.toBeUndefined();
    await finalizeMessengerProviderAttemptFence(replacement, "known_failed");
  });

  it("rejects provider start after the Page binding changes", async () => {
    const job = { ...jobFor(0), reqId: `${reqId}-rebind` };
    const reserved = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      1
    );
    await expect(
      upsertChannelConnection({
        workspaceId: workspaceIds[0]!,
        channel: "facebook_messenger",
        status: "connected",
        externalId: pageIds[0]!,
        encryptedAccessToken: "sealed-provider-fence-rebind-token",
      })
    ).rejects.toThrow("active provider attempt");
    await finalizeMessengerProviderAttemptFence(reserved, "known_failed");
    await expect(
      upsertChannelConnection({
        workspaceId: workspaceIds[0]!,
        channel: "facebook_messenger",
        status: "connected",
        externalId: pageIds[0]!,
        encryptedAccessToken: "sealed-provider-fence-rebind-token",
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: connectionIds[0],
          bindingEpoch: 2,
        }),
      ])
    );
    const database = await getDatabaseOrThrow();
    try {
      await expect(
        markMessengerProviderAttemptStarted(reserved)
      ).rejects.toThrow("Messenger provider ownership changed");
    } finally {
      await database
        .update(channelConnections)
        .set({ bindingEpoch: 1 })
        .where(eq(channelConnections.id, connectionIds[0]!));
    }
  });

  it("requires evidence-backed containment, rejects the stale worker, and lets erasure retire the immutable fence", async () => {
    const database = await getDatabaseOrThrow();
    const scopedUserKey = "provider-fence-erasure-fk-user";
    const start = new Date("2026-08-21T12:00:00.000Z");
    await database.insert(messengerPrivacySubjects).values({
      workspaceId: workspaceIds[1]!,
      channelConnectionId: connectionIds[1]!,
      userKey: scopedUserKey,
      privacyEpoch: 1,
      status: "active",
    });
    let attemptKeyHash: string | null = null;
    try {
      const reserved = await reserveMessengerProviderAttemptFence(
        {
          ...jobFor(1),
          userId: scopedUserKey,
          reqId: `${reqId}-erasure-fk`,
        },
        "image_generation",
        1,
        start
      );
      attemptKeyHash = reserved.attemptKeyHash;
      await markMessengerProviderAttemptStarted(reserved, start);

      await expect(
        disconnectChannelConnection(workspaceIds[1]!, "facebook_messenger")
      ).rejects.toThrow("active provider attempt");

      const resolution = {
        requestId: "11111111-1111-4111-8111-111111111111",
        attemptKeyHash: attemptKeyHash!,
        workspaceId: workspaceIds[1]!,
        channelConnectionId: connectionIds[1]!,
        expectedBindingEpoch: 1,
        expectedPrivacyEpoch: 1,
        expectedAttemptNumber: 1,
        expectedStatus: "started" as const,
        resolution: "artifacts_contained" as const,
        evidenceReferenceHash: "c".repeat(64),
        actorUserId: 991,
        now: new Date(start.getTime() + 16 * 60_000),
      };
      const outcomes = await Promise.all([
        reconcileMessengerPrivacyProviderAttempt(resolution),
        reconcileMessengerPrivacyProviderAttempt({
          ...resolution,
          requestId: "22222222-2222-4222-8222-222222222222",
        }),
      ]);
      expect(outcomes.filter(outcome => outcome.resolved)).toHaveLength(1);
      await expect(
        finalizeMessengerProviderAttemptFence(reserved, "succeeded")
      ).rejects.toThrow("finalization was lost");

      const auditRows = await database
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.workspaceId, workspaceIds[1]!),
            eq(auditLog.event, "messenger_provider_attempt.operator_contained")
          )
        );
      expect(auditRows).toHaveLength(1);
      expect(JSON.stringify(auditRows[0]?.metadata)).not.toContain(
        scopedUserKey
      );
      expect(auditRows[0]?.metadata).toMatchObject({
        resolution: "artifacts_contained",
        evidenceReferenceHash: "c".repeat(64),
      });

      // The evidence-backed containment path also works before an erasure is
      // opened, so an emergency disconnect/rebind is not permanently wedged.
      await expect(
        beginMessengerPrivacyErasure({
          workspaceId: workspaceIds[1]!,
          channelConnectionId: connectionIds[1]!,
          userKey: scopedUserKey,
        })
      ).resolves.toBe(1);
      const subject = await database
        .select({
          privacyEpoch: messengerPrivacySubjects.privacyEpoch,
          status: messengerPrivacySubjects.status,
        })
        .from(messengerPrivacySubjects)
        .where(eq(messengerPrivacySubjects.userKey, scopedUserKey))
        .limit(1);
      expect(subject[0]).toEqual({ privacyEpoch: 1, status: "erasing" });

      await expect(
        disconnectChannelConnection(workspaceIds[1]!, "facebook_messenger")
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: connectionIds[1],
            status: "disconnected",
            bindingEpoch: 2,
          }),
        ])
      );

      await expect(
        containMessengerProviderAttemptsForPrivacy({
          workspaceId: workspaceIds[1]!,
          channelConnectionId: connectionIds[1]!,
          userKey: scopedUserKey,
        })
      ).resolves.toBe(true);
      const retained = await database
        .select({ id: messengerProviderAttemptFences.id })
        .from(messengerProviderAttemptFences)
        .where(
          eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash!)
        );
      expect(retained).toEqual([]);
    } finally {
      if (attemptKeyHash) {
        await database
          .delete(messengerProviderAttemptFences)
          .where(
            eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash)
          );
      }
      await database
        .delete(messengerPrivacySubjects)
        .where(eq(messengerPrivacySubjects.userKey, scopedUserKey));
    }
  });

  it("rejects provider start after the privacy subject is erased", async () => {
    const job = { ...jobFor(0), reqId: `${reqId}-privacy` };
    const reserved = await reserveMessengerProviderAttemptFence(
      job,
      "image_generation",
      1
    );
    const database = await getDatabaseOrThrow();
    await database
      .update(messengerPrivacySubjects)
      .set({ status: "erasing" })
      .where(
        eq(messengerPrivacySubjects.channelConnectionId, connectionIds[0]!)
      );
    try {
      await expect(
        markMessengerProviderAttemptStarted(reserved)
      ).rejects.toThrow("Messenger provider privacy changed");
    } finally {
      await database
        .update(messengerPrivacySubjects)
        .set({ status: "active" })
        .where(
          eq(messengerPrivacySubjects.channelConnectionId, connectionIds[0]!)
        );
    }
  });

  function jobFor(index: number): MessengerGenerationJob {
    return {
      pageId: pageIds[index],
      workspaceId: workspaceIds[index],
      channelConnectionId: connectionIds[index],
      bindingEpoch: 1,
      userId: userKey,
      privacyEpoch: 1,
      reqId,
      psid: "synthetic-psid",
      lang: "nl",
    };
  }
});
