import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateStoreMocks = vi.hoisted(() => ({
  deleteEphemeralKeyIfValue: vi.fn(),
  hasEphemeralKey: vi.fn(),
  isRedisStateStoreEnabled: vi.fn(),
  setEphemeralKey: vi.fn(),
  setEphemeralKeyIfAbsent: vi.fn(),
}));

vi.mock("./_core/stateStore", () => stateStoreMocks);

import { runGuardedGeneration } from "./_core/generationGuard";

describe("generationGuard", () => {
  beforeEach(() => {
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockResolvedValue(true);
    stateStoreMocks.deleteEphemeralKeyIfValue.mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.MESSENGER_MAX_IMAGE_JOBS;
    delete process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS;
    delete process.env.MESSENGER_PSID_COOLDOWN_MS;
    delete process.env.MESSENGER_PSID_LOCK_TTL_MS;
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
      runGuardedGeneration("psid-1", async () => "done")
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
      runGuardedGeneration("psid-2", async () => "done")
    ).resolves.toBe("done");

    expect(stateStoreMocks.setEphemeralKeyIfAbsent).not.toHaveBeenCalledWith(
      expect.stringContaining("messenger:global-inflight"),
      expect.any(String),
      expect.any(Number)
    );
  });
});
