import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validatePackageManagerContract } from "./check-package-manager-contract.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "apps/image-gen/package.json",
  "apps/image-gen/pnpm-lock.yaml",
  "apps/customer-app/package.json",
  "apps/customer-app/pnpm-lock.yaml",
  "apps/customer-app/src-tauri/tauri.conf.json",
  "apps/image-gen/storage-proxy/package.json",
  "apps/image-gen/storage-proxy/pnpm-lock.yaml",
  ".github/workflows/customer-app-ci.yml",
  ".github/workflows/image-gen-ci.yml",
  ".github/workflows/image-gen-fallow.yml",
  ".github/workflows/main.yml",
  ".github/workflows/update-openclaw.yml",
  "README.md",
  "docs/monorepo.md",
  "deploy/fly-gateway/README.md",
  "apps/image-gen/README.md",
  "apps/image-gen/scripts/run-fallow-report.mjs",
];
const tempDirs = [];

function makeFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "package-manager-contract-"));
  tempDirs.push(fixture);
  for (const relativePath of requiredFiles) {
    const destination = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relativePath), destination);
  }
  return fixture;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("package-manager contract", () => {
  it("accepts the repository package-manager boundaries", () => {
    expect(validatePackageManagerContract(repoRoot)).toEqual([]);
  });

  it("reports a stale subapp pin with its package path", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "apps/customer-app/package.json");
    const appPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    appPackage.packageManager = "pnpm@10.4.1";
    fs.writeFileSync(packagePath, `${JSON.stringify(appPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "apps/customer-app/package.json: packageManager must be pnpm@10.28.1",
    );
  });

  it("rejects combined production deploy orchestration", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "package.json");
    const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    rootPackage.scripts.deploy = "npm run deploy:image-gen && npm run deploy:gateway";
    fs.writeFileSync(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "package.json: combined root deploy orchestration is not allowed",
    );
  });

  it("rejects a non-canonical app-specific deploy command", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "package.json");
    const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    rootPackage.scripts["deploy:image-gen"] = "fly deploy --config apps/image-gen/fly.toml";
    fs.writeFileSync(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "package.json: deploy:image-gen must use the canonical app-specific command",
    );
  });

  it("does not accept unrelated version text as a pnpm setup pin", () => {
    const fixture = makeFixture();
    const workflowPath = path.join(fixture, ".github/workflows/customer-app-ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8")
      .replaceAll("version: 10.28.1", "version: 10.4.1")
      .concat("\n# unrelated versions\nversion: 10.28.1\nversion: 10.28.1\n");
    fs.writeFileSync(workflowPath, workflow);

    expect(validatePackageManagerContract(fixture)).toContain(
      ".github/workflows/customer-app-ci.yml: both pnpm setup steps must use version 10.28.1",
    );
  });
});
