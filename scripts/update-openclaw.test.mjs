import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const updateScript = path.join(repoRoot, "scripts", "update-openclaw.mjs");
const validateScript = path.join(repoRoot, "scripts", "validate-openclaw-runtime.mjs");
const validateReleaseScript = path.join(
  repoRoot,
  "scripts",
  "validate-release-versions.mjs",
);
const tempDirs = [];

function makeRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "deploy", "fly-gateway"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps", "customer-app", "src-tauri"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@dj-shortcut/facebook",
        version: "2026.6.5",
        devDependencies: {
          openclaw: "^2026.6.5",
        },
        peerDependencies: {
          "unrelated-peer": "^1.2.3",
          openclaw: ">=2026.6.11",
        },
        openclaw: {
          compat: {
            minGatewayVersion: "2026.6.11",
          },
          build: {
            openclawVersion: "2026.6.5",
            pluginSdkVersion: "2026.6.5",
          },
          install: {
            minHostVersion: ">=2026.6.11",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "manifest.test.ts"),
    [
      'expect(pkg.openclaw?.build).toEqual({',
      '  openclawVersion: "2026.6.5",',
      '  pluginSdkVersion: "2026.6.5",',
      '  minGatewayVersion: "2026.6.11",',
      '  minHostVersion: ">=2026.6.11",',
      "});",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "deploy", "fly-gateway", "Dockerfile"),
    "ARG OPENCLAW_VERSION=2026.6.5\nFROM node:24-bookworm-slim\n",
  );
  fs.writeFileSync(
    path.join(root, "docs", "clawhub-listing.md"),
    [
      "- OpenClaw build tested with: `2026.6.5`",
      "- Plugin version: `2026.6.5`",
      "",
      "## Release Notes For 2026.6.5",
      "",
      "- Verified local package install from `dj-shortcut-facebook-2026.6.5.tgz`.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        version: "2026.6.5",
        packages: {
          "": {
            version: "2026.6.5",
            devDependencies: { openclaw: "^2026.6.5" },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      openclaw:",
      "        specifier: ^2026.6.5",
      "        version: 2026.6.5",
      "",
      "packages:",
      "",
      "  openclaw@2026.6.5:",
      "    resolution: {integrity: fixture}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "apps", "customer-app", "package.json"),
    '{"version":"1.2.3"}\n',
  );
  fs.writeFileSync(
    path.join(root, "apps", "customer-app", "src-tauri", "tauri.conf.json"),
    '{"version":"1.2.3"}\n',
  );
  fs.writeFileSync(
    path.join(root, "apps", "customer-app", "src-tauri", "Cargo.toml"),
    '[package]\nname = "fixture"\nversion = "1.2.3"\n',
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
    expect(pkg.peerDependencies["unrelated-peer"]).toBe("^1.2.3");
    expect(pkg.peerDependencies.openclaw).toBe(">=2026.6.11");
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
    const listing = fs.readFileSync(path.join(root, "docs", "clawhub-listing.md"), "utf8");
    expect(listing).toContain("OpenClaw build tested with: `2026.7.1`");
    expect(listing).toContain("Plugin version: `2026.7.1`");
    expect(listing).toContain("## Release Notes For 2026.7.1");
    expect(listing).toContain("dj-shortcut-facebook-2026.7.1.tgz");
  });

  it("allows the exact prerelease alongside supported stable hosts", () => {
    const root = makeRepoFixture();

    const result = spawnSync(process.execPath, [updateScript, "2026.7.2-beta.7"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.devDependencies.openclaw).toBe("2026.7.2-beta.7");
    expect(pkg.peerDependencies.openclaw).toBe(
      ">=2026.6.11 || 2026.7.2-beta.7",
    );
    expect(pkg.peerDependencies["unrelated-peer"]).toBe("^1.2.3");
    expect(pkg.openclaw.build).toEqual({
      openclawVersion: "2026.7.2-beta.7",
      pluginSdkVersion: "2026.7.2-beta.7",
    });
    expect(fs.readFileSync(path.join(root, "manifest.test.ts"), "utf8")).toContain(
      'pluginSdkVersion: "2026.7.2-beta.7"',
    );
    const listing = fs.readFileSync(path.join(root, "docs", "clawhub-listing.md"), "utf8");
    expect(listing).toContain(
      "- OpenClaw build tested with: `2026.7.2-beta.7`",
    );
    expect(listing).toContain("- Plugin version: `2026.7.2-beta.7`");
    expect(listing).toContain("## Release Notes For 2026.7.2-beta.7");
    expect(listing).toContain("dj-shortcut-facebook-2026.7.2-beta.7.tgz");
  });

  it("does not write any targets when a later replacement cannot be validated", () => {
    const root = makeRepoFixture();
    const listingPath = path.join(root, "docs", "clawhub-listing.md");
    fs.writeFileSync(
      listingPath,
      fs
        .readFileSync(listingPath, "utf8")
        .replace("dj-shortcut-facebook-2026.6.5.tgz", "fixture-package.tgz"),
    );
    const targetPaths = [
      path.join(root, "package.json"),
      path.join(root, "manifest.test.ts"),
      path.join(root, "deploy", "fly-gateway", "Dockerfile"),
      listingPath,
    ];
    const before = new Map(
      targetPaths.map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]),
    );

    const result = spawnSync(process.execPath, [updateScript, "2026.7.1"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not update ClawHub verified tarball version");
    for (const filePath of targetPaths) {
      expect(fs.readFileSync(filePath, "utf8")).toBe(before.get(filePath));
    }
  });

  it("does not let a secondary pnpm importer satisfy root lock checks", () => {
    const root = makeRepoFixture();
    fs.writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    devDependencies: {}",
        "",
        "  apps/spoof:",
        "    devDependencies:",
        "      openclaw:",
        "        specifier: ^2026.6.5",
        "        version: 2026.6.5",
        "",
        "packages:",
        "",
        "  openclaw@2026.6.5:",
        "    resolution: {integrity: fixture}",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [validateReleaseScript], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm-lock root OpenClaw specifier missing");
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
