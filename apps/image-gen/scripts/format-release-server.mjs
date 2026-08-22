import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = process.env.LINT_BASE_REF?.trim() || "origin/main";
execFileSync("git", ["rev-parse", "--verify", base], {
  cwd: appRoot,
  stdio: "ignore",
});
const files = [
  ...lines(
    execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", base, "--", "server"],
      { cwd: appRoot, encoding: "utf8" }
    )
  ),
  ...lines(
    execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "server"],
      { cwd: appRoot, encoding: "utf8" }
    )
  ),
]
  .map(file => file.replace(/^apps\/image-gen\//, ""))
  .filter(file => /\.[cm]?[jt]sx?$/.test(file));
const unique = [...new Set(files)];
if (unique.length === 0) process.exit(0);
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "exec",
    "prettier",
    process.argv.includes("--write") ? "--write" : "--check",
    ...unique,
  ],
  { cwd: appRoot, encoding: "utf8", stdio: "inherit" }
);
process.exit(result.status ?? 1);

function lines(value) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
