import { describe, expect, it } from "vitest";
import { hasMessengerConfiguredState } from "./configured-state.js";

describe("hasMessengerConfiguredState", () => {
  it("detects legacy Messenger env credentials from package-state params", () => {
    expect(
      hasMessengerConfiguredState({
        env: {
          MESSENGER_PAGE_ID: "page-1",
          MESSENGER_PAGE_ACCESS_TOKEN: "token-1",
          MESSENGER_APP_SECRET: "secret-1",
          MESSENGER_VERIFY_TOKEN: "verify-1",
        },
      }),
    ).toBe(true);
  });
});
