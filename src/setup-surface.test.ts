import { describe, expect, it } from "vitest";
import { messengerSetupWizard } from "./setup-surface.js";

describe("messengerSetupWizard", () => {
  it("adds wildcard allowFrom when switching to open public DM access", () => {
    const cfg = {
      channels: {
        facebook: {
          dmPolicy: "pairing",
        },
      },
    };

    const dmPolicy = messengerSetupWizard.dmPolicy;
    if (!dmPolicy) {
      throw new Error("Messenger setup wizard must expose a DM policy controller.");
    }
    const next = dmPolicy.setPolicy(cfg as never, "open");
    const facebookConfig = next.channels?.facebook as
      | { dmPolicy?: string; allowFrom?: string[] }
      | undefined;

    expect(facebookConfig?.dmPolicy).toBe("open");
    expect(facebookConfig?.allowFrom).toEqual(["*"]);
  });

  it("removes wildcard allowFrom when switching from open to allowlist", () => {
    const cfg = {
      channels: {
        facebook: {
          dmPolicy: "open",
          allowFrom: ["*", "1234567890"],
        },
      },
    };

    const dmPolicy = messengerSetupWizard.dmPolicy;
    if (!dmPolicy) {
      throw new Error("Messenger setup wizard must expose a DM policy controller.");
    }
    const next = dmPolicy.setPolicy(cfg as never, "allowlist");
    const facebookConfig = next.channels?.facebook as
      | { dmPolicy?: string; allowFrom?: string[] }
      | undefined;

    expect(facebookConfig?.dmPolicy).toBe("allowlist");
    expect(facebookConfig?.allowFrom).toEqual(["1234567890"]);
  });
});
