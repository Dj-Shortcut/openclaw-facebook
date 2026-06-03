import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("./check-fallow-gate.mjs", import.meta.url)
);
const tempDirs = [];

async function writeReport(report) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fallow-gate-"));
  tempDirs.push(tempDir);
  const reportPath = path.join(tempDir, "report.json");
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  return reportPath;
}

function makeReport(overrides = {}) {
  return {
    check: {
      total_issues: 2,
      summary: {
        unused_files: 1,
        unused_exports: 1,
        unused_types: 0,
      },
    },
    health: {
      summary: {
        average_maintainability: 90,
        functions_above_threshold: 0,
        functions_analyzed: 100,
        files_scored: 20,
      },
    },
    ...overrides,
  };
}

async function runGate(report, env = {}) {
  const reportPath = await writeReport(report);

  try {
    const result = await execFileAsync(
      process.execPath,
      [scriptPath, reportPath],
      {
        env: { ...process.env, ...env },
      }
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

function parseOutputJson(result) {
  return JSON.parse(result.stdout);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map(tempDir => fs.rm(tempDir, { recursive: true, force: true }))
  );
});

describe("check-fallow-gate", () => {
  it("fails when the maintainability score is too low", async () => {
    const result = await runGate(
      makeReport({
        health: {
          summary: {
            average_maintainability: 84.94,
            functions_above_threshold: 0,
          },
        },
      })
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "maintainability 84.9 is below the required 85.0"
    );
    expect(parseOutputJson(result)).toMatchObject({
      maintainability: 84.9,
      minimumMaintainability: 85,
      totalIssues: 2,
      functionsAboveThreshold: 0,
    });
  });

  it("fails when the score is good but there are too many issues", async () => {
    const result = await runGate(
      makeReport({
        check: {
          total_issues: 3,
          summary: {
            unused_files: 1,
            unused_exports: 2,
          },
        },
      }),
      { FALLOW_MAX_ISSUES: "2" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("total issues 3 exceeds the maximum 2");
    expect(parseOutputJson(result)).toMatchObject({
      maintainability: 90,
      totalIssues: 3,
      maximumIssues: 2,
      summary: {
        total_issues: 3,
        unused_files: 1,
        unused_exports: 2,
      },
    });
  });

  it("fails when the score is good but too many functions exceed complexity thresholds", async () => {
    const result = await runGate(
      makeReport({
        health: {
          summary: {
            average_maintainability: 91,
            functions_above_threshold: 4,
            functions_analyzed: 120,
            files_scored: 25,
          },
        },
      }),
      { FALLOW_MAX_FUNCTIONS_ABOVE_THRESHOLD: "3" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "functions above threshold 4 exceeds the maximum 3"
    );
    expect(parseOutputJson(result)).toMatchObject({
      maintainability: 91,
      functionsAboveThreshold: 4,
      maximumFunctionsAboveThreshold: 3,
      healthSummary: {
        functions_above_threshold: 4,
        functions_analyzed: 120,
        files_scored: 25,
      },
    });
  });

  it("fails clearly when health.summary is missing", async () => {
    const result = await runGate({
      check: {
        total_issues: 0,
        summary: {
          unused_files: 0,
        },
      },
      health: {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Fallow health summary not found in report JSON"
    );
  });
});
