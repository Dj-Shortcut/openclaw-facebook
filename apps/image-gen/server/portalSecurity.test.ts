import { describe, expect, it } from "vitest";
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
});
