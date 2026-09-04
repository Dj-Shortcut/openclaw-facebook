/* global process */
import fs from "node:fs";
import path from "node:path";
import {
  productionMigrationOptionsForMode,
  runProductionMigrations,
} from "./migrate-production.mjs";

const configuredMode =
  process.env.LEADERBOT_PRODUCTION_MIGRATION_MODE?.trim() ?? "";
const migrationMode = configuredMode;
const artifactKindPath = path.resolve(
  path.dirname(process.argv[1] ?? ""),
  "..",
  ".leaderbot-artifact-kind"
);
let artifactKind = "";
const legacyArtifactBoundMode =
  migrationMode === "verify-artifact" || migrationMode === "apply-expand";
const artifactBoundMode =
  legacyArtifactBoundMode ||
  migrationMode === "apply-credit-wallet-expand" ||
  migrationMode === "verify-credit-wallet-transition";
if (artifactBoundMode) {
  try {
    artifactKind = fs.readFileSync(artifactKindPath, "utf8").trim();
  } catch {
    artifactKind = "";
  }
}

const options = productionMigrationOptionsForMode(migrationMode, artifactKind);
const testOnlyBootstrapAllowed =
  !new Set([
    "apply-empty-bootstrap",
    "apply-empty-credit-wallet-bootstrap",
    "apply-empty-credit-offer-bootstrap",
  ]).has(migrationMode) ||
  (process.env.NODE_ENV === "test" &&
    process.env.LEADERBOT_ALLOW_TEST_SCHEMA_BOOTSTRAP === "1");

if (!options || !testOnlyBootstrapAllowed) {
  process.stderr.write(
    "Production migration refused: set LEADERBOT_PRODUCTION_MIGRATION_MODE to an explicit staged mode.\n"
  );
  process.exitCode = 1;
} else {
  runProductionMigrations(options)
    .then(result => {
      process.stdout.write(
        result.inspectionOnly
          ? `Production schema ${result.schemaPhase} inspected.\n`
          : `Production schema ${result.schemaPhase} verified (${result.appliedCount} applied).\n`
      );
    })
    .catch(error => {
      process.stderr.write(
        `Production migration refused: ${error instanceof Error ? error.message : "unknown error"}\n`
      );
      process.exitCode = 1;
    });
}
