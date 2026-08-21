import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCostLedgerEntry,
  assertCostLedgerV2Ready,
  CostLedgerPrivacyTombstoneError,
  CostLedgerScopeError,
  deleteCostLedgerEntriesForSubject,
  readCostLedgerBudgetPeriod,
  readCostLedgerPeriod,
  resetCostLedgerReliabilityStatsForTests,
  summarizeCostLedgerPeriod,
  updateCostLedgerEntry,
  type CostLedgerEntry,
  type CostLedgerScope,
} from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";

const PERIOD_DATE = new Date("2026-06-21T12:00:00.000Z");
const PERIOD = "2026-06-21";

const scopeA: CostLedgerScope = {
  workspaceId: 41,
  channelConnectionId: 7,
  bindingEpoch: 3,
  privacyEpoch: 1,
};

const scopeB: CostLedgerScope = {
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 2,
  privacyEpoch: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  clearStateStore();
  resetCostLedgerReliabilityStatsForTests();
});

function entry(
  overrides: Partial<CostLedgerEntry> & { scope?: CostLedgerScope } = {}
): CostLedgerEntry {
  return {
    scope: overrides.scope ?? scopeA,
    id: "req-cost:attempt-1",
    channel: "facebook_messenger",
    operation: "image_generation",
    provider: "openai-images",
    model: "gpt-image-2",
    providerUsage: { pricingModel: "fixed" },
    userKey: "same-page-scoped-user-key",
    reqId: "raw-provider-request-id",
    status: "provider_attempt_started",
    estimatedCostUsd: 0.025,
    estimatedOutputCostUsd: null,
    finalCostUsd: null,
    costEstimateComplete: true,
    estimateSource: "env_override",
    unpricedCostComponents: [],
    ...overrides,
  };
}

