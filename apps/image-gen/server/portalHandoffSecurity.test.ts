import { describe, expect, it } from "vitest";
import { isPortalHandoffTenantBoundaryReady } from "./_core/portalHandoffSecurity";

describe("portal handoff tenant boundary gate", () => {
  it("is enabled after Page/channel/workspace ownership enforcement", () => {
    expect(isPortalHandoffTenantBoundaryReady()).toBe(true);
  });
});
