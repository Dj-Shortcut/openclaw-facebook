import { randomUUID } from "node:crypto";

import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertBillingTriggerRuntimePreflight } from "../scripts/billing-trigger-runtime-preflight.mjs";
import {
  creditWalletRoutineNames,
  productionRuntimeWritableTableNames,
} from "../scripts/production-schema-contract.mjs";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);

suite("billing trigger MySQL runtime boundary", () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await connection?.end();
  });

  it("executes every retained billing trigger and rolls back all probe data", async () => {
    const [[database]] = await connection.query<RowDataPacket[]>(
      "SELECT DATABASE() AS databaseName"
    );
    const databaseName = String(database.databaseName ?? "");
    expect(databaseName).not.toBe("");

    const runtimeUser = `lb_ci_rt_${process.pid}_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 8)}`;
    const runtimePassword = randomUUID().replaceAll("-", "");
    const databaseIdentifier = mysql.escapeId(databaseName);
    let runtimePrincipalCreated = false;

    try {
      await connection.query(
        `CREATE USER \`${runtimeUser}\`@'%' IDENTIFIED BY '${runtimePassword}'`
      );
      runtimePrincipalCreated = true;
      await connection.query(
        `GRANT SELECT ON ${databaseIdentifier}.* TO \`${runtimeUser}\`@'%'`
      );
      for (const tableName of productionRuntimeWritableTableNames) {
        await connection.query(
          `GRANT INSERT, UPDATE, DELETE ON ${databaseIdentifier}.${mysql.escapeId(tableName)} TO \`${runtimeUser}\`@'%'`
        );
      }
      for (const routineName of creditWalletRoutineNames) {
        await connection.query(
          `GRANT EXECUTE ON PROCEDURE ${databaseIdentifier}.${mysql.escapeId(routineName)} TO \`${runtimeUser}\`@'%'`
        );
      }

      const runtimeUrl = new URL(process.env.DATABASE_URL!);
      runtimeUrl.username = runtimeUser;
      runtimeUrl.password = runtimePassword;
      const runtimeConnection = await mysql.createConnection(runtimeUrl.href);
      try {
        await assertBillingTriggerRuntimePreflight(runtimeConnection, "test");
      } finally {
        await runtimeConnection.end();
      }
    } finally {
      if (runtimePrincipalCreated) {
        await connection.query(`DROP USER \`${runtimeUser}\`@'%'`);
      }
    }
  });
});
