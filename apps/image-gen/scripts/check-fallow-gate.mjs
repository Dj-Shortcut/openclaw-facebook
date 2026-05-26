import fs from "node:fs";

const [reportPath] = process.argv.slice(2);

if (!reportPath) {
  console.error("Usage: node scripts/check-fallow-gate.mjs <report.json>");
  process.exit(1);
}

const minimumMaintainability = Number(process.env.FALLOW_MIN_SCORE ?? 85);

if (!Number.isFinite(minimumMaintainability)) {
  console.error("FALLOW_MIN_SCORE must be a number");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8").replace(/^\uFEFF/, ""));
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
const totalIssues = Number(report.check?.total_issues ?? report.total_issues ?? 0);

if (roundedMaintainability < minimumMaintainability) {
  console.error(
    `Fallow maintainability ${roundedMaintainability.toFixed(1)} is below the required ${minimumMaintainability.toFixed(1)}`
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      maintainability: roundedMaintainability,
      minimumMaintainability,
      totalIssues,
      mode: "primary",
    },
    null,
    2
  )
);
