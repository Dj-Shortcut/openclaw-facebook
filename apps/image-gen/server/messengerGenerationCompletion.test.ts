import { afterEach, describe, expect, it, vi } from "vitest";

const { assertPrivacyMock } = vi.hoisted(() => ({
  assertPrivacyMock: vi.fn(async () => undefined),
}));
const { storageDeleteMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: assertPrivacyMock,
}));
vi.mock("./storage", () => ({
  storageKeyFromPublicUrl: (url: string) =>
    `generated/${url.split("/").at(-1)}`,
  storageDelete: storageDeleteMock,
}));

import {
  deleteMessengerGenerationCompletionsForUser,
  getMessengerGenerationCompletion,
  isLegacyMessengerGenerationCompletionKey,
  markMessengerGenerationCompleted,
  markMessengerGenerationDelivered,
} from "./_core/messengerGenerationCompletion";
import { clearStateStore } from "./_core/stateStore";

describe("messengerGenerationCompletion", () => {
  afterEach(() => {
    clearStateStore();
    assertPrivacyMock.mockReset();
    assertPrivacyMock.mockResolvedValue(undefined);
    storageDeleteMock.mockReset();
    storageDeleteMock.mockResolvedValue(undefined);
  });

  it("accepts canonical nested user indexes during the broad readiness scan", () => {
    const completionScope = "messenger-generation-completion";
    const userIndexScope = "messenger-generation-completion:user";
    const canonicalTag = "{mgc:0123456789abcdef}";

    expect(
      isLegacyMessengerGenerationCompletionKey(
        completionScope,
        `${userIndexScope}:${canonicalTag}:index`
      )
    ).toBe(false);
    expect(
      isLegacyMessengerGenerationCompletionKey(
        userIndexScope,
        `${userIndexScope}:${canonicalTag}:index`
      )
    ).toBe(false);
    expect(
      isLegacyMessengerGenerationCompletionKey(
        completionScope,
        `${completionScope}:legacy-request`
      )
    ).toBe(true);
    expect(
      isLegacyMessengerGenerationCompletionKey(
        userIndexScope,
        `${userIndexScope}:legacy-user`
      )
    ).toBe(true);
  });

  it("binds completion reads and writes to the immutable privacy fence", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-fenced-123",
      pageId: "page-fenced",
    };
    await markMessengerGenerationCompleted(
      "req-fenced",
      "https://assets.example/generated/fenced.jpg",
      fence.userKey,
      1_771_000_000_000,
      fence
    );

    await expect(
      getMessengerGenerationCompletion("req-fenced", fence)
    ).resolves.toEqual(expect.objectContaining(fence));
    await expect(
      getMessengerGenerationCompletion("req-fenced", {
        ...fence,
        workspaceId: 43,
      })
    ).resolves.toBeNull();
  });

  it("scrubs a completion when erasure wins after the state write", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-erasure-race",
      pageId: "page-erasure-race",
    };
    assertPrivacyMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("privacy erased"));

    await expect(
      markMessengerGenerationCompleted(
        "req-erasure-race",
        "https://assets.example/generated/erasure-race.jpg",
        fence.userKey,
        1_771_000_000_000,
        fence
      )
    ).rejects.toThrow("privacy erased");
    await expect(
      getMessengerGenerationCompletion("req-erasure-race")
    ).resolves.toBeNull();
  });

  it("isolates the same request id across ownership and privacy scopes", async () => {
    const first = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-shared-req-a",
      pageId: "page-a",
    };
    const second = {
      ...first,
      channelConnectionId: 8,
      bindingEpoch: 4,
      privacyEpoch: 6,
      pageId: "page-b",
    };
    await markMessengerGenerationCompleted(
      "req-shared",
      "https://assets.example/generated/a.jpg",
      first.userKey,
      1_771_000_000_000,
      first
    );
    await markMessengerGenerationCompleted(
      "req-shared",
      "https://assets.example/generated/b.jpg",
      second.userKey,
      1_771_000_000_100,
      second
    );
    await expect(
      getMessengerGenerationCompletion("req-shared", first)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/generated/a.jpg",
    });
    await expect(
      getMessengerGenerationCompletion("req-shared", second)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/generated/b.jpg",
    });
  });

  it("never regresses delivered to pending or extends absolute retention", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-monotone",
      pageId: "page-monotone",
    };
    await markMessengerGenerationCompleted(
      "req-monotone",
      "https://assets.example/generated/monotone.jpg",
      fence.userKey,
      1_771_000_000_000,
      fence
    );
    await markMessengerGenerationDelivered(
      "req-monotone",
      "https://assets.example/generated/monotone.jpg",
      fence.userKey,
      1_771_000_000_100,
      fence
    );
    await markMessengerGenerationCompleted(
      "req-monotone",
      "https://assets.example/generated/replayed.jpg",
      fence.userKey,
      1_771_000_000_200,
      fence
    );
    await expect(
      getMessengerGenerationCompletion("req-monotone", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      imageUrl: "https://assets.example/generated/monotone.jpg",
      expiresAt: 1_771_604_800_000,
    });
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/replayed.jpg");
  });

  it("fails closed when delivery has no create-once completion", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-missing-delivery",
      pageId: "page-missing-delivery",
    };
    await expect(
      markMessengerGenerationDelivered(
        "req-missing-delivery",
        "https://assets.example/generated/missing.jpg",
        fence.userKey,
        1_771_000_000_000,
        fence
      )
    ).rejects.toThrow("Messenger completion missing");
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/missing.jpg");
  });

  it("stores completion markers by generation request id", async () => {
    await Promise.resolve(
      markMessengerGenerationCompleted(
        "req-complete",
        "https://assets.example/generated/req-complete.jpg",
        "user-key-1",
        1_771_000_000_000
      )
    );

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-complete"))
    ).resolves.toEqual({
      reqId: "req-complete",
      imageUrl: "https://assets.example/generated/req-complete.jpg",
      completedAt: 1_771_000_000_000,
      deliveryStatus: "pending",
      userKey: "user-key-1",
      expiresAt: 1_771_604_800_000,
    });
  });

  it("marks completed generations as delivered without changing completion time", async () => {
    await markMessengerGenerationCompleted(
      "req-delivered",
      "https://assets.example/generated/req-delivered.jpg",
      "user-key-delivered",
      1_771_000_000_000
    );

    await markMessengerGenerationDelivered(
      "req-delivered",
      "https://assets.example/generated/req-delivered.jpg",
      "user-key-delivered",
      1_771_000_000_100
    );

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-delivered"))
    ).resolves.toEqual({
      reqId: "req-delivered",
      imageUrl: "https://assets.example/generated/req-delivered.jpg",
      completedAt: 1_771_000_000_000,
      deliveryStatus: "delivered",
      deliveredAt: 1_771_000_000_100,
      userKey: "user-key-delivered",
      expiresAt: 1_771_604_800_000,
    });
  });

  it("returns null for unknown generation request ids", async () => {
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-missing"))
    ).resolves.toBeNull();
  });

  it("deletes completion markers for one user without touching other users", async () => {
    await markMessengerGenerationCompleted(
      "req-user-1",
      "https://assets.example/generated/user-1.jpg",
      "user-key-1",
      1_771_000_000_000
    );
    await markMessengerGenerationCompleted(
      "req-user-2",
      "https://assets.example/generated/user-2.jpg",
      "user-key-2",
      1_771_000_000_001
    );

    await deleteMessengerGenerationCompletionsForUser("user-key-1");

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-user-1"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-user-2"))
    ).resolves.toEqual(
      expect.objectContaining({
        reqId: "req-user-2",
        userKey: "user-key-2",
      })
    );
  });

  it("keeps concurrent completion ids in the per-user deletion index", async () => {
    await Promise.all([
      markMessengerGenerationCompleted(
        "req-concurrent-1",
        "https://assets.example/generated/concurrent-1.jpg",
        "user-key-concurrent",
        1_771_000_000_000
      ),
      markMessengerGenerationCompleted(
        "req-concurrent-2",
        "https://assets.example/generated/concurrent-2.jpg",
        "user-key-concurrent",
        1_771_000_000_001
      ),
      markMessengerGenerationCompleted(
        "req-concurrent-other-user",
        "https://assets.example/generated/concurrent-other-user.jpg",
        "user-key-other-concurrent",
        1_771_000_000_002
      ),
    ]);

    await deleteMessengerGenerationCompletionsForUser("user-key-concurrent");

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-concurrent-1"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-concurrent-2"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(
        getMessengerGenerationCompletion("req-concurrent-other-user")
      )
    ).resolves.toEqual(
      expect.objectContaining({
        reqId: "req-concurrent-other-user",
        userKey: "user-key-other-concurrent",
      })
    );
  });
});
