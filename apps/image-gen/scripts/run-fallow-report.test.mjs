import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNpxCommand,
  parseRunFallowReportArgs,
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

describe("getNpxCommand", () => {
  it("uses the Windows command shim on win32", () => {
    expect(getNpxCommand("win32")).toBe("npx.cmd");
  });

  it("uses npx on non-Windows platforms", () => {
    expect(getNpxCommand("linux")).toBe("npx");
    expect(getNpxCommand("darwin")).toBe("npx");
  });
});

describe("parseRunFallowReportArgs", () => {
  it("parses the runner options and forwards fallow args after --", () => {
    expect(
      parseRunFallowReportArgs([
        "--root",
        "apps/image-gen",
        "--output",
        ".fallow/report-production.json",
        "--",
        "--production",
        "--summary",
      ])
    ).toEqual({
      root: "apps/image-gen",
      outputPath: ".fallow/report-production.json",
      fallowArgs: ["--production", "--summary"],
    });
  });
});

describe("runFallowReport", () => {
  it("runs fallow with the Windows npx shim and normalizes with the repo script", () => {
    const root = makeTempDir();
    const outputPath = path.join(root, ".fallow", "report.json");
    const spawn = vi.fn((command, args) => {
      if (command === "npx.cmd") {
        return { status: 0, stdout: '{"check":{"files":[]}}', stderr: "" };
      }

      expect(command).toBe(process.execPath);
      expect(args[0]).toBe(normalizeScriptPath);
      expect(args.slice(1, 3)).toEqual(["--root", root]);
      expect(fs.existsSync(args[3])).toBe(true);
      return { status: 0, stdout: "", stderr: "" };
    });
    const exit = vi.fn();

    const status = runFallowReport({
      args: ["--root", root, "--output", outputPath, "--", "--production"],
      platform: "win32",
      spawn,
      exit,
      stderr: { write: vi.fn() },
    });

    expect(status).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      "npx.cmd",
      ["--yes", "fallow@2.27.0", "--root", root, "--production", "-f", "json"],
      expect.objectContaining({ cwd: root })
    );
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      check: { files: [] },
    });
  });
});
