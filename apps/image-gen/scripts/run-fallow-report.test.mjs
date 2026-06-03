import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFallowSpawnConfig,
  getNpxCommand,
  parseRunFallowReportArgs,
  quoteWindowsShellArg,
  runFallowReport,
} from "./run-fallow-report.mjs";

const normalizeScriptPath = fileURLToPath(
  new URL("../../../scripts/normalize-fallow-report.mjs", import.meta.url)
);
const tempDirs = [];

function makeTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-fallow-report-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
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

  it("runs Fallow with Windows-safe spawn options and normalizes with the repo script", () => {
    const root = makeTempDir();
    const outputPath = path.join(root, ".fallow", "report.json");
    const spawn = vi.fn((command, args, options) => {
      if (spawn.mock.calls.length === 1) {
        expect(command).toContain("npx.cmd");
        expect(args).toEqual([]);
        expect(options).toMatchObject({ cwd: root, shell: true });
        expect(command).toContain(quoteWindowsShellArg(root));
        return { status: 0, stdout: '{"check":{"files":[]}}', stderr: "" };
      }

      expect(command).toBe(process.execPath);
      expect(args[0]).toBe(normalizeScriptPath);
      expect(args.slice(1, 3)).toEqual(["--root", root]);
      expect(fs.existsSync(args[3])).toBe(true);
      fs.writeFileSync(args[3], '{"check":{"files":[]},"normalized":true}\n');
      return { status: 0, stdout: "", stderr: "" };
    });

    const status = runFallowReport(
      ["--root", root, "--output", outputPath, "--", "--production"],
      { platform: "win32", spawn }
    );

    expect(status).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      check: { files: [] },
      normalized: true,
    });
  });
});
