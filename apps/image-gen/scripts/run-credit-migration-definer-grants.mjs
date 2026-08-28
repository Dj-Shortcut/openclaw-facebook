import mysql from "mysql2/promise";

import { grantCreditMigrationDefinerPrivileges } from "./credit-migration-definer-grants.mjs";

async function main() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim();
  const provisionerUrl = process.env.DATABASE_PROVISIONER_URL?.trim();

  let migration;
  let provisioner;
  try {
    if (!migrationUrl || !provisionerUrl) {
      throw new Error(
        "credit migration definer grant configuration is missing"
      );
    }
    migration = await mysql.createConnection(migrationUrl);
    provisioner = await mysql.createConnection(provisionerUrl);
    await grantCreditMigrationDefinerPrivileges({ migration, provisioner });
    process.stdout.write("Credit migration definer grants verified.\n");
  } catch {
    process.stderr.write("Credit migration definer grants failed closed.\n");
    process.exitCode = 1;
  } finally {
    await migration?.end().catch(() => undefined);
    await provisioner?.end().catch(() => undefined);
  }
}

void main();
