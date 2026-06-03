import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const normalizeScriptPath = fileURLToPath(
  new URL("../../../scripts/normalize-fallow-report.mjs", import.meta.url)
);

export function getNpxCommand(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export function quoteWindowsShellArg(value) {
  const stringValue = String(value);

  if (stringValue.length === 0) {
    return '""';
  }

  let quotedValue = '"';
  let backslashCount = 0;

  for (const character of stringValue) {
    if (character === "\\") {
      backslashCount += 1;
      continue;
    }

    if (character === '"') {
      quotedValue += "\\".repeat(backslashCount * 2 + 1);
      quotedValue += '"';
      backslashCount = 0;
      continue;
    }

    quotedValue += "\\".repeat(backslashCount);
    quotedValue += character;
    backslashCount = 0;
  }

  quotedValue += "\\".repeat(backslashCount * 2);
  quotedValue += '"';

  return quotedValue;
}

export function createFallowSpawnConfig(
  rootPath,
  fallowArgs,
  platform = process.platform
) {
  const args = [
    "--yes",
    "fallow@2.27.0",
    "--root",
    rootPath,
    ...fallowArgs,
    "-f",
    "json",
  ];
  const options = {
    cwd: rootPath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 200,
  };

  if (platform === "win32") {
    return {
      command: `${getNpxCommand(platform)} ${args.map(quoteWindowsShellArg).join(" ")}`,
      args: [],
      options: {
        ...options,
        shell: true,
      },
    };
  }

  return {
    command: getNpxCommand(platform),
    args,
    options,
  };
}

export function parseRunFallowReportArgs(args) {
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

  return { fallowArgs, outputPath, root };
}

export function runFallowReport(args = process.argv.slice(2), options = {}) {
  const { platform = process.platform, spawn = spawnSync } = options;
  const { fallowArgs, outputPath, root } = parseRunFallowReportArgs(args);

  if (!outputPath) {
    console.error(
      "Usage: node scripts/run-fallow-report.mjs [--root <root>] --output <report.json> [-- <fallow args>]"
    );
    return 1;
  }

  const rootPath = path.resolve(root);
  const outputAbsolutePath = path.resolve(outputPath);
  const outputDirectory = path.dirname(outputAbsolutePath);
  fs.mkdirSync(outputDirectory, { recursive: true });

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fallow-report-")
  );
  const temporaryReportPath = path.join(
    temporaryDirectory,
    path.basename(outputPath)
  );

  try {
    const fallowSpawnConfig = createFallowSpawnConfig(
      rootPath,
      fallowArgs,
      platform
    );
    const result = spawn(
      fallowSpawnConfig.command,
      fallowSpawnConfig.args,
      fallowSpawnConfig.options
    );

    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      return result.status ?? 1;
    }

    fs.writeFileSync(temporaryReportPath, result.stdout, "utf8");

    const normalizeResult = spawn(
      process.execPath,
      [normalizeScriptPath, "--root", rootPath, temporaryReportPath],
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
      return normalizeResult.status ?? 1;
    }

    fs.copyFileSync(temporaryReportPath, outputAbsolutePath);
    return 0;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exit(runFallowReport());
}
