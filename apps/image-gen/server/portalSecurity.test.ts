import { describe, expect, it } from "vitest";
import {
  consumeFacebookPage,
  startFacebookConnect,
  storeFacebookAuthorizationCode,
  storeFacebookPages,
  validateStoredFacebookState,
} from "./_core/facebookConnectStore";
import {
  assertWorkspaceMembership,
  createFacebookConnectState,
  validateFacebookConnectState,
} from "./_core/portalSecurity";

describe("portal security", () => {
  it("accepts matching workspace membership", () => {
    expect(() =>
      assertWorkspaceMembership(
        { workspaceId: 7, userId: 4 },
        { workspaceId: 7, userId: 4 }
      )
    ).not.toThrow();
  });

  it("rejects cross-workspace access", () => {
    expect(() =>
      assertWorkspaceMembership(
        { workspaceId: 8, userId: 4 },
        { workspaceId: 7, userId: 4 }
      )
    ).toThrow("workspace access denied");
  });

  it("validates facebook connect state for the same user and workspace", () => {
    const stored = createFacebookConnectState({
      workspaceId: 3,
      userId: 2,
      now: 1000,
    });

    expect(
      validateFacebookConnectState(stored, {
        state: stored.state,
        workspaceId: 3,
        userId: 2,
        now: 2000,
      })
    ).toEqual(stored);
  });

  it("rejects expired facebook connect state", () => {
    const stored = createFacebookConnectState({
      workspaceId: 3,
      userId: 2,
      now: 1000,
    });

    expect(() =>
      validateFacebookConnectState(stored, {
        state: stored.state,
        workspaceId: 3,
        userId: 2,
        now: 1000 + 10 * 60 * 1000 + 1,
      })
    ).toThrow("facebook connect state expired");
  });

  it("shares facebook connect state across start, callback code, and page selection", () => {
    const now = Date.now();
    const state = startFacebookConnect({
      workspaceId: 12,
      userId: 9,
      now,
    });

    expect(
      storeFacebookAuthorizationCode({
        state: state.state,
        code: "oauth-code",
      })
    ).toBe(true);
    expect(
      validateStoredFacebookState({
        state: state.state,
        workspaceId: 12,
        userId: 9,
        now: now + 1000,
      }).authorizationCode
    ).toBe("oauth-code");

    storeFacebookPages({
      state: state.state,
      pages: [
        {
          id: "page-1",
          name: "Customer Page",
          accessToken: "page-token",
          grantedScopes: [
            "pages_show_list",
            "pages_manage_metadata",
            "pages_messaging",
          ],
        },
      ],
    });

    expect(
      consumeFacebookPage({
        state: state.state,
        workspaceId: 12,
        userId: 9,
        pageId: "page-1",
      })
    ).toMatchObject({
      id: "page-1",
      name: "Customer Page",
      accessToken: "page-token",
    });
  });
});
