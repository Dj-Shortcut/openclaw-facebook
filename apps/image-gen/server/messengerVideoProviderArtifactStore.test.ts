import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isRedisEnabledMock, redisEvalMock } = vi.hoisted(() => ({
  isRedisEnabledMock: vi.fn(() => false),
  redisEvalMock: vi.fn(),
}));

vi.mock("./_core/redis", () => ({
  isRedisEnabled: isRedisEnabledMock,
  getRedisClient: vi.fn(async () => ({
    eval: redisEvalMock,
  })),
}));

import {
  beginMessengerVideoProviderArtifactErasure,
  registerMessengerVideoProviderArtifact,
  removeMessengerVideoProviderArtifact,
  resetMessengerVideoProviderArtifactStoreForTests,
} from "./_core/messengerVideoProviderArtifactStore";

const USER_KEY = "a".repeat(64);
const scope = {
  workspaceId: 42,
  channelConnectionId: 12,
  bindingEpoch: 3,
  privacyEpoch: 7,
  userKey: USER_KEY,
  pageId: "page-1",
} as const;

describe("Messenger video provider artifact store", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REDIS_URL", "");
    isRedisEnabledMock.mockReturnValue(false);
    redisEvalMock.mockReset();
    resetMessengerVideoProviderArtifactStoreForTests();
  });

  afterEach(() => {
    resetMessengerVideoProviderArtifactStoreForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("keeps multiple provider jobs in the exact user privacy scope", async () => {
    await expect(
      registerMessengerVideoProviderArtifact(
        { provider: "openai", providerJobId: "video_1" },
        scope
      )
    ).resolves.toBe(true);
    await registerMessengerVideoProviderArtifact(
      { provider: "openai", providerJobId: "video_2" },
      scope
    );

    await expect(
      beginMessengerVideoProviderArtifactErasure(scope)
    ).resolves.toEqual(
      expect.arrayContaining([
        { provider: "openai", providerJobId: "video_1" },
        { provider: "openai", providerJobId: "video_2" },
      ])
    );
  });

  it("retains only failed cleanup work across erasure retries", async () => {
    const first = { provider: "openai", providerJobId: "video_1" } as const;
    const second = { provider: "openai", providerJobId: "video_2" } as const;
    await registerMessengerVideoProviderArtifact(first, scope);
    await registerMessengerVideoProviderArtifact(second, scope);
    await beginMessengerVideoProviderArtifactErasure(scope);
    await removeMessengerVideoProviderArtifact(first, scope);

    await expect(
      beginMessengerVideoProviderArtifactErasure(scope)
    ).resolves.toEqual([second]);
  });

  it("records a late provider job but rejects generation after erasure starts", async () => {
    await beginMessengerVideoProviderArtifactErasure(scope);
    const late = { provider: "openai", providerJobId: "video_late" } as const;

    await expect(
      registerMessengerVideoProviderArtifact(late, scope)
    ).resolves.toBe(false);
    await expect(
      beginMessengerVideoProviderArtifactErasure(scope)
    ).resolves.toEqual([late]);
  });

  it("does not transfer the tombstone to a later privacy epoch", async () => {
    await beginMessengerVideoProviderArtifactErasure(scope);

    await expect(
      registerMessengerVideoProviderArtifact(
        { provider: "openai", providerJobId: "video_new_epoch" },
        { ...scope, privacyEpoch: 8 }
      )
    ).resolves.toBe(true);
  });

  it("expires each provider job reference 31 days after its own registration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await registerMessengerVideoProviderArtifact(
      { provider: "openai", providerJobId: "video_old" },
      scope
    );

    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000 + 1);
    const recent = {
      provider: "openai",
      providerJobId: "video_recent",
    } as const;
    await registerMessengerVideoProviderArtifact(recent, scope);

    await expect(
      beginMessengerVideoProviderArtifactErasure(scope)
    ).resolves.toEqual([recent]);
  });

  it("rejects unallowlisted providers and malformed job identifiers", async () => {
    await expect(
      registerMessengerVideoProviderArtifact(
        { provider: "other", providerJobId: "video_1" },
        scope
      )
    ).rejects.toThrow("not allowlisted");
    await expect(
      registerMessengerVideoProviderArtifact(
        { provider: "openai", providerJobId: "video/id" },
        scope
      )
    ).rejects.toThrow("job id is invalid");
  });

  it("applies the 31-day retention to Redis indexes and erasure tombstones", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    redisEvalMock
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce([
        JSON.stringify({ provider: "openai", providerJobId: "video_redis" }),
      ]);

    await expect(
      registerMessengerVideoProviderArtifact(
        { provider: "openai", providerJobId: "video_redis" },
        scope
      )
    ).resolves.toBe(true);
    await expect(
      beginMessengerVideoProviderArtifactErasure(scope)
    ).resolves.toEqual([{ provider: "openai", providerJobId: "video_redis" }]);

    const registerCall = redisEvalMock.mock.calls[0];
    expect(registerCall?.[0]).toContain("expire");
    expect(registerCall?.[0]).toContain("redis.call('set', KEYS[3]");
    expect(registerCall).toContain(31 * 24 * 60 * 60);
    const erasureCall = redisEvalMock.mock.calls[1];
    expect(erasureCall?.[0]).toContain("'EX', ARGV[2]");
    expect(erasureCall).toContain(31 * 24 * 60 * 60);
  });
});
