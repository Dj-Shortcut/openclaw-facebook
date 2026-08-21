import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  storageDelete: vi.fn(async () => undefined),
}));

vi.mock("./_core/redis", () => ({
  isRedisEnabled: () => true,
  getRedisClient: async () => ({ eval: mocks.eval }),
}));
vi.mock("./storage", () => ({
  storageKeyFromPublicUrl: (url: string) =>
    `generated/${url.split("/").at(-1)}`,
  storageDelete: mocks.storageDelete,
}));

import { deleteMessengerGenerationCompletionsForUser } from "./_core/messengerGenerationCompletion";

describe("messenger completion bounded erasure", () => {
  beforeEach(() => {
    mocks.eval.mockReset();
    mocks.storageDelete.mockReset();
    mocks.storageDelete.mockResolvedValue(undefined);
  });

  it("follows a nonzero SSCAN cursor even when Redis returns an empty batch", async () => {
    let completionReads = 0;
    let objectReads = 0;
    const completion = JSON.stringify({
      reqId: "req-cursor",
      imageUrl: "https://assets.example/cursor.jpg",
      completedAt: 1,
      deliveryStatus: "pending",
      userKey: "privacy-user-cursor-123456",
      workspaceId: 91,
      channelConnectionId: 17,
      bindingEpoch: 3,
      privacyEpoch: 4,
      pageId: "page-cursor",
      expiresAt: Date.now() + 60_000,
    });
    mocks.eval.mockImplementation(async (script: string) => {
      if (script.includes("privacy index is inconsistent")) return 1;
      if (script.includes("redis.call('get', key) or ''")) {
        completionReads += 1;
        return completionReads === 1
          ? ["17", []]
          : ["0", ["completion-key", completion]];
      }
      if (script.includes("current ~= ARGV[index + 1]")) return 1;
      if (
        script.includes("local scan = redis.call('sscan', KEYS[1]") &&
        script.includes("redis.call('zscore', KEYS[2], objectKey)")
      ) {
        objectReads += 1;
        return objectReads === 1 ? ["23", []] : ["0", []];
      }
      if (script.includes("return redis.call('scard'")) return 0;
      if (script.includes("redis.call('zcard', KEYS[4])")) return 1;
      throw new Error("unexpected Redis script");
    });

    await expect(
      deleteMessengerGenerationCompletionsForUser(
        "privacy-user-cursor-123456",
        {
          workspaceId: 91,
          channelConnectionId: 17,
          bindingEpoch: 3,
          privacyEpoch: 4,
          userKey: "privacy-user-cursor-123456",
          pageId: "page-cursor",
        }
      )
    ).resolves.toBeUndefined();

    expect(completionReads).toBe(2);
    expect(objectReads).toBe(2);
    expect(mocks.storageDelete).toHaveBeenCalledOnce();
    expect(mocks.storageDelete).toHaveBeenCalledWith("generated/cursor.jpg");
  });
});
