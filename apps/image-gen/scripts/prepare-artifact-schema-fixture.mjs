/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { loadAndVerifyMigrationManifest } from "./migrate-production.mjs";
import { assertProductionMigrationRuntime } from "./production-schema-contract.mjs";

if (
  process.env.NODE_ENV !== "test" ||
  process.env.LEADERBOT_ALLOW_TEST_SCHEMA_FIXTURE !== "1"
) {
  throw new Error("artifact schema fixture is test-only");
}

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
const databaseName = databaseUrl.pathname.slice(1);
if (
  !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
  !/^leaderbot_artifact_(?:base|expand)$/.test(databaseName)
) {
  throw new Error(
    "artifact schema fixture requires a disposable local database"
  );
}

const phase = process.env.LEADERBOT_TEST_SCHEMA_PHASE;
if (!new Set(["0015_base", "0016_expand"]).has(phase)) {
  throw new Error(
    "artifact schema fixture phase must be 0015_base or 0016_expand"
  );
}

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const { migrations } = await loadAndVerifyMigrationManifest();
const migrationCount =
  phase === "0015_base" ? migrations.length - 2 : migrations.length - 1;
const connection = await mysql.createConnection(databaseUrl.toString());

try {
  await assertProductionMigrationRuntime(connection);
  const [[state]] = await connection.query(
    "SELECT COUNT(*) AS tableCount FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
  );
  if (Number(state.tableCount) !== 0) {
    throw new Error("artifact schema fixture database must be empty");
  }
  await connection.query(
    "CREATE TABLE `__drizzle_migrations` (`id` serial PRIMARY KEY,`hash` text NOT NULL,`created_at` bigint)"
  );
  for (const migration of migrations.slice(0, migrationCount)) {
    const sql = await fs.readFile(
      path.join(appDirectory, "drizzle", `${migration.tag}.sql`),
      "utf8"
    );
    const statements = sql
      .split("--> statement-breakpoint")
      .map(statement => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await connection.query(statement);
    }
    await connection.query(
      "INSERT INTO `__drizzle_migrations` (`hash`,`created_at`) VALUES (?,?)",
      [migration.sha256, Number(migration.when)]
    );
  }
  process.stdout.write(
    `Prepared disposable ${phase} artifact schema fixture.\n`
  );
} finally {
  await connection.end();
}
