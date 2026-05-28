import { afterEach, describe, expect, it } from "vitest";

import {
  deleteMessengerGenerationCompletionsForUser,
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
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
      userKey: "user-key-1",
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
    ]);

    await deleteMessengerGenerationCompletionsForUser("user-key-concurrent");

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-concurrent-1"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-concurrent-2"))
    ).resolves.toBeNull();
  });
});
