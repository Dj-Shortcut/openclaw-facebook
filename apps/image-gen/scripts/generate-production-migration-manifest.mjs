/* global process */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProductionMigrationPlan } from "./production-migration-plan.mjs";
import { sha256 } from "./production-schema-contract.mjs";

const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const drizzleDirectory = path.join(appDirectory, "drizzle");
const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
const baseSchemaSnapshot = "meta/0014_snapshot.json";
const schemaSnapshot = "meta/0017_snapshot.json";
const productionSchemaContract = "production-schema-contract.json";
const outputPath = path.join(drizzleDirectory, "migration-manifest.json");

const [journalRaw, baseSnapshotRaw, snapshotRaw, contractRaw, files] =
  await Promise.all([
    fs.readFile(journalPath, "utf8"),
    fs.readFile(path.join(drizzleDirectory, baseSchemaSnapshot), "utf8"),
    fs.readFile(path.join(drizzleDirectory, schemaSnapshot), "utf8"),
    fs.readFile(path.join(drizzleDirectory, productionSchemaContract), "utf8"),
    fs.readdir(drizzleDirectory),
  ]);
const journal = JSON.parse(journalRaw);
const migrationFiles = files
  .filter(name => /^\d{4}_.+\.sql$/.test(name))
  .sort();
if (
  !Array.isArray(journal.entries) ||
  journal.entries.length !== migrationFiles.length
) {
  throw new Error("journal and migration file count mismatch");
}
const migrations = await Promise.all(
  journal.entries.map(async (entry, index) => {
    const file = `${entry.tag}.sql`;
    if (
      entry.idx !== index ||
      migrationFiles[index] !== file ||
      !Number.isSafeInteger(Number(entry.when))
    ) {
      throw new Error(`journal entry mismatch for ${entry.tag}`);
    }
    return {
      idx: index,
      when: Number(entry.when),
      tag: entry.tag,
      sha256: sha256(
        await fs.readFile(path.join(drizzleDirectory, file), "utf8")
      ),
    };
  })
);
resolveProductionMigrationPlan(migrations);

const manifest = {
  version: 1,
  journalSha256: sha256(journalRaw),
  baseSchemaSnapshot,
  baseSchemaSnapshotSha256: sha256(baseSnapshotRaw),
  schemaSnapshot,
  schemaSnapshotSha256: sha256(snapshotRaw),
  productionSchemaContract,
  productionSchemaContractSha256: sha256(contractRaw),
  migrations,
};
await fs.writeFile(
  outputPath,
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
process.stdout.write(
  `Generated ${path.relative(appDirectory, outputPath)} with ${migrations.length} migrations.\n`
);
