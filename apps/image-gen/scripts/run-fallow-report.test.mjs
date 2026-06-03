import { describe, expect, it } from "vitest";
import {
  getNpxCommand,
  parseRunFallowReportArgs,
} from "./run-fallow-report.mjs";

describe("run-fallow-report", () => {
  it("uses the npm cmd shim for npx on Windows", () => {
    expect(getNpxCommand("win32")).toBe("npx.cmd");
  });

  it("uses the npx executable directly on non-Windows platforms", () => {
    expect(getNpxCommand("linux")).toBe("npx");
    expect(getNpxCommand("darwin")).toBe("npx");
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
});
