#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function fail(message) {
  throw new Error(message);
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label} mismatch: expected ${expected}, found ${actual ?? "<missing>"}`);
  }
}

function expectMatch(label, text, pattern, expected) {
  const match = pattern.exec(text);
  if (!match) {
    fail(`${label} missing`);
  }
  expectEqual(label, match[1].trim(), expected);
}

function readCargoPackageVersion(relativePath) {
  const cargoToml = readText(relativePath);
  const packageSection = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(cargoToml)?.[1];
  if (!packageSection) {
    fail(`${relativePath} [package] section missing`);
  }
  return /^version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
}

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const pluginVersion = pkg.version;
const openclawVersion = pkg.openclaw?.build?.openclawVersion;
const pluginSdkVersion = pkg.openclaw?.build?.pluginSdkVersion;
const minHostVersion = pkg.openclaw?.install?.minHostVersion;
const minGatewayVersion = pkg.openclaw?.compat?.minGatewayVersion;

if (!pluginVersion) {
  fail("package.json version missing");
}
if (!openclawVersion) {
  fail("package.json openclaw.build.openclawVersion missing");
}

expectEqual("OpenClaw plugin SDK version", pluginSdkVersion, openclawVersion);
expectEqual("package-lock root version", lock.version, pluginVersion);
expectEqual("package-lock packages[''].version", lock.packages?.[""]?.version, pluginVersion);
expectEqual(
  "package.json devDependency openclaw",
  pkg.devDependencies?.openclaw,
  `^${openclawVersion}`,
);

const dockerfile = readText("deploy/fly-gateway/Dockerfile");
expectMatch(
  "Fly gateway OPENCLAW_VERSION",
  dockerfile,
  /^ARG OPENCLAW_VERSION=(.+)$/m,
  openclawVersion,
);

const manifestTest = readText("manifest.test.ts");
expectMatch(
  "manifest test OpenClaw version",
  manifestTest,
  /openclawVersion: "([^"]+)"/,
  openclawVersion,
);
expectMatch(
  "manifest test plugin SDK version",
  manifestTest,
  /pluginSdkVersion: "([^"]+)"/,
  openclawVersion,
);
expectMatch(
  "manifest test min gateway version",
  manifestTest,
  /minGatewayVersion: "([^"]+)"/,
  minGatewayVersion,
);
expectMatch(
  "manifest test min host version",
  manifestTest,
  /minHostVersion: "([^"]+)"/,
  minHostVersion,
);

const listing = readText("docs/clawhub-listing.md");
expectMatch(
  "ClawHub listing OpenClaw tested version",
  listing,
  /- OpenClaw build tested with: `([^`]+)`/,
  openclawVersion,
);
expectMatch(
  "ClawHub listing plugin version",
  listing,
  /- Plugin version: `([^`]+)`/,
  pluginVersion,
);
expectMatch(
  "ClawHub listing release notes version",
  listing,
  /## Release Notes For ([^\n]+)/,
  pluginVersion,
);
expectMatch(
  "ClawHub listing verified tarball version",
  listing,
  /dj-shortcut-facebook-([^`]+)\.tgz/,
  pluginVersion,
);

const customerApp = readJson("apps/customer-app/package.json");
const tauriConfig = readJson("apps/customer-app/src-tauri/tauri.conf.json");
expectEqual("customer app Tauri version", tauriConfig.version, customerApp.version);
expectEqual(
  "customer app Cargo package version",
  readCargoPackageVersion("apps/customer-app/src-tauri/Cargo.toml"),
  customerApp.version,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      pluginVersion,
      openclawVersion,
      checked: [
        "root package and lockfile",
        "OpenClaw runtime metadata",
        "Fly gateway Dockerfile",
        "manifest test expectations",
        "ClawHub listing copy",
        "customer app package/Tauri/Cargo versions",
      ],
    },
    null,
    2,
  ),
);
