import fs from "node:fs";

const [reportPath] = process.argv.slice(2);

if (!reportPath) {
  console.error("Usage: node scripts/check-fallow-gate.mjs <report.json>");
  process.exit(1);
}

function readNumberEnv(name, defaultValue) {
  const rawValue = process.env[name];
  const value =
    rawValue == null || rawValue === "" ? defaultValue : Number(rawValue);

  if (value == null) {
    return undefined;
  }

  if (!Number.isFinite(value)) {
    console.error(`${name} must be a number`);
    process.exit(1);
  }

  return value;
}

const minimumMaintainability = readNumberEnv("FALLOW_MIN_SCORE", 85);
const maximumIssues = readNumberEnv("FALLOW_MAX_ISSUES");
const maximumFunctionsAboveThreshold = readNumberEnv(
  "FALLOW_MAX_FUNCTIONS_ABOVE_THRESHOLD"
);
const maximumUnusedFiles = readNumberEnv("FALLOW_MAX_UNUSED_FILES");

const report = JSON.parse(
  fs.readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "")
);
const healthSummary = report.health?.summary;

if (!healthSummary) {
  console.error("Fallow health summary not found in report JSON");
  process.exit(1);
}

const maintainability = Number(healthSummary.average_maintainability);

if (!Number.isFinite(maintainability)) {
  console.error("Fallow average maintainability not found in report JSON");
  process.exit(1);
}

const checkSummary = report.check?.summary ?? {};
const roundedMaintainability = Number(maintainability.toFixed(1));
const totalIssues = Number(
  report.check?.total_issues ?? report.total_issues ?? 0
);
const unusedFiles = Number(checkSummary.unused_files ?? 0);
const functionsAboveThreshold = Number(
  healthSummary.functions_above_threshold ?? 0
);

const failures = [];

if (roundedMaintainability < minimumMaintainability) {
  failures.push(
    `Fallow maintainability ${roundedMaintainability.toFixed(1)} is below the required ${minimumMaintainability.toFixed(1)}`
  );
}

if (maximumIssues != null && totalIssues > maximumIssues) {
  failures.push(
    `Fallow total issues ${totalIssues} exceeds the maximum ${maximumIssues}`
  );
}

if (
  maximumFunctionsAboveThreshold != null &&
  functionsAboveThreshold > maximumFunctionsAboveThreshold
) {
  failures.push(
    `Fallow functions above threshold ${functionsAboveThreshold} exceeds the maximum ${maximumFunctionsAboveThreshold}`
  );
}

if (maximumUnusedFiles != null && unusedFiles > maximumUnusedFiles) {
  failures.push(
    `Fallow unused files ${unusedFiles} exceeds the maximum ${maximumUnusedFiles}`
  );
}

const output = {
  maintainability: roundedMaintainability,
  minimumMaintainability,
  totalIssues,
  maximumIssues,
  functionsAboveThreshold,
  maximumFunctionsAboveThreshold,
  summary: {
    ...checkSummary,
    total_issues: totalIssues,
  },
  healthSummary: {
    functions_above_threshold: functionsAboveThreshold,
    functions_analyzed: healthSummary.functions_analyzed,
    files_scored: healthSummary.files_scored,
  },
  mode: "primary",
};

if (maximumUnusedFiles != null) {
  output.maximumUnusedFiles = maximumUnusedFiles;
}

console.log(JSON.stringify(output, null, 2));

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
