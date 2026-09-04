import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  runtime: vi.fn(),
  history: vi.fn(),
  schema: vi.fn(),
}));
vi.mock("mysql2/promise", () => ({
  default: { createConnection: mocks.connect },
}));
vi.mock("./production-schema-contract.mjs", async importOriginal => ({
  ...(await importOriginal()),
  assertProductionMigrationRuntime: mocks.runtime,
  captureMigrationHistory: mocks.history,
  captureProductionSchemaState: mocks.schema,
}));

import {
  loadAndVerifyMigrationManifest,
  migrationLockName,
  productionMigrationOptionsForMode,
  runProductionMigrations,
  schemaCapturePlanForPrivilege,
} from "./migrate-production.mjs";

const { productionContract, migrationPlan } =
  await loadAndVerifyMigrationManifest();
const { contract, schemaCaptureOptions } = schemaCapturePlanForPrivilege(
  productionContract,
  "credit-expand"
);
const options = productionMigrationOptionsForMode(
  "apply-credit-offer",
  "migration-bridge"
);
const databaseUrl = "mysql://unused@127.0.0.1:1/credit_offer_test";
const lockName = migrationLockName("credit_offer_test");
const migrationStatements = (
  await fs.readFile(
    new URL(
      `../drizzle/${migrationPlan.creditOffer0019.tag}.sql`,
      import.meta.url
    ),
    "utf8"
  )
)
  .split("--> statement-breakpoint")
  .map(statement => statement.trim())
  .filter(Boolean);
let connection;

beforeEach(() => {
  vi.clearAllMocks();
  connection = {
    query: vi.fn(async sql => {
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }]];
      return [];
    }),
    end: vi.fn(),
  };
  mocks.connect.mockResolvedValue(connection);
  mocks.runtime.mockResolvedValue({ databaseName: "credit_offer_test" });
  mocks.history.mockResolvedValue(structuredClone(contract.history0019));
  mocks.schema.mockResolvedValue(structuredClone(contract.final0019));
});

function apply(overrides = {}) {
  return runProductionMigrations({ ...options, databaseUrl, ...overrides });
}

function expectNoMigrationWrites() {
  expect(connection.query.mock.calls).toEqual([
    ["SELECT GET_LOCK(?,?) AS acquired", [lockName, 30]],
    ["SELECT RELEASE_LOCK(?) AS released", [lockName]],
  ]);
  expect(connection.end).toHaveBeenCalledOnce();
}

