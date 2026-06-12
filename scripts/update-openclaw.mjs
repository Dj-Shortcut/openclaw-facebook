#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function usage() {
  console.error("Usage: node scripts/update-openclaw.mjs <version>");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceOrThrow(filePath, pattern, replacement, label) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    throw new Error(`Could not update ${label} in ${filePath}`);
  }
  fs.writeFileSync(filePath, after);
}

function assertVersion(value) {
  if (!/^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`Invalid OpenClaw version: ${value}`);
  }
}

const version = process.argv[2]?.trim();
if (!version) {
  usage();
  process.exit(2);
}
assertVersion(version);

const root = process.cwd();
const packagePath = path.join(root, "package.json");
const manifestTestPath = path.join(root, "manifest.test.ts");
const dockerfilePath = path.join(root, "deploy", "fly-gateway", "Dockerfile");

const pkg = readJson(packagePath);
pkg.version = version;
pkg.devDependencies = {
  ...(pkg.devDependencies ?? {}),
  openclaw: `^${version}`,
};
pkg.openclaw = {
  ...(pkg.openclaw ?? {}),
  build: {
    ...(pkg.openclaw?.build ?? {}),
    openclawVersion: version,
    pluginSdkVersion: version,
  },
};
writeJson(packagePath, pkg);

replaceOrThrow(
  manifestTestPath,
  /openclawVersion: "(\d{4}\.\d+\.\d+(?:-[^"]+)?)"/,
  `openclawVersion: "${version}"`,
  "manifest OpenClaw version",
);
replaceOrThrow(
  manifestTestPath,
  /pluginSdkVersion: "(\d{4}\.\d+\.\d+(?:-[^"]+)?)"/,
  `pluginSdkVersion: "${version}"`,
  "manifest plugin SDK version",
);
replaceOrThrow(
  dockerfilePath,
  /^ARG OPENCLAW_VERSION=.*$/m,
  `ARG OPENCLAW_VERSION=${version}`,
  "Fly gateway OpenClaw version",
);

console.log(`Updated OpenClaw references to ${version}`);
