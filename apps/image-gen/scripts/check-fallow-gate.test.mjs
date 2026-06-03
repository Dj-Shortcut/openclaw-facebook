import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(import.meta.dirname, "check-fallow-gate.mjs");
const tempDirs = [];

async function writeReport(report) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "fallow-gate-"));
  tempDirs.push(tempDir);
  const reportPath = path.join(tempDir, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function createReport({
  maintainability = 90,
  totalIssues = 1,
  functionsAboveThreshold = 0,
  unusedFiles = 0,
  includeHealthSummary = true,
} = {}) {
  return {
    check: {
      total_issues: totalIssues,
      summary: {
        total_issues: totalIssues,
        unused_files: unusedFiles,
        unused_exports: Math.max(totalIssues - unusedFiles, 0),
        unresolved_imports: 0,
      },
    },
    health: includeHealthSummary
      ? {
          summary: {
            average_maintainability: maintainability,
            functions_above_threshold: functionsAboveThreshold,
            functions_analyzed: 42,
            files_scored: 12,
          },
        }
      : {},
  };
}

function runGate(reportPath, env = {}) {
  return spawnSync(process.execPath, [scriptPath, reportPath], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      FALLOW_MIN_SCORE: undefined,
      FALLOW_MAX_ISSUES: undefined,
      FALLOW_MAX_FUNCTIONS_ABOVE_THRESHOLD: undefined,
      FALLOW_MAX_UNUSED_FILES: undefined,
      ...env,
    },
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map(tempDir => rm(tempDir, { recursive: true, force: true }))
  );
});

describe("check-fallow-gate", () => {
  it("fails when the maintainability score is too low", async () => {
    const reportPath = await writeReport(
      createReport({ maintainability: 84.94 })
    );

    const result = runGate(reportPath, { FALLOW_MIN_SCORE: "85" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("below the required 85.0");
    const output = JSON.parse(result.stdout);
    expect(output.maintainability).toBe(84.9);
    expect(output.functionsAboveThreshold).toBe(0);
    expect(output.summary.total_issues).toBe(1);
  });

  it("fails when the score passes but there are too many issues", async () => {
    const reportPath = await writeReport(
      createReport({ maintainability: 90, totalIssues: 8 })
    );

    const result = runGate(reportPath, {
      FALLOW_MIN_SCORE: "85",
      FALLOW_MAX_ISSUES: "7",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("total issues 8 exceeds the allowed 7");
    const output = JSON.parse(result.stdout);
    expect(output.maintainability).toBe(90);
    expect(output.totalIssues).toBe(8);
    expect(output.limits.maximumIssues).toBe(7);
  });

  it("fails when the score passes but too many functions exceed complexity thresholds", async () => {
    const reportPath = await writeReport(
      createReport({ maintainability: 90, functionsAboveThreshold: 3 })
    );

    const result = runGate(reportPath, {
      FALLOW_MIN_SCORE: "85",
      FALLOW_MAX_FUNCTIONS_ABOVE_THRESHOLD: "2",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "functions above threshold 3 exceeds the allowed 2"
    );
    const output = JSON.parse(result.stdout);
    expect(output.functionsAboveThreshold).toBe(3);
    expect(output.limits.maximumFunctionsAboveThreshold).toBe(2);
  });

  it("fails clearly when health.summary is missing", async () => {
    const reportPath = await writeReport(
      createReport({ includeHealthSummary: false })
    );

    const result = runGate(reportPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Fallow health summary not found in report JSON"
    );
    expect(result.stdout).toBe("");
  });
});
