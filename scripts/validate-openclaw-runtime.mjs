#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const gatewayMode = args.includes("--gateway");
const rootArg = args.find((arg) => !arg.startsWith("--"));
const root = rootArg ? path.resolve(rootArg) : process.cwd();
const requireFromRoot = createRequire(path.join(root, "package.json"));
const primaryTemplateNames = ["HEARTBEAT.md"];
const searchableTemplateNames = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolvePackageJson(packageName, { required = true } = {}) {
  const directPackageJsonPath = path.join(root, "node_modules", ...packageName.split("/"), "package.json");
  if (fs.existsSync(directPackageJsonPath)) {
    return directPackageJsonPath;
  }

  try {
    return requireFromRoot.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (!required) {
      return null;
    }
    throw new Error(`Missing required runtime package ${packageName}`, { cause: error });
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function assertPackageVersion(packageName, expectedVersion, options = {}) {
  const packageJsonPath = resolvePackageJson(packageName, options);
  if (!packageJsonPath) {
    return null;
  }
  const actualVersion = readJson(packageJsonPath).version;
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${packageName} version mismatch: expected ${expectedVersion}, found ${actualVersion}`,
    );
  }
  return packageJsonPath;
}

function assertDockerfileVersion(expectedVersion) {
  const dockerfilePath = path.join(root, "deploy", "fly-gateway", "Dockerfile");
  if (!fs.existsSync(dockerfilePath)) {
    return;
  }
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const match = /^ARG OPENCLAW_VERSION=(.+)$/m.exec(dockerfile);
  if (!match) {
    throw new Error("deploy/fly-gateway/Dockerfile must declare ARG OPENCLAW_VERSION");
  }
  if (match[1].trim() !== expectedVersion) {
    throw new Error(
      `Dockerfile OpenClaw version mismatch: expected ${expectedVersion}, found ${match[1].trim()}`,
    );
  }
}

function assertNoRuntimePackagePatches() {
  const dockerfilePath = path.join(root, "deploy", "fly-gateway", "Dockerfile");
  if (!fs.existsSync(dockerfilePath)) {
    return;
  }
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const forbiddenPatterns = [
    /node_modules\/openclaw\/dist/,
    /fs\.writeFileSync\(target,\s*before\.replace/,
    /ensure-openclaw-runtime-templates/,
    /ensure-codex-native-deps/,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(dockerfile)) {
      throw new Error(
        `Dockerfile contains unsupported runtime package patching pattern: ${pattern}`,
      );
    }
  }
}

function assertOpenClawTemplates(openclawPackageJsonPath) {
  const openclawRoot = path.dirname(openclawPackageJsonPath);
  const primaryTemplateDir = path.join(openclawRoot, "src", "agents", "templates");
  const docsTemplateDir = path.join(openclawRoot, "docs", "reference", "templates");

  for (const fileName of primaryTemplateNames) {
    assertFile(
      path.join(primaryTemplateDir, fileName),
      `OpenClaw runtime template ${fileName}`,
    );
  }

  for (const fileName of searchableTemplateNames) {
    const candidates = [
      path.join(primaryTemplateDir, fileName),
      path.join(docsTemplateDir, fileName),
    ];
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      throw new Error(
        `Missing OpenClaw workspace template ${fileName}: expected one of ${candidates.join(", ")}`,
      );
    }
  }
}

function assertOpenClawExecutable(openclawPackageJsonPath) {
  assertFile(path.join(path.dirname(openclawPackageJsonPath), "openclaw.mjs"), "OpenClaw CLI");
}

function assertFacebookPlugin() {
  const pluginPackageJsonPath = resolvePackageJson("@dj-shortcut/facebook");
  const pluginRoot = path.dirname(pluginPackageJsonPath);
  assertFile(path.join(pluginRoot, "dist", "index.js"), "Facebook plugin runtime entry");
  assertFile(path.join(pluginRoot, "dist", "setup-entry.js"), "Facebook plugin setup entry");
  assertFile(path.join(pluginRoot, "openclaw.plugin.json"), "Facebook plugin manifest");
}

const rootPackagePath = path.join(root, "package.json");
const rootPackage = fs.existsSync(rootPackagePath) ? readJson(rootPackagePath) : {};
const expectedOpenClawVersion =
  process.env.EXPECTED_OPENCLAW_VERSION?.trim() ||
  rootPackage.openclaw?.build?.openclawVersion;
if (!expectedOpenClawVersion) {
  throw new Error(
    "Set EXPECTED_OPENCLAW_VERSION or declare openclaw.build.openclawVersion in package.json",
  );
}

assertDockerfileVersion(expectedOpenClawVersion);
assertNoRuntimePackagePatches();
const openclawPackageJsonPath = assertPackageVersion("openclaw", expectedOpenClawVersion, {
  required: gatewayMode,
});
if (openclawPackageJsonPath) {
  assertOpenClawExecutable(openclawPackageJsonPath);
  assertOpenClawTemplates(openclawPackageJsonPath);
}
if (gatewayMode) {
  assertPackageVersion("@openclaw/codex", expectedOpenClawVersion);
  assertFacebookPlugin();
}

console.log(
  JSON.stringify(
    {
      ok: true,
      root,
      mode: gatewayMode ? "gateway" : "repository",
      openclawVersion: expectedOpenClawVersion,
      checked: [
        "version references",
        "no runtime package patching",
        "openclaw package version",
        "OpenClaw CLI",
        "OpenClaw workspace templates",
        ...(gatewayMode
          ? ["@openclaw/codex package version", "Facebook plugin runtime package"]
          : []),
      ],
    },
    null,
    2,
  ),
);
