import { describe, expect, it } from "vitest";
import { isPortalHandoffTenantBoundaryReady } from "./_core/portalHandoffSecurity";

describe("portal handoff tenant boundary gate", () => {
  it("stays fail-closed until Page/channel/workspace ownership is enforced", () => {
    expect(isPortalHandoffTenantBoundaryReady()).toBe(false);
  });
});