describe("tenant-scoped cost ledger", () => {
  it("requires an immutable positive workspace/connection/binding/privacy scope", async () => {
    await expect(
      appendCostLedgerEntry(
        entry({
          scope: { ...scopeA, workspaceId: 0 },
        }),
        PERIOD_DATE
      )
    ).rejects.toBeInstanceOf(CostLedgerScopeError);

    await expect(
      readCostLedgerPeriod({ ...scopeA, privacyEpoch: 0 }, PERIOD)
    ).rejects.toBeInstanceOf(CostLedgerScopeError);

    expect(await readCostLedgerBudgetPeriod(PERIOD)).toMatchObject({
      attempts: 0,
      estimatedCostUsd: 0,
    });
  });

  it("stores same-user entries in separate workspace partitions", async () => {
    await appendCostLedgerEntry(
      entry({ id: "workspace-a-attempt", scope: scopeA }),
      PERIOD_DATE
    );
    await appendCostLedgerEntry(
      entry({ id: "workspace-b-attempt", scope: scopeB }),
      PERIOD_DATE
    );

    expect(await readCostLedgerPeriod(scopeA, PERIOD)).toMatchObject([
      { id: "workspace-a-attempt", scope: scopeA },
    ]);
    expect(await readCostLedgerPeriod(scopeB, PERIOD)).toMatchObject([
      { id: "workspace-b-attempt", scope: scopeB },
    ]);
    expect(await summarizeCostLedgerPeriod(scopeA, PERIOD)).toMatchObject({
      totalEntries: 1,
      uniqueUserCount: 1,
      estimatedCostUsd: 0.025,
    });
  });

  it("deletes only the exact workspace/connection subject and old epochs", async () => {
    const sameWorkspaceOtherConnection = {
      ...scopeA,
      channelConnectionId: 9,
    };
    const futurePrivacyEpoch = { ...scopeA, privacyEpoch: 3 };

    await appendCostLedgerEntry(
      entry({ id: "old-binding", scope: scopeA }),
      PERIOD_DATE
    );
    await appendCostLedgerEntry(
      entry({
        id: "other-binding-same-subject",
        scope: { ...scopeA, bindingEpoch: 4, privacyEpoch: 2 },
      }),
      PERIOD_DATE
    );
    await appendCostLedgerEntry(
      entry({ id: "other-connection", scope: sameWorkspaceOtherConnection }),
      PERIOD_DATE
    );
    await appendCostLedgerEntry(
      entry({ id: "future-reactivated-epoch", scope: futurePrivacyEpoch }),
      PERIOD_DATE
    );
    await appendCostLedgerEntry(
      entry({ id: "other-workspace", scope: scopeB }),
      PERIOD_DATE
    );

    await expect(
      deleteCostLedgerEntriesForSubject(
        {
          workspaceId: scopeA.workspaceId,
          channelConnectionId: scopeA.channelConnectionId,
          userKey: "same-page-scoped-user-key",
          erasureEpoch: 2,
        },
        PERIOD_DATE
      )
    ).resolves.toBe(2);

    expect(await readCostLedgerPeriod(scopeA, PERIOD)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "other-connection" }),
        expect.objectContaining({ id: "future-reactivated-epoch" }),
      ])
    );
    expect(await readCostLedgerPeriod(scopeA, PERIOD)).toHaveLength(2);
    expect(await readCostLedgerPeriod(scopeB, PERIOD)).toMatchObject([
      { id: "other-workspace" },
    ]);
  });

  it("erases a still-live entry on the inclusive day-90 retention boundary", async () => {
    const boundaryEntryDate = new Date("2026-03-23T23:59:59.000Z");
    await appendCostLedgerEntry(
      entry({ id: "inclusive-day-90", scope: scopeA }),
      boundaryEntryDate
    );

    await expect(
      deleteCostLedgerEntriesForSubject(
        {
          workspaceId: scopeA.workspaceId,
          channelConnectionId: scopeA.channelConnectionId,
          userKey: "same-page-scoped-user-key",
          erasureEpoch: 1,
        },
        PERIOD_DATE
      )
    ).resolves.toBe(1);
    await expect(readCostLedgerPeriod(scopeA, "2026-03-23")).resolves.toEqual(
      []
    );
  });

  it("uses a monotonic tombstone to block stale append and update resurrection", async () => {
    await appendCostLedgerEntry(
      entry({ id: "stale-update-target", scope: scopeA }),
      PERIOD_DATE
    );
    await deleteCostLedgerEntriesForSubject(
      {
        workspaceId: scopeA.workspaceId,
        channelConnectionId: scopeA.channelConnectionId,
        userKey: "same-page-scoped-user-key",
        erasureEpoch: 2,
      },
      PERIOD_DATE
    );

    await expect(
      appendCostLedgerEntry(
        entry({
          id: "stale-late-append",
          scope: { ...scopeA, privacyEpoch: 2 },
        }),
        PERIOD_DATE
      )
    ).rejects.toBeInstanceOf(CostLedgerPrivacyTombstoneError);
    await expect(
      updateCostLedgerEntry(
        { ...scopeA, userKey: "same-page-scoped-user-key" },
        "stale-update-target",
        { status: "provider_attempt_succeeded" },
        PERIOD_DATE
      )
    ).rejects.toBeInstanceOf(CostLedgerPrivacyTombstoneError);

    await expect(
      appendCostLedgerEntry(
        entry({
          id: "strictly-new-epoch",
          scope: { ...scopeA, privacyEpoch: 3 },
        }),
        PERIOD_DATE
      )
    ).resolves.toMatchObject({ id: "strictly-new-epoch" });
  });

  it("rejects a wrong-scope update even when entry IDs collide", async () => {
    await appendCostLedgerEntry(
      entry({ id: "shared-attempt", scope: scopeA }),
      PERIOD_DATE
    );
    await appendCostLedgerEntry(
      entry({ id: "shared-attempt", scope: scopeB }),
      PERIOD_DATE
    );

    await expect(
      updateCostLedgerEntry(
        {
          ...scopeA,
          channelConnectionId: 99,
          userKey: "same-page-scoped-user-key",
        },
        "shared-attempt",
        { status: "provider_attempt_succeeded" },
        PERIOD_DATE
      )
    ).resolves.toBeNull();

    await expect(
      updateCostLedgerEntry(
        { ...scopeA, userKey: "same-page-scoped-user-key" },
        "shared-attempt",
        { status: "provider_attempt_succeeded", finalCostUsd: 0.025 },
        PERIOD_DATE
      )
    ).resolves.toMatchObject({
      scope: scopeA,
      status: "provider_attempt_succeeded",
    });
    expect((await readCostLedgerPeriod(scopeB, PERIOD))[0]?.status).toBe(
      "provider_attempt_started"
    );
  });

  it("keeps the shared budget baseline metadata-only and deletion-independent", async () => {
    const privateUser = "private-user-key-never-in-global-aggregate";
    const privateRequest = "private-request-id-never-in-global-aggregate";
    await appendCostLedgerEntry(
      entry({
        scope: scopeA,
        userKey: privateUser,
        reqId: privateRequest,
        estimatedCostUsd: 0.02,
        estimatedOutputCostUsd: 0.005,
        providerUsage: { sourceBytes: 123_456, privateMarker: privateUser },
      }),
      PERIOD_DATE
    );

    const beforeDelete = await readCostLedgerBudgetPeriod(PERIOD);
    expect(beforeDelete).toMatchObject({
      version: 2,
      attempts: 1,
      estimatedCostUsd: 0.025,
      byOperation: {
        image_generation: { attempts: 1, estimatedCostUsd: 0.025 },
      },
      byProvider: {
        "openai-images": { attempts: 1, estimatedCostUsd: 0.025 },
      },
    });
    const serialized = JSON.stringify(beforeDelete);
    for (const forbidden of [
      "workspaceId",
      "channelConnectionId",
      "bindingEpoch",
      "privacyEpoch",
      "userKey",
      "reqId",
      "providerUsage",
      privateUser,
      privateRequest,
      "123456",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    await deleteCostLedgerEntriesForSubject(
      {
        workspaceId: scopeA.workspaceId,
        channelConnectionId: scopeA.channelConnectionId,
        userKey: privateUser,
        erasureEpoch: 2,
      },
      PERIOD_DATE
    );
    expect(await readCostLedgerPeriod(scopeA, PERIOD)).toEqual([]);
    expect(await readCostLedgerBudgetPeriod(PERIOD)).toEqual(beforeDelete);
  });

  it("deduplicates an exact scoped retry without inflating the global baseline", async () => {
    const attempt = entry({ id: "idempotent-attempt", scope: scopeA });
    await appendCostLedgerEntry(attempt, PERIOD_DATE);
    await appendCostLedgerEntry(attempt, PERIOD_DATE);

    expect(await readCostLedgerPeriod(scopeA, PERIOD)).toHaveLength(1);
    expect(await readCostLedgerBudgetPeriod(PERIOD)).toMatchObject({
      attempts: 1,
      estimatedCostUsd: 0.025,
    });
  });

  it("passes the v2 readiness check when Redis has no legacy global keys", async () => {
    await expect(assertCostLedgerV2Ready()).resolves.toBeUndefined();
  });
});
