#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const requiredTemplates = ["HEARTBEAT.md", "SOUL.md", "IDENTITY.md"];

const args = process.argv.slice(2);
const appRootArg = args.find((arg) => !arg.startsWith("--"));
const verifyOnly = args.includes("--verify-only");
const appRoot = appRootArg ? path.resolve(appRootArg) : process.cwd();
const openclawPackageRoot = path.join(appRoot, "node_modules", "openclaw");
const runtimeTemplateDir = path.join(
  openclawPackageRoot,
  "src",
  "agents",
  "templates",
);
const referenceTemplateDir = path.join(
  openclawPackageRoot,
  "docs",
  "reference",
  "templates",
);

function copyReferenceTemplateIfMissing(fileName) {
  const runtimePath = path.join(runtimeTemplateDir, fileName);
  if (fs.existsSync(runtimePath)) {
    return false;
  }
  if (verifyOnly) {
    return false;
  }

  const referencePath = path.join(referenceTemplateDir, fileName);
  if (!fs.existsSync(referencePath)) {
    return false;
  }

  fs.mkdirSync(runtimeTemplateDir, { recursive: true });
  fs.copyFileSync(referencePath, runtimePath);
  return true;
}

if (!fs.existsSync(openclawPackageRoot)) {
  throw new Error(`Cannot find OpenClaw package at ${openclawPackageRoot}`);
}

const copied = [];
for (const fileName of requiredTemplates) {
  if (copyReferenceTemplateIfMissing(fileName)) {
    copied.push(fileName);
  }
}

const missing = requiredTemplates.filter(
  (fileName) => !fs.existsSync(path.join(runtimeTemplateDir, fileName)),
);
if (missing.length > 0) {
  throw new Error(
    `Missing OpenClaw runtime template(s) in ${runtimeTemplateDir}: ${missing.join(
      ", ",
    )}`,
  );
}

const copiedText = copied.length > 0 ? `; restored ${copied.join(", ")}` : "";
console.log(
  `verified OpenClaw runtime templates in ${runtimeTemplateDir}${copiedText}`,
);
