import fs from "node:fs";

const [reportPath] = process.argv.slice(2);

if (!reportPath) {
  console.error("Usage: node scripts/check-fallow-gate.mjs <report.json>");
  process.exit(1);
}

function readNumberEnv(name, defaultValue) {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? defaultValue : Number(rawValue);

  if (!Number.isFinite(value)) {
    console.error(`${name} must be a number`);
    process.exit(1);
  }

  return value;
}

function readOptionalNumberEnv(name) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === "") {
    return undefined;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    console.error(`${name} must be a number`);
    process.exit(1);
  }

  return value;
}

const minimumMaintainability = readNumberEnv("FALLOW_MIN_SCORE", 85);
const maximumIssues = readOptionalNumberEnv("FALLOW_MAX_ISSUES");
const maximumFunctionsAboveThreshold = readOptionalNumberEnv(
  "FALLOW_MAX_FUNCTIONS_ABOVE_THRESHOLD"
);
const maximumUnusedFiles = readOptionalNumberEnv("FALLOW_MAX_UNUSED_FILES");

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

const roundedMaintainability = Number(maintainability.toFixed(1));
const checkSummary = report.check?.summary ?? {};
const totalIssues = Number(
  report.check?.total_issues ?? report.total_issues ?? 0
);
const functionsAboveThreshold = Number(
  healthSummary.functions_above_threshold ?? 0
);
const unusedFiles = Number(checkSummary.unused_files ?? 0);

if (!Number.isFinite(totalIssues)) {
  console.error("Fallow total issues not found in report JSON");
  process.exit(1);
}

if (!Number.isFinite(functionsAboveThreshold)) {
  console.error("Fallow functions above threshold not found in report JSON");
  process.exit(1);
}

if (!Number.isFinite(unusedFiles)) {
  console.error("Fallow unused files count not found in report JSON");
  process.exit(1);
}

const limits = {
  minimumMaintainability,
  maximumIssues,
  maximumFunctionsAboveThreshold,
  maximumUnusedFiles,
};

const failures = [];

if (roundedMaintainability < minimumMaintainability) {
  failures.push(
    `Fallow maintainability ${roundedMaintainability.toFixed(1)} is below the required ${minimumMaintainability.toFixed(1)}`
  );
}

if (maximumIssues !== undefined && totalIssues > maximumIssues) {
  failures.push(
    `Fallow total issues ${totalIssues} exceeds the allowed ${maximumIssues}`
  );
}

if (
  maximumFunctionsAboveThreshold !== undefined &&
  functionsAboveThreshold > maximumFunctionsAboveThreshold
) {
  failures.push(
    `Fallow functions above threshold ${functionsAboveThreshold} exceeds the allowed ${maximumFunctionsAboveThreshold}`
  );
}

if (maximumUnusedFiles !== undefined && unusedFiles > maximumUnusedFiles) {
  failures.push(
    `Fallow unused files ${unusedFiles} exceeds the allowed ${maximumUnusedFiles}`
  );
}

const output = {
  maintainability: roundedMaintainability,
  minimumMaintainability,
  totalIssues,
  functionsAboveThreshold,
  summary: checkSummary,
  limits,
  mode: "primary",
};

console.log(JSON.stringify(output, null, 2));

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}
