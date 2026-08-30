import {
  assertCreditProvisionerGrantScope,
  assertProductionMigrationRuntime,
} from "./production-schema-contract.mjs";

function parseCurrentAccount(value) {
  const match = /^([A-Za-z0-9_]{1,32})@([A-Za-z0-9_.:%-]{1,255})$/.exec(
    String(value ?? "")
  );
  if (!match) {
    throw new Error("database account identity is unsupported");
  }
  return { hostname: match[2], username: match[1] };
}

function quotedAccount(connection, account) {
  return `${connection.escape(account.username)}@${connection.escape(account.hostname)}`;
}

export async function grantCreditMigrationDefinerPrivileges({
  migration,
  provisioner,
}) {
  const [[migrationIdentity]] = await migration.query(
    "SELECT CURRENT_USER() AS account,DATABASE() AS databaseName"
  );
  const [[provisionerIdentity]] = await provisioner.query(
    "SELECT CURRENT_USER() AS account,DATABASE() AS databaseName"
  );
  const migrationAccount = parseCurrentAccount(migrationIdentity?.account);
  const provisionerAccount = parseCurrentAccount(provisionerIdentity?.account);
  const databaseName = String(migrationIdentity?.databaseName ?? "");
  if (
    !/^[a-z][a-z0-9_]*$/.test(databaseName) ||
    provisionerIdentity?.databaseName !== databaseName ||
    (migrationAccount.username === provisionerAccount.username &&
      migrationAccount.hostname === provisionerAccount.hostname)
  ) {
    throw new Error("credit migration database identity is invalid");
  }

  const [provisionerGrantRows] = await provisioner.query(
    "SHOW GRANTS FOR CURRENT_USER()"
  );
  assertCreditProvisionerGrantScope(
    provisionerGrantRows.flatMap(row => Object.values(row).map(String)),
    databaseName
  );

  const [[baseTable]] = await migration.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND `TABLE_NAME`='billing_intents'"
  );
  if (Number(baseTable?.count) !== 1) {
    throw new Error("credit migration base table is unavailable");
  }

  const schema = provisioner.escapeId(databaseName);
  const account = quotedAccount(provisioner, migrationAccount);
  await provisioner.query(
    `GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON ${schema}.* TO ${account}`
  );
  await provisioner.query(
    `GRANT DELETE ON ${schema}.${provisioner.escapeId("billing_intents")} TO ${account}`
  );
  await provisioner.query(
    `GRANT CREATE, DELETE ON ${schema}.${provisioner.escapeId("credit_wallets")} TO ${account}`
  );

  await assertProductionMigrationRuntime(migration, "credit-expand");
}
