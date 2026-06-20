import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateStoreMocks = vi.hoisted(() => ({
  decrementExpiringCounter: vi.fn(),
  deleteEphemeralKeyIfValue: vi.fn(),
  hasEphemeralKey: vi.fn(),
  incrementExpiringCounter: vi.fn(),
  isRedisStateStoreEnabled: vi.fn(),
  setEphemeralKey: vi.fn(),
  setEphemeralKeyIfAbsent: vi.fn(),
}));

describe("generationGuard", () => {
  let guard: typeof import("./_core/generationGuard");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./_core/stateStore", () => stateStoreMocks);
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.decrementExpiringCounter.mockResolvedValue(1);
    stateStoreMocks.incrementExpiringCounter.mockResolvedValue(1);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockResolvedValue(true);
    stateStoreMocks.deleteEphemeralKeyIfValue.mockResolvedValue(true);
    guard = await import("./_core/generationGuard");
  });

  afterEach(() => {
    delete process.env.MESSENGER_MAX_IMAGE_JOBS;
    delete process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS;
    delete process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP;
    delete process.env.MESSENGER_PSID_COOLDOWN_MS;
    delete process.env.MESSENGER_PSID_LOCK_TTL_MS;
    vi.restoreAllMocks();
    vi.doUnmock("./_core/stateStore");
    vi.clearAllMocks();
  });

  it("uses Redis-backed global slots when Redis state is enabled", async () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "2";
    process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS = "5000";
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(true);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockImplementation(
      async (key: string) => {
        if (key === "messenger:inflight:psid-1") {
          return true;
        }

        return key === "messenger:global-inflight:1";
      }
    );

    await expect(
      guard.runGuardedGeneration("psid-1", async () => "done")
    ).resolves.toBe("done");

    expect(stateStoreMocks.setEphemeralKeyIfAbsent).toHaveBeenCalledWith(
      "messenger:global-inflight:0",
      expect.any(String),
      5
    );
    expect(stateStoreMocks.setEphemeralKeyIfAbsent).toHaveBeenCalledWith(
      "messenger:global-inflight:1",
      expect.any(String),
      5
    );
    expect(stateStoreMocks.deleteEphemeralKeyIfValue).toHaveBeenCalledWith(
      "messenger:global-inflight:1",
      expect.any(String)
    );
  });

  it("skips distributed global slots in memory mode", async () => {
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockResolvedValue(true);

    await expect(
      guard.runGuardedGeneration("psid-2", async () => "done")
    ).resolves.toBe("done");

    expect(stateStoreMocks.setEphemeralKeyIfAbsent).not.toHaveBeenCalledWith(
      expect.stringContaining("messenger:global-inflight"),
      expect.any(String),
      expect.any(Number)
    );
  });

  it("reports Redis-backed global slot usage", async () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "3";
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(true);
    stateStoreMocks.hasEphemeralKey.mockImplementation(async (key: string) =>
      key === "messenger:global-inflight:0" ||
      key === "messenger:global-inflight:2"
    );

    await expect(guard.getMessengerGenerationGlobalLimitStats()).resolves.toEqual({
      redisBacked: true,
      max: 3,
      active: 2,
    });
  });

  it("reports configured max without active slots in memory mode", async () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "4";
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);

    await expect(guard.getMessengerGenerationGlobalLimitStats()).resolves.toEqual({
      redisBacked: false,
      max: 4,
      active: 0,
    });
  });

  it("reports startup config for the global generation limiter", () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "5";
    process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS = "45000";
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(true);

    expect(guard.getMessengerGenerationGlobalLimitConfig()).toEqual({
      redisBacked: true,
      max: 5,
      lockTtlMs: 45000,
    });
  });

  it("reports whether the daily image budget cap is enabled", () => {
    expect(guard.getMessengerDailyImageBudgetConfig()).toEqual({
      enabled: false,
      cap: null,
    });

    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "25";

    expect(guard.getMessengerDailyImageBudgetConfig()).toEqual({
      enabled: true,
      cap: 25,
    });
  });

  it("does not reserve daily image budget when no cap is configured", async () => {
    await expect(
      guard.assertMessengerDailyImageBudgetAvailable({ reqId: "req-no-cap" })
    ).resolves.toBeUndefined();

    expect(stateStoreMocks.incrementExpiringCounter).not.toHaveBeenCalled();
  });

  it("reserves budget in a UTC daily counter when a cap is configured", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "2";
    const now = new Date("2026-06-01T23:59:30.000Z");

    await expect(
      guard.assertMessengerDailyImageBudgetAvailable({ reqId: "req-budget", now })
    ).resolves.toBeUndefined();

    expect(stateStoreMocks.incrementExpiringCounter).toHaveBeenCalledWith(
      "messenger:daily-image-budget:2026-06-01",
      30
    );
  });

  it("throws when the configured daily image budget is exceeded", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";
    stateStoreMocks.incrementExpiringCounter.mockResolvedValue(2);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      guard.assertMessengerDailyImageBudgetAvailable({
        reqId: "req-over-budget",
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(guard.MessengerDailyImageBudgetExceededError);
    expect(stateStoreMocks.decrementExpiringCounter).toHaveBeenCalledWith(
      "messenger:daily-image-budget:2026-06-01"
    );
  });
});
