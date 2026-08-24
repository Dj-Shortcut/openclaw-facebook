import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "..");

describe("Facebook connect storage rollout contract", () => {
  it("keeps the first dual-reader runtime deploy on legacy-compatible writes", () => {
    const flyConfig = readFileSync(path.join(appRoot, "fly.toml"), "utf8");
    const assignments = flyConfig.match(
      /^\s*FACEBOOK_CONNECT_STORAGE_MODE\s*=\s*"[^"]+"\s*$/gm
    );

    expect(assignments).toEqual([
      '  FACEBOOK_CONNECT_STORAGE_MODE = "legacy_compat"',
    ]);
  });

  it("documents the ordered config-only transitions and TTL fence", () => {
    const runbook = readFileSync(
      path.resolve(
        appRoot,
        "../..",
        "docs/operations/facebook-connect-storage-rollout.md"
      ),
      "utf8"
    );
    const firstPhase = runbook.indexOf("2. Deploy");
    const secondPhase = runbook.indexOf("3. Prove");
    const thirdPhase = runbook.indexOf("4. Wait more than 600 seconds");

    expect(firstPhase).toBeGreaterThan(0);
    expect(secondPhase).toBeGreaterThan(firstPhase);
    expect(thirdPhase).toBeGreaterThan(secondPhase);
    expect(runbook).toContain(
      "Never deploy the first dual-reader runtime and `sealed_compat` together."
    );
    expect(runbook).toContain("never roll back to a pre-dual-reader image");
  });
});
