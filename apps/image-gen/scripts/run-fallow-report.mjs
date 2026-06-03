import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
let root = ".";
let outputPath = "";
const fallowArgs = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (arg === "--root") {
    root = args[index + 1];
    index += 1;
    continue;
  }

  if (arg === "--output") {
    outputPath = args[index + 1];
    index += 1;
    continue;
  }

  if (arg === "--") {
    fallowArgs.push(...args.slice(index + 1));
    break;
  }

  fallowArgs.push(arg);
}

if (!outputPath) {
  console.error(
    "Usage: node scripts/run-fallow-report.mjs [--root <root>] --output <report.json> [-- <fallow args>]"
  );
  process.exit(1);
}

const rootPath = path.resolve(root);
const outputAbsolutePath = path.resolve(outputPath);
const outputDirectory = path.dirname(outputAbsolutePath);
fs.mkdirSync(outputDirectory, { recursive: true });

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fallow-report-"));
const temporaryReportPath = path.join(temporaryDirectory, path.basename(outputPath));

try {
  const result = spawnSync(
    "npx",
    ["--yes", "fallow@2.27.0", "--root", rootPath, ...fallowArgs, "-f", "json"],
    {
      cwd: rootPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 200,
    }
  );

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  fs.writeFileSync(temporaryReportPath, result.stdout, "utf8");

  const normalizeResult = spawnSync(
    "node",
    ["../../scripts/normalize-fallow-report.mjs", "--root", rootPath, temporaryReportPath],
    {
      cwd: rootPath,
      encoding: "utf8",
      stdio: "inherit",
    }
  );

  if (normalizeResult.error) {
    throw normalizeResult.error;
  }

  if (normalizeResult.status !== 0) {
    process.exit(normalizeResult.status ?? 1);
  }

  fs.copyFileSync(temporaryReportPath, outputAbsolutePath);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
