import { afterEach, describe, expect, it, vi } from "vitest";

const { getRedisClientMock, isRedisEnabledMock } = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(),
}));

vi.mock("./_core/redis", () => ({
  getRedisClient: getRedisClientMock,
  isRedisEnabled: isRedisEnabledMock,
  ensureRedisReady: vi.fn(async () => undefined),
  resetRedisClientForTests: vi.fn(),
}));

import { readCostLedgerPeriod, summarizeCostLedgerPeriod } from "./_core/costLedger";
import type { StoredCostLedgerEntry } from "./_core/costLedger";

afterEach(() => {
  vi.restoreAllMocks();
  getRedisClientMock.mockReset();
  isRedisEnabledMock.mockReset();
});

describe("cost ledger Redis legacy compatibility", () => {
  it("reads legacy Redis list periods when JSON state reads hit WRONGTYPE", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    const legacyEntry: StoredCostLedgerEntry = {
      id: "req-legacy:attempt-1",
      channel: "facebook_messenger",
      operation: "image_generation",
      provider: "openai-images",
      model: "gpt-image-2",
      userKey: "legacy-user-key",
      reqId: "req-legacy",
      status: "provider_attempt_succeeded",
      estimatedCostUsd: 0.025,
      estimatedOutputCostUsd: null,
      finalCostUsd: 0.025,
      costEstimateComplete: true,
      estimateSource: "env_override",
      unpricedCostComponents: [],
      period: "2026-06-21",
      recordedAt: "2026-06-21T12:00:00.000Z",
    };
    const redis = {
      get: vi.fn(async () => {
        throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
      }),
      lrange: vi.fn(async () => [JSON.stringify(legacyEntry)]),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(readCostLedgerPeriod("2026-06-21")).resolves.toEqual([
      legacyEntry,
    ]);
    await expect(summarizeCostLedgerPeriod("2026-06-21")).resolves.toMatchObject({
      totalEntries: 1,
      finalCostUsd: 0.025,
    });
    expect(redis.lrange).toHaveBeenCalledWith(
      "cost:ledger:period:2026-06-21",
      0,
      -1
    );
  });
});
