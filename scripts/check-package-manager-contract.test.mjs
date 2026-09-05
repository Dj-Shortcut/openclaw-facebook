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
  "apps/image-gen/storage-proxy/package.json",
  "apps/image-gen/storage-proxy/pnpm-lock.yaml",
  "apps/image-gen/storage-proxy/pnpm-workspace.yaml",
  ".github/workflows/image-gen-ci.yml",
  ".github/workflows/image-gen-fallow.yml",
  ".github/workflows/clawhub-plugin-publish.yml",
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
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "package-manager-contract-"),
  );
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

  it("requires the storage-proxy workspace policy", () => {
    const fixture = makeFixture();
    fs.rmSync(
      path.join(fixture, "apps/image-gen/storage-proxy/pnpm-workspace.yaml"),
    );

    expect(validatePackageManagerContract(fixture)).toContain(
      "apps/image-gen/storage-proxy/pnpm-workspace.yaml: required file is missing",
    );
  });

  it("rejects combined production deploy orchestration", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "package.json");
    const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    rootPackage.scripts.deploy =
      "npm run deploy:image-gen && npm run deploy:gateway";
    fs.writeFileSync(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "package.json: combined root deploy orchestration is not allowed",
    );
  });

  it("keeps Leaderbot product docs out of the OpenClaw package", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "package.json");
    const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    rootPackage.files = rootPackage.files
      .filter((file) => !file.startsWith("docs/"))
      .concat("docs");
    fs.writeFileSync(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "package.json: OpenClaw package must include only the scoped plugin documentation",
    );
  });

  it("rejects a non-canonical app-specific deploy command", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "package.json");
    const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    rootPackage.scripts["deploy:image-gen"] =
      "fly deploy --config apps/image-gen/fly.toml";
    fs.writeFileSync(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "package.json: deploy:image-gen must use the canonical app-specific command",
    );
  });

  it("rejects a gateway deploy command that can build from source", () => {
    const fixture = makeFixture();
    const packagePath = path.join(fixture, "package.json");
    const rootPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    rootPackage.scripts["deploy:gateway"] =
      "node scripts/validate-production-deployment.mjs --validate-target-enabled gateway && fly deploy --config fly.toml --strategy rolling";
    fs.writeFileSync(packagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    expect(validatePackageManagerContract(fixture)).toContain(
      "package.json: deploy:gateway must use the canonical app-specific command",
    );
  });

  it("rejects a filtered root CI trigger that omits package-manager inputs", () => {
    const fixture = makeFixture();
    const workflowPath = path.join(fixture, ".github/workflows/main.yml");
    const workflow = fs
      .readFileSync(workflowPath, "utf8")
      .replace(
        "  pull_request:\n",
        '  pull_request:\n    paths:\n      - "docs/**"\n',
      );
    fs.writeFileSync(workflowPath, workflow);

    expect(validatePackageManagerContract(fixture)).toContain(
      ".github/workflows/main.yml: paths must include pnpm-lock.yaml",
    );
  });

  it("requires ClawHub dry-runs to use the exact pull-request head", () => {
    const fixture = makeFixture();
    const workflowPath = path.join(
      fixture,
      ".github/workflows/clawhub-plugin-publish.yml",
    );
    const workflow = fs
      .readFileSync(workflowPath, "utf8")
      .replace(/^\s+source:.*\n/m, "");
    fs.writeFileSync(workflowPath, workflow);

    expect(validatePackageManagerContract(fixture)).toContain(
      ".github/workflows/clawhub-plugin-publish.yml: dry-run source must bind the exact pull-request head commit",
    );
  });

  it("rejects broad product paths in ClawHub plugin CI", () => {
    const fixture = makeFixture();
    const workflowPath = path.join(
      fixture,
      ".github/workflows/clawhub-plugin-publish.yml",
    );
    const workflow = fs
      .readFileSync(workflowPath, "utf8")
      .replace('      - "docs/clawhub.md"\n', '      - "docs/**"\n');
    fs.writeFileSync(workflowPath, workflow);

    expect(validatePackageManagerContract(fixture)).toContain(
      ".github/workflows/clawhub-plugin-publish.yml: ClawHub CI must not run for unrelated product paths",
    );
  });

  it("requires plugin validation after path-scoped main pushes", () => {
    const fixture = makeFixture();
    const workflowPath = path.join(
      fixture,
      ".github/workflows/clawhub-plugin-publish.yml",
    );
    const workflow = fs
      .readFileSync(workflowPath, "utf8")
      .replace("    branches: [main]\n", "");
    fs.writeFileSync(workflowPath, workflow);

    expect(validatePackageManagerContract(fixture)).toContain(
      ".github/workflows/clawhub-plugin-publish.yml: must validate plugin changes after path-scoped main pushes without publishing them",
    );
  });

  it("keeps plugin packaging out of product contract CI", () => {
    const fixture = makeFixture();
    const workflowPath = path.join(fixture, ".github/workflows/main.yml");
    const workflow = `${fs.readFileSync(workflowPath, "utf8")}\n      - name: Duplicate plugin validation\n        run: npm run openclaw:validate\n`;
    fs.writeFileSync(workflowPath, workflow);

    expect(validatePackageManagerContract(fixture)).toContain(
      ".github/workflows/main.yml: source CI must run product contracts without duplicating plugin packaging",
    );
  });
});
