import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
  workspaces,
} from "../drizzle/schema";
import {
  claimMessengerProviderAttemptFence,
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  type MessengerProviderAttemptClaim,
} from "./_core/messengerProviderAttemptFence";
import type { MessengerGenerationJob } from "./_core/messengerGenerationJob";
import { getDatabaseOrThrow } from "./db";

const suite = describe.runIf(process.env.RUN_MYSQL_INTEGRATION === "1");

suite("Messenger provider attempt fence MySQL concurrency", () => {
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    fixtures.push(await createFixture("primary"));
    fixtures.push(await createFixture("other-tenant"));
  });

  afterAll(async () => {
    const database = await getDatabaseOrThrow();
    const workspaceIds = fixtures.map(fixture => fixture.workspaceId);
    if (workspaceIds.length === 0) return;
    await database
      .delete(messengerProviderAttemptFences)
      .where(inArray(messengerProviderAttemptFences.workspaceId, workspaceIds));
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

  it("gives exactly one caller a new reservation under concurrency", async () => {
    const job = fixtureJob(fixtures[0]!, "concurrent-new");
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimMessengerProviderAttemptFence(job, "messenger-graph-send", 1)
      )
    );

    expect(claims.filter(claim => claim.kind === "owned")).toHaveLength(1);
    expect(claims.filter(claim => claim.kind === "busy")).toHaveLength(7);
  });

  it("lets recovery take over reserved work and makes the old token lose", async () => {
    const job = fixtureJob(fixtures[0]!, "reserved-recovery-wins");
    const original = owned(
      await claimMessengerProviderAttemptFence(job, "messenger-graph-send", 1)
    );
    const recovery = owned(
      await claimMessengerProviderAttemptFence(
        job,
        "messenger-graph-send",
        1,
        new Date(),
        { takeOverReserved: true }
      )
    );

    expect(recovery.leaseToken).not.toBe(original.leaseToken);
    await expect(markMessengerProviderAttemptStarted(original)).rejects.toThrow(
      "ownership was lost"
    );
    await expect(
      markMessengerProviderAttemptStarted(recovery)
    ).resolves.toBeUndefined();
  });

  it("never reclaims after the original caller marked provider start", async () => {
    const job = fixtureJob(fixtures[0]!, "provider-start-wins");
    const original = owned(
      await claimMessengerProviderAttemptFence(job, "messenger-graph-send", 1)
    );
    await markMessengerProviderAttemptStarted(original);

    await expect(
      claimMessengerProviderAttemptFence(
        job,
        "messenger-graph-send",
        1,
        new Date(),
        { takeOverReserved: true }
      )
    ).resolves.toEqual({ kind: "unsafe_or_done", status: "started" });
  });

  it("reclaims known failures but never ambiguous or successful attempts", async () => {
    const knownFailedJob = fixtureJob(fixtures[0]!, "known-failed-reclaim");
    const knownFailed = owned(
      await claimMessengerProviderAttemptFence(
        knownFailedJob,
        "messenger-graph-send",
        1
      )
    );
    await finalizeMessengerProviderAttemptFence(knownFailed, "known_failed");
    expect(
      (
        await claimMessengerProviderAttemptFence(
          knownFailedJob,
          "messenger-graph-send",
          1
        )
      ).kind
    ).toBe("owned");

    for (const outcome of ["ambiguous", "succeeded"] as const) {
      const job = fixtureJob(fixtures[0]!, `terminal-${outcome}`);
      const fence = owned(
        await claimMessengerProviderAttemptFence(job, "messenger-graph-send", 1)
      );
      await markMessengerProviderAttemptStarted(fence);
      await finalizeMessengerProviderAttemptFence(fence, outcome);
      await expect(
        claimMessengerProviderAttemptFence(
          job,
          "messenger-graph-send",
          1,
          new Date(),
          { takeOverReserved: true }
        )
      ).resolves.toEqual({ kind: "unsafe_or_done", status: outcome });
    }
  });

  it("keeps the same logical request separate across tenants", async () => {
    const first = await claimMessengerProviderAttemptFence(
      fixtureJob(fixtures[0]!, "same-logical-request"),
      "messenger-graph-send",
      1
    );
    const second = await claimMessengerProviderAttemptFence(
      fixtureJob(fixtures[1]!, "same-logical-request"),
      "messenger-graph-send",
      1
    );

    expect(first.kind).toBe("owned");
    expect(second.kind).toBe("owned");
    if (first.kind !== "owned" || second.kind !== "owned") return;
    expect(first.fence.attemptKeyHash).not.toBe(second.fence.attemptKeyHash);
  });
});

type Fixture = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  pageId: string;
  userKey: string;
}>;

async function createFixture(label: string): Promise<Fixture> {
  const database = await getDatabaseOrThrow();
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const slug = `provider-fence-${label}-${suffix}`;
  await database.insert(workspaces).values({ name: slug, slug });
  const workspaceId = (
    await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, slug))
      .limit(1)
  )[0]!.id;
  const pageId = `provider-fence-page-${label}-${suffix}`;
  await database.insert(channelConnections).values({
    workspaceId,
    channel: "facebook_messenger",
    status: "connected",
    externalId: pageId,
  });
  const channelConnectionId = (
    await database
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(eq(channelConnections.workspaceId, workspaceId))
      .limit(1)
  )[0]!.id;
  const userKey = "f".repeat(64);
  await database.insert(messengerPrivacySubjects).values({
    workspaceId,
    channelConnectionId,
    userKey,
    privacyEpoch: 1,
    status: "active",
  });
  return { workspaceId, channelConnectionId, pageId, userKey };
}

function fixtureJob(fixture: Fixture, reqId: string): MessengerGenerationJob {
  return {
    psid: "provider-fence-test-psid",
    userId: fixture.userKey,
    reqId,
    lang: "nl",
    pageId: fixture.pageId,
    workspaceId: fixture.workspaceId,
    channelConnectionId: fixture.channelConnectionId,
    bindingEpoch: 1,
    privacyEpoch: 1,
  };
}

function owned(claim: MessengerProviderAttemptClaim) {
  if (claim.kind !== "owned") {
    throw new Error(`Expected owned provider fence, received ${claim.kind}`);
  }
  return claim.fence;
}
