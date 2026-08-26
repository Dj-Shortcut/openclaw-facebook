/* global process */
import mysql from "mysql2/promise";

import {
  assertBillingTriggerRuntimePreflight,
  billingTriggerPreflightPublicErrorCode,
} from "./billing-trigger-runtime-preflight.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
const mode = process.env.MOLLIE_MODE?.trim();

async function main() {
  if (!databaseUrl || !mode) {
    process.stderr.write(
      "Billing trigger runtime preflight refused: configuration.\n"
    );
    process.exitCode = 1;
    return;
  }

  let connection;
  try {
    connection = await mysql.createConnection(databaseUrl);
    await assertBillingTriggerRuntimePreflight(connection, mode);
    process.stdout.write("Billing trigger runtime preflight passed.\n");
  } catch (error) {
    process.stderr.write(
      `Billing trigger runtime preflight refused: ${billingTriggerPreflightPublicErrorCode(error)}.\n`
    );
    process.exitCode = 1;
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        process.exitCode = 1;
      }
    }
  }
}

void main();
