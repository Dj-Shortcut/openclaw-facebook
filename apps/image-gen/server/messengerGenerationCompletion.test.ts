import { afterEach, describe, expect, it } from "vitest";

import {
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
        1_771_000_000_000
      )
    );

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-complete"))
    ).resolves.toEqual({
      reqId: "req-complete",
      imageUrl: "https://assets.example/generated/req-complete.jpg",
      completedAt: 1_771_000_000_000,
    });
  });

  it("returns null for unknown generation request ids", async () => {
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-missing"))
    ).resolves.toBeNull();
  });
});
