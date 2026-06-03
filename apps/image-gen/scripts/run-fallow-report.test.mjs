import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFallowSpawnConfig,
  getNpxCommand,
  parseRunFallowReportArgs,
  quoteWindowsShellArg,
} from "./run-fallow-report.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("./run-fallow-report.mjs", import.meta.url)
);
const tempDirs = [];

async function makeTempDir() {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "run-fallow-report-")
  );
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map(tempDir => fs.rm(tempDir, { recursive: true, force: true }))
  );
});

describe("run-fallow-report", () => {
  it("uses the npm cmd shim for npx on Windows", () => {
    expect(getNpxCommand("win32")).toBe("npx.cmd");
  });

  it("uses the npx executable directly on non-Windows platforms", () => {
    expect(getNpxCommand("linux")).toBe("npx");
    expect(getNpxCommand("darwin")).toBe("npx");
  });

  it("enables the shell and quotes fallow arguments for Windows npx.cmd", () => {
    const config = createFallowSpawnConfig(
      "C:\\tmp\\image gen",
      ["--flag=hello & goodbye", 'quote"value'],
      "win32"
    );

    expect(config.args).toEqual([]);
    expect(config.options).toMatchObject({
      cwd: "C:\\tmp\\image gen",
      shell: true,
    });
    expect(config.command).toContain("npx.cmd");
    expect(config.command).toContain(
      quoteWindowsShellArg("C:\\tmp\\image gen")
    );
    expect(config.command).toContain(
      quoteWindowsShellArg("--flag=hello & goodbye")
    );
    expect(config.command).toContain(quoteWindowsShellArg('quote"value'));
  });

  it("keeps fallow arguments after the separator", () => {
    expect(
      parseRunFallowReportArgs([
        "--root",
        ".",
        "--output",
        ".fallow/report-production.json",
        "--",
        "--production",
      ])
    ).toEqual({
      fallowArgs: ["--production"],
      outputPath: ".fallow/report-production.json",
      root: ".",
    });
  });

  it("normalizes the generated report with the repo-level script", async () => {
    const tempDir = await makeTempDir();
    const binDir = path.join(tempDir, "bin");
    const projectRoot = path.join(tempDir, "project");
    const outputPath = path.join(projectRoot, ".fallow", "report.json");

    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    const rawReport = JSON.stringify({
      files: [
        {
          file: path.join(projectRoot, "index.ts"),
          issues: [{ line: 1, column: 1, message: "unused" }],
        },
      ],
    });

    await fs.writeFile(
      path.join(binDir, "npx"),
      `#!/usr/bin/env sh\nprintf '%s' '${rawReport}'\n`,
      { mode: 0o755 }
    );
    await fs.writeFile(
      path.join(binDir, "npx.cmd"),
      `@echo off\necho ${rawReport}\n`,
      "utf8"
    );

    await execFileAsync(
      process.execPath,
      [scriptPath, "--root", projectRoot, "--output", outputPath],
      {
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          Path: `${binDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
        },
      }
    );

    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.files[0]).toEqual({
      file: "index.ts",
      issues: [
        {
          line: 1,
          column: 1,
          message: "unused",
        },
      ],
    });
  });
});
