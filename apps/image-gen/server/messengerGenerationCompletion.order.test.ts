import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  eval: vi.fn(),
  registerOwnership: vi.fn(),
  storageDelete: vi.fn(),
}));

vi.mock("./_core/redis", () => ({
  isRedisEnabled: () => true,
  getRedisClient: async () => ({ eval: mocks.eval, srem: vi.fn() }),
}));
vi.mock("./_core/messengerPrivacyOwnershipHistory", () => ({
  registerMessengerPrivacyOwnership: mocks.registerOwnership,
}));
vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: vi.fn(async () => undefined),
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: vi.fn(async () => undefined),
}));
vi.mock("./storage", () => ({
  storageKeyFromPublicUrl: (url: string) =>
    `generated/${url.split("/").at(-1)}`,
  storageDelete: mocks.storageDelete,
}));

import { markMessengerGenerationCompleted } from "./_core/messengerGenerationCompletion";

describe("messenger completion ownership ordering", () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.eval.mockReset();
    mocks.registerOwnership.mockReset();
    mocks.storageDelete.mockReset();
    mocks.registerOwnership.mockImplementation(async () => {
      mocks.events.push("history");
    });
    mocks.eval.mockImplementation(async (script: string) => {
      if (script.includes("redis.call('sadd', KEYS[1], ARGV[1])")) {
        mocks.events.push("inventory");
        throw new Error("inventory store unavailable");
      }
      throw new Error("unexpected Redis script");
    });
    mocks.storageDelete.mockImplementation(async () => {
      mocks.events.push("delete");
    });
  });

  it("registers ownership first and never deletes without the delivered CAS", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "completion-order-user-123456",
      pageId: "whatsapp-phone-1",
      channel: "whatsapp" as const,
    };

    await expect(
      markMessengerGenerationCompleted(
        "req-order",
        "https://assets.example/order.jpg",
        fence.userKey,
        Date.now(),
        fence
      )
    ).rejects.toThrow("could not be scheduled");

    expect(mocks.events).toEqual(["history", "inventory"]);
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(mocks.registerOwnership).toHaveBeenCalledWith({
      pageId: fence.pageId,
      userKey: fence.userKey,
      workspaceId: fence.workspaceId,
      channelConnectionId: fence.channelConnectionId,
      bindingEpoch: fence.bindingEpoch,
      privacyEpoch: fence.privacyEpoch,
      channel: "whatsapp",
    });
  });
});
