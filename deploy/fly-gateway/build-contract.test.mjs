import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("Fly gateway build provenance", () => {
  it("builds the current plugin source with the repository-pinned runtime", () => {
    const fly = fs.readFileSync(path.join(root, "fly.toml"), "utf8");
    const dockerfile = fs.readFileSync(
      path.join(root, "deploy/fly-gateway/Dockerfile"),
      "utf8"
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8")
    );

    expect(fly).toContain('dockerfile = "deploy/fly-gateway/Dockerfile"');
    expect(fly).not.toContain("route-guard-hotfix");
    expect(dockerfile).toContain(`ARG OPENCLAW_VERSION=${pkg.version}`);
    expect(dockerfile).toContain("COPY src ./src");
    expect(dockerfile).toContain("COPY index.ts api.ts channel-plugin-api.ts");
    expect(dockerfile).toContain("validate-openclaw-runtime.mjs /app --gateway");
    expect(dockerfile).toContain(
      'io.leaderbot.facebook.plugin.source="workspace-build"'
    );
  });
});
