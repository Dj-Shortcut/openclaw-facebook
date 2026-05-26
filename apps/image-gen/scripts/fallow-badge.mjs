import fs from "node:fs";
import path from "node:path";

const [inputPath, badgePath, metricsPath] = process.argv.slice(2);

if (!inputPath || !badgePath || !metricsPath) {
  console.error(
    "Usage: node scripts/fallow-badge.mjs <report.json> <badge.json> <metrics.json>"
  );
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
const report = JSON.parse(raw);
const summary = report.check?.summary ?? report.summary;
const healthSummary = report.health?.summary;

if (!summary) {
  console.error("Fallow summary not found in report JSON");
  process.exit(1);
}

const averageMaintainability = Number(healthSummary?.average_maintainability);

if (!Number.isFinite(averageMaintainability)) {
  console.error("Fallow native maintainability not found in report JSON");
  process.exit(1);
}

const score = Number(averageMaintainability.toFixed(1));

function getColor(value) {
  if (value >= 85) return "brightgreen";
  if (value >= 70) return "green";
  if (value >= 55) return "yellowgreen";
  if (value >= 40) return "yellow";
  if (value >= 25) return "orange";
  return "red";
}

const totalIssues = Number(report.check?.total_issues ?? report.total_issues ?? 0);
const version = report.version ?? report.check?.version ?? "unknown";
const functionsAboveThreshold = Number(
  healthSummary?.functions_above_threshold ?? 0
);
const functionsAnalyzed = Number(healthSummary?.functions_analyzed ?? 0);
const filesScored = Number(healthSummary?.files_scored ?? 0);
const coverageModel = healthSummary?.coverage_model ?? "unknown";

const badge = {
  schemaVersion: 1,
  label: "fallow maintainability",
  message: score.toFixed(1),
  color: getColor(score),
};

const metrics = {
  generatedAt: new Date().toISOString(),
  fallowVersion: version,
  totalIssues,
  functionsAboveThreshold,
  functionsAnalyzed,
  filesScored,
  coverageModel,
  maintainabilityScore: score,
  formula: "native Fallow average_maintainability",
  summary,
  healthSummary,
};

fs.mkdirSync(path.dirname(badgePath), { recursive: true });
fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
fs.writeFileSync(badgePath, `${JSON.stringify(badge, null, 2)}\n`);
fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      badge,
      metrics: {
        totalIssues,
        functionsAboveThreshold,
        maintainabilityScore: score,
      },
    },
    null,
    2
  )
);
