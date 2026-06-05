import { afterEach, describe, expect, it } from "vitest";

import {
  deleteMessengerGenerationCompletionsForUser,
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDelivered,
} from "./_core/messengerGenerationCompletion";
import { clearStateStore } from "./_core/stateStore";

describe("messengerGenerationCompletion", () => {
  afterEach(() => {
    clearStateStore();
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
