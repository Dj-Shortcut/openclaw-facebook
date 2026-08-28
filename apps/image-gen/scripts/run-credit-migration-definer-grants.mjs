import mysql from "mysql2/promise";

import { grantCreditMigrationDefinerPrivileges } from "./credit-migration-definer-grants.mjs";

const FAILURE_REASON = Object.freeze({
  configuration: "configuration_invalid",
  grantVerification: "grant_verification_failed",
  migrationConnection: "migration_connection_failed",
  provisionerConnection: "provisioner_connection_failed",
});

async function main() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim();
  const provisionerUrl = process.env.DATABASE_PROVISIONER_URL?.trim();

  let migration;
  let provisioner;
  let failureReason = FAILURE_REASON.configuration;
  try {
    if (!migrationUrl || !provisionerUrl) {
      throw new Error(
        "credit migration definer grant configuration is missing"
      );
    }
    failureReason = FAILURE_REASON.migrationConnection;
    migration = await mysql.createConnection(migrationUrl);
    failureReason = FAILURE_REASON.provisionerConnection;
    provisioner = await mysql.createConnection(provisionerUrl);
    failureReason = FAILURE_REASON.grantVerification;
    await grantCreditMigrationDefinerPrivileges({ migration, provisioner });
    process.stdout.write("Credit migration definer grants verified.\n");
  } catch {
    process.stderr.write(
      `Credit migration definer grants failed closed. Reason: ${failureReason}.\n`
    );
    process.exitCode = 1;
  } finally {
    await migration?.end().catch(() => undefined);
    await provisioner?.end().catch(() => undefined);
  }
}

void main();
