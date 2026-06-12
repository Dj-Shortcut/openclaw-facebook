import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const updateScript = path.join(repoRoot, "scripts", "update-openclaw.mjs");
const validateScript = path.join(repoRoot, "scripts", "validate-openclaw-runtime.mjs");
const tempDirs = [];

function makeRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "deploy", "fly-gateway"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@dj-shortcut/facebook",
        version: "2026.6.5",
        devDependencies: {
          openclaw: "^2026.6.5",
        },
        openclaw: {
          build: {
            openclawVersion: "2026.6.5",
            pluginSdkVersion: "2026.6.5",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "manifest.test.ts"),
    'expect(pkg.openclaw?.build).toEqual({\n  openclawVersion: "2026.6.5",\n  pluginSdkVersion: "2026.6.5",\n});\n',
  );
  fs.writeFileSync(
    path.join(root, "deploy", "fly-gateway", "Dockerfile"),
    "ARG OPENCLAW_VERSION=2026.6.5\nFROM node:24-bookworm-slim\n",
  );
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenClaw update workflow tooling", () => {
  it("updates every authoritative version reference together", () => {
    const root = makeRepoFixture();

    const result = spawnSync(process.execPath, [updateScript, "2026.7.1"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.version).toBe("2026.7.1");
    expect(pkg.devDependencies.openclaw).toBe("^2026.7.1");
    expect(pkg.openclaw.build).toEqual({
      openclawVersion: "2026.7.1",
      pluginSdkVersion: "2026.7.1",
    });
    expect(fs.readFileSync(path.join(root, "manifest.test.ts"), "utf8")).toContain(
      'openclawVersion: "2026.7.1"',
    );
    expect(
      fs.readFileSync(path.join(root, "deploy", "fly-gateway", "Dockerfile"), "utf8"),
    ).toContain("ARG OPENCLAW_VERSION=2026.7.1");
  });

  it("rejects Dockerfiles that patch installed OpenClaw packages", () => {
    const root = makeRepoFixture();
    fs.writeFileSync(
      path.join(root, "deploy", "fly-gateway", "Dockerfile"),
      [
        "ARG OPENCLAW_VERSION=2026.6.5",
        "RUN node -e \"fs.writeFileSync('node_modules/openclaw/dist/server.impl.js', 'patched')\"",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [validateScript], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported runtime package patching");
  });
});
