import { describe, expect, it } from "vitest";
import { messengerSetupWizard } from "./setup-surface.js";

describe("messengerSetupWizard", () => {
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
