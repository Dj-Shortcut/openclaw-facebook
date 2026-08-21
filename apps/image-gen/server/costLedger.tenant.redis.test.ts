import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  appendCostLedgerEntry,
  assertCostLedgerV2Ready,
  deleteCostLedgerEntriesForSubject,
  LegacyCostLedgerDataError,
  readCostLedgerBudgetPeriod,
  readCostLedgerPeriod,
  resetCostLedgerReliabilityStatsForTests,
  setCostLedgerBeforeDetailCommitHookForTests,
  type CostLedgerEntry,
  type CostLedgerScope,
} from "./_core/costLedger";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";
import { resetStateStore } from "./_core/messengerState";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const NOW = new Date("2031-04-05T12:00:00.000Z");
const PERIOD = "2031-04-05";
const USER = "same-user-key-across-tenant-boundaries";

const tenantA: CostLedgerScope = {
  workspaceId: 701,
  channelConnectionId: 71,
  bindingEpoch: 3,
  privacyEpoch: 1,
};
const tenantB: CostLedgerScope = {
  workspaceId: 702,
  channelConnectionId: 72,
  bindingEpoch: 5,
  privacyEpoch: 1,
};

suite("tenant-scoped cost ledger Redis contract", () => {
  beforeAll(() => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/12";
    resetRedisClientForTests();
  });

  beforeEach(async () => {
    resetStateStore();
    resetCostLedgerReliabilityStatsForTests();
    const redis = await getRedisClient();
    await redis.eval("return redis.call('FLUSHDB')", 0);
  });

  afterAll(() => {
    resetStateStore();
    resetCostLedgerReliabilityStatsForTests();
    resetRedisClientForTests();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it("isolates identical users and entry IDs across workspaces", async () => {
    await Promise.all([
      appendCostLedgerEntry(costEntry(tenantA, "shared-id"), NOW),
      appendCostLedgerEntry(costEntry(tenantB, "shared-id"), NOW),
    ]);

    await deleteCostLedgerEntriesForSubject(
      {
        workspaceId: tenantA.workspaceId,
        channelConnectionId: tenantA.channelConnectionId,
        userKey: USER,
        erasureEpoch: 2,
      },
      NOW
    );

    await expect(readCostLedgerPeriod(tenantA, PERIOD)).resolves.toEqual([]);
    await expect(readCostLedgerPeriod(tenantB, PERIOD)).resolves.toMatchObject([
      { id: "shared-id", scope: tenantB, userKey: USER },
    ]);
  });

  it("atomically increments the identifier-free budget without corrupting arrays", async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        appendCostLedgerEntry(
          {
            ...costEntry(tenantA, `concurrent-budget-${index}`),
            userKey: `${USER}-${index}`,
          },
          NOW
        )
      )
    );

    await expect(readCostLedgerBudgetPeriod(PERIOD)).resolves.toMatchObject({
      attempts: 50,
      estimatedCostUsd: 0.5,
      unpricedCostComponents: [],
    });
    const detail = await readCostLedgerPeriod(tenantA, PERIOD);
    expect(detail).toHaveLength(50);
    expect(
      detail.every(entry => Array.isArray(entry.unpricedCostComponents))
    ).toBe(true);
  });

  it("makes concurrent erasure win over every stale append", async () => {
    await appendCostLedgerEntry(costEntry(tenantA, "before-race"), NOW);

    const results = await Promise.allSettled([
      deleteCostLedgerEntriesForSubject(
        {
          workspaceId: tenantA.workspaceId,
          channelConnectionId: tenantA.channelConnectionId,
          userKey: USER,
          erasureEpoch: 2,
        },
        NOW
      ),
      ...Array.from({ length: 40 }, (_, index) =>
        appendCostLedgerEntry(costEntry(tenantA, `race-${index}`), NOW)
      ),
    ]);

    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    await expect(readCostLedgerPeriod(tenantA, PERIOD)).resolves.toEqual([]);
    await expect(
      appendCostLedgerEntry(costEntry(tenantA, "after-race"), NOW)
    ).rejects.toMatchObject({ name: "CostLedgerPrivacyTombstoneError" });
  });

  it("cannot resurrect detail after the writer lease expires before commit", async () => {
    let releaseCommit!: () => void;
    let reachedCommit!: () => void;
    const commitReached = new Promise<void>(resolve => {
      reachedCommit = resolve;
    });
    const commitReleased = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });
    setCostLedgerBeforeDetailCommitHookForTests(async () => {
      reachedCommit();
      await commitReleased;
    });

    const staleAppend = appendCostLedgerEntry(
      costEntry(tenantA, "stale-after-expired-lease"),
      NOW
    );
    await commitReached;

    const redis = await getRedisClient();
    const [, subjectLocks] = await redis.scan(
      "0",
      "MATCH",
      "lock:cost:ledger:v2:subject-erasure:*",
      "COUNT",
      100
    );
    expect(subjectLocks).toHaveLength(1);
    await redis.del(subjectLocks[0]);

    await expect(
      deleteCostLedgerEntriesForSubject(
        {
          workspaceId: tenantA.workspaceId,
          channelConnectionId: tenantA.channelConnectionId,
          userKey: USER,
          erasureEpoch: 2,
        },
        NOW
      )
    ).resolves.toBe(0);
    releaseCommit();

    await expect(staleAppend).rejects.toMatchObject({
      name: "CostLedgerPrivacyTombstoneError",
    });
    await expect(readCostLedgerPeriod(tenantA, PERIOD)).resolves.toEqual([]);
  });

  it("fails readiness on any unscoped legacy key without reading its payload", async () => {
    const redis = await getRedisClient();
    const legacyKey = "cost:ledger:period:2031-04-05";
    await redis.set(legacyKey, "raw-legacy-payload-must-not-be-inferred");

    await expect(assertCostLedgerV2Ready()).rejects.toBeInstanceOf(
      LegacyCostLedgerDataError
    );
    await expect(redis.get(legacyKey)).resolves.toBe(
      "raw-legacy-payload-must-not-be-inferred"
    );

    await redis.del(legacyKey);
    await expect(assertCostLedgerV2Ready()).resolves.toBeUndefined();
  });
});

function costEntry(scope: CostLedgerScope, id: string): CostLedgerEntry {
  return {
    scope,
    id,
    channel: "facebook_messenger",
    operation: "image_generation",
    provider: "openai-images",
    model: "gpt-image-2",
    userKey: USER,
    reqId: id,
    status: "provider_attempt_started",
    estimatedCostUsd: 0.01,
    estimatedOutputCostUsd: null,
    finalCostUsd: null,
    costEstimateComplete: true,
    estimateSource: "test",
    unpricedCostComponents: [],
  };
}
