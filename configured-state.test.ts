import { describe, expect, it } from "vitest";
import { hasFacebookConfiguredState, hasMessengerConfiguredState } from "./configured-state.js";

describe("hasFacebookConfiguredState", () => {
  it("detects canonical Facebook env credentials from package-state params", () => {
    expect(
      hasFacebookConfiguredState({
        env: {
          FACEBOOK_PAGE_ID: "page-1",
          FACEBOOK_PAGE_ACCESS_TOKEN: "token-1",
          FACEBOOK_APP_SECRET: "secret-1",
          FACEBOOK_VERIFY_TOKEN: "verify-1",
        },
      }),
    ).toBe(true);
  });

  it("detects legacy Messenger env credentials from package-state params", () => {
    expect(
      hasFacebookConfiguredState({
        env: {
          MESSENGER_PAGE_ID: "page-1",
          MESSENGER_PAGE_ACCESS_TOKEN: "token-1",
          MESSENGER_APP_SECRET: "secret-1",
          MESSENGER_VERIFY_TOKEN: "verify-1",
        },
      }),
    ).toBe(true);
  });

  it("keeps the legacy configured-state export as a compatibility alias", () => {
    expect(
      hasMessengerConfiguredState({
        env: {
          FACEBOOK_PAGE_ID: "page-1",
          FACEBOOK_PAGE_ACCESS_TOKEN: "token-1",
          FACEBOOK_APP_SECRET: "secret-1",
          FACEBOOK_VERIFY_TOKEN: "verify-1",
        },
      }),
    ).toBe(true);
  });
});
