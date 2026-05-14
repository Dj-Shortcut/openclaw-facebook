import { describe, expect, it } from "vitest";
import { messengerStatusAdapter } from "./status.js";
import type { ResolvedMessengerAccount } from "./types.js";

describe("messengerStatusAdapter", () => {
  it("handles partially resolved legacy accounts without throwing", async () => {
    const snapshot = await messengerStatusAdapter.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        enabled: true,
        tokenSource: "none",
        config: {},
      } as ResolvedMessengerAccount,
      cfg: { channels: {} } as never,
    });

    expect(snapshot?.configured).toBe(false);
  });
});
