#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_NPM_RANGE = ">=11.12.1";
const SUBAPP_PNPM_VERSION = "pnpm@10.28.1";
const SUBAPPS = [
  "apps/image-gen",
  "apps/customer-app",
  "apps/image-gen/storage-proxy",
];

function readJson(repoRoot, relativePath, failures) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: required file is missing`);
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch {
    failures.push(`${relativePath}: file must contain valid JSON`);
    return undefined;
  }
}

function requireFile(repoRoot, relativePath, failures) {
  if (!fs.existsSync(path.join(repoRoot, relativePath))) {
    failures.push(`${relativePath}: required file is missing`);
  }
}

function pnpmSetupVersions(source) {
  const lines = source.split(/\r?\n/);
  const versions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const usesMatch = /^(\s*)uses:\s*pnpm\/action-setup@/.exec(lines[index]);
    if (!usesMatch) continue;
    const stepIndent = usesMatch[1].length;
    let insideWith = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      const nonWhitespace = line.search(/\S/);
      if (
        nonWhitespace >= 0 &&
        nonWhitespace <= stepIndent &&
        /^\s*-\s/.test(line)
      ) {
        break;
      }
      if (nonWhitespace === stepIndent && /^\s*with:\s*$/.test(line)) {
        insideWith = true;
        continue;
      }
      if (insideWith && nonWhitespace >= 0 && nonWhitespace <= stepIndent) {
        insideWith = false;
      }
      const versionMatch = insideWith
        ? /^\s*version:\s*([^\s#]+)/.exec(line)
        : null;
      if (versionMatch && nonWhitespace > stepIndent) {
        versions.push(versionMatch[1]);
        break;
      }
    }
  }
  return versions;
}

function workflowRunsForAllPullRequestPaths(source) {
  const lines = source.split(/\r?\n/);
  const triggerIndex = lines.findIndex((line) =>
    /^  pull_request:\s*(?:\{\})?\s*$/.test(line),
  );
  if (triggerIndex < 0) return false;
  for (const line of lines.slice(triggerIndex + 1)) {
    if (/^\S/.test(line) || /^  \S/.test(line)) break;
    if (/^    paths(?:-ignore)?:\s*$/.test(line)) return false;
  }
  return true;
}

export function validatePackageManagerContract(repoRoot = process.cwd()) {
  const failures = [];
  const rootPackage = readJson(repoRoot, "package.json", failures);
  if (rootPackage) {
    if (rootPackage.engines?.npm !== ROOT_NPM_RANGE) {
      failures.push(`package.json: engines.npm must be ${ROOT_NPM_RANGE}`);
    }
    if (rootPackage.packageManager !== undefined) {
      failures.push(
        "package.json: root packageManager must stay unset so the pnpm compatibility lock can be regenerated",
      );
    }
    if (rootPackage.scripts?.deploy !== undefined) {
      failures.push(
        "package.json: combined root deploy orchestration is not allowed",
      );
    }
    const packagedFiles = rootPackage.files ?? [];
    const requiredPluginDocs = [
      "docs/clawhub-listing.md",
      "docs/clawhub.md",
      "docs/facebook-complete-tutorial.md",
      "docs/openclaw-update.md",
      "docs/operator-prompt-routing.md",
      "docs/setup.md",
    ];
    if (
      packagedFiles.includes("docs") ||
      requiredPluginDocs.some((file) => !packagedFiles.includes(file))
    ) {
      failures.push(
        "package.json: OpenClaw package must include only the scoped plugin documentation",
      );
    }
    for (const [scriptName, expectedCommand] of Object.entries({
      "deploy:gateway":
        'test -n "$FLY_GATEWAY_REVIEWED_IMAGE" && node scripts/validate-production-deployment.mjs --validate-target-enabled gateway && node scripts/validate-production-deployment.mjs --validate-rollback-image gateway "$FLY_GATEWAY_REVIEWED_IMAGE" && fly deploy --config fly.toml --strategy rolling --image "$FLY_GATEWAY_REVIEWED_IMAGE"',
      "deploy:image-gen":
        'test -n "$FLY_IMAGE_GEN_REVIEWED_IMAGE" && node scripts/validate-production-deployment.mjs --validate-target-enabled image-gen && node scripts/validate-production-deployment.mjs --validate-rollback-image image-gen "$FLY_IMAGE_GEN_REVIEWED_IMAGE" && cd apps/image-gen && fly deploy --config fly.toml --strategy rolling --image "$FLY_IMAGE_GEN_REVIEWED_IMAGE"',
      "deploy:storage-proxy":
        'test -n "$FLY_STORAGE_PROXY_REVIEWED_IMAGE" && node scripts/validate-production-deployment.mjs --validate-target-enabled storage-proxy && node scripts/validate-production-deployment.mjs --validate-rollback-image storage-proxy "$FLY_STORAGE_PROXY_REVIEWED_IMAGE" && cd apps/image-gen/storage-proxy && fly deploy --config fly.toml --strategy rolling --image "$FLY_STORAGE_PROXY_REVIEWED_IMAGE"',
    })) {
      if (rootPackage.scripts?.[scriptName] !== expectedCommand) {
        failures.push(
          `package.json: ${scriptName} must use the canonical app-specific command`,
        );
      }
    }
    if (
      rootPackage.scripts?.["check:package-managers"] !==
      "node scripts/check-package-manager-contract.mjs"
    ) {
      failures.push(
        "package.json: check:package-managers must run the contract guard",
      );
    }
  }

  requireFile(repoRoot, "package-lock.json", failures);
  requireFile(repoRoot, "pnpm-lock.yaml", failures);
  if (fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"))) {
    failures.push(
      "pnpm-workspace.yaml: root pnpm workspace is not allowed; subapps are isolated",
    );
  }

  for (const subapp of SUBAPPS) {
    const packagePath = `${subapp}/package.json`;
    const appPackage = readJson(repoRoot, packagePath, failures);
    if (appPackage?.packageManager !== SUBAPP_PNPM_VERSION) {
      failures.push(
        `${packagePath}: packageManager must be ${SUBAPP_PNPM_VERSION}`,
      );
    }
    requireFile(repoRoot, `${subapp}/pnpm-lock.yaml`, failures);
    if (fs.existsSync(path.join(repoRoot, subapp, "package-lock.json"))) {
      failures.push(
        `${subapp}/package-lock.json: npm lockfiles are not allowed in pnpm subapps`,
      );
    }
    for (const [scriptName, command] of Object.entries(
      appPackage?.scripts ?? {},
    )) {
      if (/\b(?:npm|npx)\s/.test(String(command))) {
        failures.push(
          `${packagePath}: script ${scriptName} must use pnpm inside the subapp`,
        );
      }
    }
  }
  requireFile(
    repoRoot,
    "apps/image-gen/storage-proxy/pnpm-workspace.yaml",
    failures,
  );

  const customerWorkflowPath = ".github/workflows/customer-app-ci.yml";
  const customerWorkflow = path.join(repoRoot, customerWorkflowPath);
  if (!fs.existsSync(customerWorkflow)) {
    failures.push(`${customerWorkflowPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(customerWorkflow, "utf8");
    const versions = pnpmSetupVersions(source);
    if (
      versions.length !== 2 ||
      versions.some((version) => version !== "10.28.1")
    ) {
      failures.push(
        `${customerWorkflowPath}: both pnpm setup steps must use version 10.28.1`,
      );
    }
  }

  const imageWorkflowPath = ".github/workflows/image-gen-ci.yml";
  const imageWorkflow = path.join(repoRoot, imageWorkflowPath);
  if (!fs.existsSync(imageWorkflow)) {
    failures.push(`${imageWorkflowPath}: required file is missing`);
  } else {
    const versions = pnpmSetupVersions(fs.readFileSync(imageWorkflow, "utf8"));
    if (versions.length !== 1 || versions[0] !== "10.28.1") {
      failures.push(
        `${imageWorkflowPath}: pnpm setup must use version 10.28.1`,
      );
    }
  }

  const fallowWorkflowPath = ".github/workflows/image-gen-fallow.yml";
  const fallowWorkflow = path.join(repoRoot, fallowWorkflowPath);
  if (!fs.existsSync(fallowWorkflow)) {
    failures.push(`${fallowWorkflowPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(fallowWorkflow, "utf8");
    const versions = pnpmSetupVersions(source);
    if (versions.length !== 1 || versions[0] !== "10.28.1") {
      failures.push(
        `${fallowWorkflowPath}: pnpm setup must use version 10.28.1`,
      );
    }
    if (
      !/uses:\s*actions\/setup-node@[a-f0-9]{40}[\s\S]*?node-version:\s*24\b/.test(
        source,
      )
    ) {
      failures.push(`${fallowWorkflowPath}: must set up Node 24`);
    }
    for (const command of [
      "run: pnpm run fallow:report",
      "run: pnpm run fallow:report:production",
    ]) {
      if (!source.includes(command)) {
        failures.push(
          `${fallowWorkflowPath}: image-gen Fallow steps must use pnpm`,
        );
        break;
      }
    }
  }

  const clawhubWorkflowPath = ".github/workflows/clawhub-plugin-publish.yml";
  const clawhubWorkflow = path.join(repoRoot, clawhubWorkflowPath);
  if (!fs.existsSync(clawhubWorkflow)) {
    failures.push(`${clawhubWorkflowPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(clawhubWorkflow, "utf8");
    if (
      !source.includes(
        "source: ${{ github.event_name == 'pull_request' && format('{0}@{1}', github.event.pull_request.head.repo.full_name, github.event.pull_request.head.sha) || format('{0}@{1}', github.repository, github.sha) }}",
      )
    ) {
      failures.push(
        `${clawhubWorkflowPath}: dry-run source must bind the exact pull-request head commit`,
      );
    }
    for (const forbiddenPath of [
      '      - "docs/**"',
      '      - "scripts/**"',
      '      - "deploy/fly-gateway/**"',
    ]) {
      if (source.includes(forbiddenPath)) {
        failures.push(
          `${clawhubWorkflowPath}: ClawHub CI must not run for unrelated product paths`,
        );
        break;
      }
    }
    for (const required of [
      "run: npm run test:plugin",
      "TEST_MESSENGER_REDIS_URL: redis://127.0.0.1:6379",
      "run: npm audit --audit-level=moderate",
    ]) {
      if (!source.includes(required)) {
        failures.push(
          `${clawhubWorkflowPath}: must own the scoped plugin validation and package audit`,
        );
        break;
      }
    }
    if (
      !source.includes("  push:\n    branches: [main]\n    paths:\n") ||
      !source.includes('    tags:\n      - "v*"') ||
      !source.includes(
        "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      )
    ) {
      failures.push(
        `${clawhubWorkflowPath}: must validate plugin changes after path-scoped main pushes without publishing them`,
      );
    }
  }

  const legacyGatewayWorkflowPath = ".github/workflows/legacy-gateway-ci.yml";
  const legacyGatewayWorkflow = path.join(repoRoot, legacyGatewayWorkflowPath);
  if (!fs.existsSync(legacyGatewayWorkflow)) {
    failures.push(`${legacyGatewayWorkflowPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(legacyGatewayWorkflow, "utf8");
    const missingSharedInput = [
      "package.json",
      "package-lock.json",
      "scripts/run-vitest.mjs",
      "vitest.config.mjs",
      "vitest.node-polyfill.mjs",
    ].some(
      (input) =>
        source.split(`      - "${input}"`).length - 1 !== 2,
    );
    if (missingSharedInput) {
      failures.push(
        `${legacyGatewayWorkflowPath}: pull requests and main pushes must include every shared root test input`,
      );
    }
  }

  const tauriConfigPath = "apps/customer-app/src-tauri/tauri.conf.json";
  const tauriConfig = readJson(repoRoot, tauriConfigPath, failures);
  if (
    tauriConfig &&
    (tauriConfig.build?.beforeDevCommand !== "pnpm run dev" ||
      tauriConfig.build?.beforeBuildCommand !== "pnpm run build")
  ) {
    failures.push(`${tauriConfigPath}: Tauri hooks must use pnpm`);
  }

  for (const docsPath of [
    "README.md",
    "docs/monorepo.md",
    "deploy/fly-gateway/README.md",
    "apps/image-gen/README.md",
  ]) {
    const absolutePath = path.join(repoRoot, docsPath);
    if (!fs.existsSync(absolutePath)) {
      failures.push(`${docsPath}: required file is missing`);
    } else {
      const source = fs.readFileSync(absolutePath, "utf8");
      if (
        /pnpm run (?:deploy(?=\s|$)|deploy:image-gen\b|deploy:gateway\b|gateway:deploy\b|image-gen:deploy\b)/m.test(
          source,
        )
      ) {
        failures.push(`${docsPath}: root deploy examples must use npm`);
      }
      if (
        docsPath === "apps/image-gen/README.md" &&
        /\bnpm run\b/.test(source)
      ) {
        failures.push(`${docsPath}: image-gen commands must use pnpm`);
      }
    }
  }

  const fallowRunnerPath = "apps/image-gen/scripts/run-fallow-report.mjs";
  const fallowRunner = path.join(repoRoot, fallowRunnerPath);
  if (!fs.existsSync(fallowRunner)) {
    failures.push(`${fallowRunnerPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(fallowRunner, "utf8");
    if (/\bnpx(?:\.cmd)?\b/.test(source)) {
      failures.push(
        `${fallowRunnerPath}: image-gen tooling must invoke pnpm, not npx`,
      );
    }
    if (!source.includes('"--reporter=silent"')) {
      failures.push(
        `${fallowRunnerPath}: pnpm dlx must keep management output off JSON stdout`,
      );
    }
  }

  const mainWorkflowPath = ".github/workflows/main.yml";
  const mainWorkflow = path.join(repoRoot, mainWorkflowPath);
  if (!fs.existsSync(mainWorkflow)) {
    failures.push(`${mainWorkflowPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(mainWorkflow, "utf8");
    if (
      !/run:\s*node scripts\/check-package-manager-contract\.mjs\b/.test(source)
    ) {
      failures.push(
        `${mainWorkflowPath}: must run the package-manager contract guard`,
      );
    }
    if (
      !source.includes("run: npm run test:production-contracts") ||
      source.includes("run: npm run test:plugin") ||
      source.includes("run: npm run openclaw:validate") ||
      source.includes("run: npm run pack:dry")
    ) {
      failures.push(
        `${mainWorkflowPath}: source CI must run product contracts without duplicating plugin packaging`,
      );
    }
    if (!workflowRunsForAllPullRequestPaths(source)) {
      for (const trigger of [
        "pnpm-lock.yaml",
        "apps/customer-app/pnpm-lock.yaml",
        "apps/image-gen/pnpm-lock.yaml",
        "apps/image-gen/storage-proxy/pnpm-lock.yaml",
        "apps/image-gen/storage-proxy/pnpm-workspace.yaml",
        "apps/**/package-lock.json",
        ".github/workflows/image-gen-fallow.yml",
        "apps/image-gen/README.md",
        "apps/image-gen/scripts/run-fallow-report.mjs",
        ".github/workflows/update-openclaw.yml",
      ]) {
        if (!source.includes(`- "${trigger}"`)) {
          failures.push(`${mainWorkflowPath}: paths must include ${trigger}`);
        }
      }
    }
  }

  const updateWorkflowPath = ".github/workflows/update-openclaw.yml";
  const updateWorkflow = path.join(repoRoot, updateWorkflowPath);
  if (!fs.existsSync(updateWorkflow)) {
    failures.push(`${updateWorkflowPath}: required file is missing`);
  } else {
    const source = fs.readFileSync(updateWorkflow, "utf8");
    const versions = pnpmSetupVersions(source);
    if (versions.length !== 1 || versions[0] !== "10.28.1") {
      failures.push(
        `${updateWorkflowPath}: compatibility lock must use pnpm 10.28.1`,
      );
    }
    if (
      !source.includes("npm install --package-lock-only") ||
      !source.includes("pnpm install --lockfile-only")
    ) {
      failures.push(
        `${updateWorkflowPath}: must regenerate both root compatibility locks`,
      );
    }
  }

  return failures;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const failures = validatePackageManagerContract();
  for (const failure of failures) console.error(`error: ${failure}`);
  if (failures.length > 0) {
    console.error(
      `\nPackage-manager contract failed with ${failures.length} error(s).`,
    );
    process.exit(1);
  }
  console.log("Package-manager contract passed.");
}
