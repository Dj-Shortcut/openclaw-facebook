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
const clawhubListingPath = path.join(root, "docs", "clawhub-listing.md");

const pkg = readJson(packagePath);
const minHostVersion = pkg.openclaw?.install?.minHostVersion;
if (typeof minHostVersion !== "string" || !minHostVersion.trim()) {
  throw new Error("package.json openclaw.install.minHostVersion is required");
}
pkg.version = version;
pkg.peerDependencies = {
  ...(pkg.peerDependencies ?? {}),
  openclaw: version.includes("-")
    ? `${minHostVersion} || ${version}`
    : minHostVersion,
};
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
replaceOrThrow(
  clawhubListingPath,
  /(- OpenClaw build tested with: `)[^`]+(`)/,
  `$1${version}$2`,
  "ClawHub tested OpenClaw version",
);
replaceOrThrow(
  clawhubListingPath,
  /(- Plugin version: `)[^`]+(`)/,
  `$1${version}$2`,
  "ClawHub plugin version",
);
replaceOrThrow(
  clawhubListingPath,
  /(## Release Notes For )[^\n]+/,
  `$1${version}`,
  "ClawHub release notes version",
);
replaceOrThrow(
  clawhubListingPath,
  /(dj-shortcut-facebook-)[^`]+(\.tgz)/,
  `$1${version}$2`,
  "ClawHub verified tarball version",
);

console.log(`Updated OpenClaw references to ${version}`);
