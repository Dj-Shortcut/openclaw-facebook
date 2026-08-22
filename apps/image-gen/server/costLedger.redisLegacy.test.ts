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

import {
  appendCostLedgerEntry,
  assertCostLedgerV2Ready,
  LegacyCostLedgerDataError,
} from "./_core/costLedger";

afterEach(() => {
  vi.restoreAllMocks();
  getRedisClientMock.mockReset();
  isRedisEnabledMock.mockReset();
});

describe("cost ledger Redis legacy containment", () => {
  it("fails readiness without reading or inferring an unscoped legacy payload", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    const redis = {
      scan: vi.fn(async () => ["0", ["cost:ledger:period:2026-06-21"]]),
      get: vi.fn(),
      lrange: vi.fn(),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(assertCostLedgerV2Ready()).rejects.toBeInstanceOf(
      LegacyCostLedgerDataError
    );
    expect(redis.scan).toHaveBeenCalledWith(
      "0",
      "MATCH",
      "cost:ledger:period:*",
      "COUNT",
      100
    );
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.lrange).not.toHaveBeenCalled();
  });

  it("blocks a production provider admission while legacy data is present", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    isRedisEnabledMock.mockReturnValue(true);
    const redis = {
      scan: vi.fn(async () => ["0", ["cost:ledger:period:2026-06-21"]]),
      get: vi.fn(),
      eval: vi.fn(),
    };
    getRedisClientMock.mockResolvedValue(redis);

    try {
      await expect(
        appendCostLedgerEntry(
          {
            scope: {
              workspaceId: 41,
              channelConnectionId: 7,
              bindingEpoch: 3,
              privacyEpoch: 1,
            },
            id: "blocked-before-provider",
            channel: "facebook_messenger",
            operation: "image_generation",
            provider: "openai-images",
            model: "gpt-image-2",
            userKey: "privacy-scoped-user",
            reqId: "blocked-before-provider",
            status: "provider_attempt_started",
            estimatedCostUsd: 0.01,
            estimatedOutputCostUsd: null,
            finalCostUsd: null,
            costEstimateComplete: true,
            estimateSource: "test",
            unpricedCostComponents: [],
          },
          new Date("2026-06-21T12:00:00.000Z")
        )
      ).rejects.toBeInstanceOf(LegacyCostLedgerDataError);
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