describe("explicit production credit-offer mode", () => {
  it("requires the bridge and preserves the existing 0018 apply mode", () => {
    expect(options).toEqual({
      verifyOnly: false,
      target: "credit-offer",
      creditOfferTransition: true,
      privilegeProfile: "credit-expand",
    });
    for (const kind of ["", "runtime", "unknown"]) {
      expect(
        productionMigrationOptionsForMode("apply-credit-offer", kind)
      ).toBeNull();
    }
    expect(
      productionMigrationOptionsForMode(
        "apply-credit-wallet-expand",
        "migration-bridge"
      )
    ).toEqual({
      verifyOnly: false,
      target: "credit-wallet",
      privilegeProfile: "credit-expand",
    });
  });

  it.each([
    { creditOfferTransition: "true" },
    { verifyOnly: true },
    { target: "credit-wallet" },
    { allowEmptyBootstrap: true },
    { privilegeProfile: "credit-bootstrap" },
    { privilegeProfile: "bootstrap" },
    { privilegeProfile: "credit-runtime" },
  ])(
    "rejects unsafe option overrides before connecting: %j",
    async override => {
      await expect(apply(override)).rejects.toThrow("credit-offer transition");
      expect(mocks.connect).not.toHaveBeenCalled();
    }
  );

  it("is a write-free no-op only for exact 0019", async () => {
    await expect(apply()).resolves.toMatchObject({
      appliedCount: migrationPlan.through0019.length,
      schemaPhase: "0019_credit_offer_v2",
    });
    expect(mocks.runtime).toHaveBeenCalledWith(connection, "credit-expand");
    expect(mocks.schema).toHaveBeenCalledWith(connection, schemaCaptureOptions);
    expectNoMigrationWrites();
  });

  it.each([0, 1, 2, 3, 4])(
    "applies only the remaining 0019 statements at exact boundary %i",
    async boundary => {
      mocks.history.mockResolvedValueOnce(
        structuredClone(contract.history0018)
      );
      mocks.schema.mockResolvedValueOnce(
        structuredClone(contract.partial0019CreditOffer.states[boundary].schema)
      );
      await expect(apply()).resolves.toMatchObject({
        appliedCount: migrationPlan.through0019.length,
        schemaPhase: "0019_credit_offer_v2",
      });
      const statements = connection.query.mock.calls.map(([sql]) => sql);
      expect(statements.slice(1, -2)).toEqual(
        migrationStatements.slice(boundary)
      );
      expect(statements.at(-2)).toMatch(/^INSERT INTO `__drizzle_migrations`/);
      expect(connection.query.mock.calls.at(-2)[1]).toEqual([
        migrationPlan.creditOffer0019.sha256,
        migrationPlan.creditOffer0019.when,
      ]);
      expect(statements[0]).toMatch(/^SELECT GET_LOCK/);
      expect(statements.at(-1)).toMatch(/^SELECT RELEASE_LOCK/);
      expect(connection.end).toHaveBeenCalledOnce();
    }
  );

  const earlierStates = [
    ["empty", null, { tables: {}, views: {}, triggers: {}, routines: {} }],
    ["0014", contract.baseHistory, contract.base0014],
    ["0015", contract.history0015, contract.final0015],
    ["0016", contract.history0016, contract.final0016],
    ["0017", contract.history0017, contract.final0017],
    [
      "partial 0018",
      contract.history0017,
      contract.partial0018CreditCheckout.states[1].schema,
    ],
  ];
  it.each(earlierStates)(
    "refuses %s without applying earlier migrations",
    async (_label, history, schema) => {
      mocks.history.mockResolvedValueOnce(structuredClone(history));
      mocks.schema.mockResolvedValueOnce(structuredClone(schema));
      await expect(apply()).rejects.toThrow(
        "credit-offer transition requires exact 0018"
      );
      expectNoMigrationWrites();
    }
  );

  it.each([
    [
      "missing history",
      history => {
        history.rows = [];
      },
    ],
    [
      "history row hash",
      history => {
        history.rows[18].hash = "0".repeat(64);
      },
    ],
    [
      "history shape",
      history => {
        history.showCreateSha256 = "0".repeat(64);
      },
    ],
    [
      "history counter",
      history => {
        history.nextId += 1;
      },
    ],
    [
      "later migration",
      history => {
        history.rows.push({ id: 21, hash: "0".repeat(64), createdAt: 1 });
      },
    ],
    [
      "unknown table",
      (_history, schema) => {
        schema.tables.unexpected = "0".repeat(64);
      },
    ],
    [
      "changed routine",
      (_history, schema) => {
        schema.routines.credit_reserve_checkout_intent = "0".repeat(64);
      },
    ],
  ])("refuses %s drift without writes", async (_label, mutate) => {
    const history = structuredClone(contract.history0019);
    const schema = structuredClone(contract.final0019);
    mutate(history, schema);
    mocks.history.mockResolvedValueOnce(history);
    mocks.schema.mockResolvedValueOnce(schema);
    await expect(apply()).rejects.toThrow();
    expectNoMigrationWrites();
  });

  it("rejects unrecognized interrupted-0019 state instead of guessing a prefix", async () => {
    const schema = structuredClone(
      contract.partial0019CreditOffer.states[1].schema
    );
    schema.routines.credit_freeze_wallet_for_review = "0".repeat(64);
    mocks.history.mockResolvedValueOnce(structuredClone(contract.history0018));
    mocks.schema.mockResolvedValueOnce(schema);
    await expect(apply()).rejects.toThrow(
      "0019 partial schema fingerprint mismatch"
    );
    expectNoMigrationWrites();
  });

  it("never inspects or applies when the singleton lock is unavailable", async () => {
    connection.query.mockResolvedValueOnce([[{ acquired: 0 }]]);
    await expect(apply()).rejects.toThrow(
      "migration singleton lock is unavailable"
    );
    expect(mocks.schema).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenCalledOnce();
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("does not insert history after a failed DDL statement", async () => {
    mocks.history.mockResolvedValueOnce(structuredClone(contract.history0018));
    mocks.schema.mockResolvedValueOnce(structuredClone(contract.final0018));
    connection.query.mockImplementation(async sql => {
      if (sql.startsWith("SELECT GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.startsWith("SELECT RELEASE_LOCK")) return [[{ released: 1 }]];
      throw new Error("simulated DDL failure");
    });
    await expect(apply()).rejects.toThrow("simulated DDL failure");
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT GET_LOCK(?,?) AS acquired",
      migrationStatements[0],
      "SELECT RELEASE_LOCK(?) AS released",
    ]);
    expect(connection.end).toHaveBeenCalledOnce();
  });
});

describe("credit-offer runner artifact binding", () => {
  it.each(["migration-bridge", "runtime", "unknown", null])(
    "reads the artifact marker and fails closed for %s",
    async kind => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "credit-offer-runner-")
      );
      try {
        const scripts = path.join(directory, "scripts");
        await fs.mkdir(scripts);
        const runner = path.join(scripts, "run-production-migrations.mjs");
        await fs.copyFile(
          new URL("./run-production-migrations.mjs", import.meta.url),
          runner
        );
        // Exercise the actual runner and mode resolver, but never open a database.
        await fs.writeFile(
          path.join(scripts, "migrate-production.mjs"),
          `
          export { productionMigrationOptionsForMode } from ${JSON.stringify(new URL("./migrate-production.mjs", import.meta.url).href)};
          export async function runProductionMigrations(options) {
            if (JSON.stringify(options) !== ${JSON.stringify(JSON.stringify(options))}) throw new Error("unexpected mode options");
            return { schemaPhase: "0019_credit_offer_v2", appliedCount: 20 };
          }
        `
        );
        if (kind !== null) {
          await fs.writeFile(
            path.join(directory, ".leaderbot-artifact-kind"),
            `${kind}\n`
          );
        }
        const result = await promisify(execFile)(process.execPath, [runner], {
          env: {
            ...process.env,
            NODE_ENV: "production",
            DATABASE_URL: "",
            LEADERBOT_PRODUCTION_MIGRATION_MODE: "apply-credit-offer",
          },
        }).catch(error => error);
        if (kind === "migration-bridge") {
          expect(result.stderr).toBe("");
          expect(result.stdout).toBe(
            "Production schema 0019_credit_offer_v2 verified (20 applied).\n"
          );
        } else {
          expect(result.code).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toBe(
            "Production migration refused: set LEADERBOT_PRODUCTION_MIGRATION_MODE to an explicit staged mode.\n"
          );
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  );
});
