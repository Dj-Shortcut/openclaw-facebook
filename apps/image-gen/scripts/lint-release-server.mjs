import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = process.env.LINT_BASE_REF?.trim() || "origin/main";
execFileSync("git", ["rev-parse", "--verify", base], {
  cwd: appRoot,
  stdio: "ignore",
});

const changed = lines(
  execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", base, "--", "server"],
    { cwd: appRoot, encoding: "utf8" }
  )
).filter(isTypeScript);
const untracked = lines(
  execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "server"],
    { cwd: appRoot, encoding: "utf8" }
  )
).filter(isTypeScript);
const files = [...new Set([...changed, ...untracked])];
if (files.length === 0) process.exit(0);

const lint = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "eslint", "--format", "json", ...files],
  { cwd: appRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
);
if (lint.error) throw lint.error;
let reports;
try {
  reports = JSON.parse(lint.stdout || "[]");
} catch {
  process.stderr.write(lint.stderr || lint.stdout);
  process.exit(1);
}

const untrackedSet = new Set(untracked);
const failures = [];
for (const report of reports) {
  const file = relativePath(report.filePath);
  const ranges = untrackedSet.has(file) ? [[1, Number.MAX_SAFE_INTEGER]] : addedRanges(file);
  for (const message of report.messages ?? []) {
    if (
      message.severity === 2 &&
      ranges.some(([start, end]) => message.line >= start && message.line <= end)
    ) {
      failures.push(
        `${file}:${message.line}:${message.column} ${message.message} (${message.ruleId ?? "eslint"})`
      );
    }
  }
}
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stderr.write(`Release server lint failed with ${failures.length} new error(s).\n`);
  process.exit(1);
}
process.stdout.write(`Release server lint passed for ${files.length} changed file(s).\n`);

function addedRanges(file) {
  const diff = execFileSync(
    "git",
    ["diff", "--unified=0", base, "--", file],
    { cwd: appRoot, encoding: "utf8" }
  );
  const ranges = [];
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

function relativePath(file) {
  const marker = "/apps/image-gen/";
  const index = file.replaceAll("\\", "/").lastIndexOf(marker);
  return index >= 0 ? file.replaceAll("\\", "/").slice(index + marker.length) : file;
}

function lines(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function isTypeScript(file) {
  return /\.[cm]?[jt]sx?$/.test(file);
}
