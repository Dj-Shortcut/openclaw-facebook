import { describe, expect, it, vi } from "vitest";

import {
  CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
  CreditMigrationPrincipalCleanupError,
  buildCreditMigrationPrivilegeStatement,
  detectMissingCreditMigrationPrivileges,
  parseCreditMigrationAccount,
  repairCreditMigrationPrincipal,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";
import {
  classifyCreditMigrationHistory,
  executeRepair,
  parseCliArguments,
  runCli,
} from "./repair-image-gen-credit-migration-principal.mjs";

const ACCOUNT = Object.freeze({ hostname: "%", username: "credit_migrator" });
const DATABASE = "leaderbot";
const BASE_GRANTS = Object.freeze([
  "GRANT USAGE ON *.* TO `credit_migrator`@`%`",
  "GRANT CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE ON `leaderbot`.* TO `credit_migrator`@`%`",
  "GRANT DELETE ON `leaderbot`.`billing_intents` TO `credit_migrator`@`%`",
  "GRANT CREATE, DELETE ON `leaderbot`.`credit_wallets` TO `credit_migrator`@`%`",
]);

function migrationState(grants = BASE_GRANTS) {
  return {
    account: ACCOUNT,
    databaseName: DATABASE,
    grants: [...grants],
    requireSuper: false,
  };
}

function rootHarness({ failGrantAfterApply = false, failRevoke = false } = {}) {
  const statements = [];
  let state = migrationState();
  const root = {
    execute: vi.fn(async (statement) => {
      statements.push(statement);
      if (statement.startsWith("SELECT GET_LOCK")) return ["1"];
      if (statement.startsWith("SELECT COUNT(*) FROM mysql.user")) return ["1"];
      if (statement.startsWith("SELECT IS_USED_LOCK")) return ["1"];
      if (statement.startsWith("SELECT RELEASE_LOCK")) return ["1"];
      if (statement.startsWith("GRANT ")) {
        state = migrationState([
          ...BASE_GRANTS,
          "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO `credit_migrator`@`%`",
        ]);
        if (failGrantAfterApply) throw new Error("synthetic transport loss");
      }
      if (statement.startsWith("REVOKE") && failRevoke) {
        throw new Error("synthetic");
      }
      if (statement.startsWith("REVOKE")) state = migrationState();
      return [];
    }),
    initialize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    readState: vi.fn(async () => state),
    root,
    statements,
  };
}

describe("credit migration principal repair contract", () => {
  it("accepts only the exact private migration account shape", () => {
    expect(parseCreditMigrationAccount("credit_migrator@%")).toEqual(ACCOUNT);
    expect(() => parseCreditMigrationAccount("root@%")).toThrow();
    expect(() =>
      parseCreditMigrationAccount("credit_migrator@localhost"),
    ).toThrow();
    expect(() => parseCreditMigrationAccount("credit-migrator@%")).toThrow();
  });

  it("detects only the four approved missing schema rights", () => {
    expect(
      detectMissingCreditMigrationPrivileges({
        databaseName: DATABASE,
        grants: BASE_GRANTS,
        requireSuper: false,
      }),
    ).toEqual(["CREATE", "TRIGGER", "CREATE ROUTINE", "ALTER ROUTINE"]);
    expect(() =>
      detectMissingCreditMigrationPrivileges({
        databaseName: DATABASE,
        grants: BASE_GRANTS.filter((grant) => !grant.includes("REFERENCES")),
        requireSuper: false,
      }),
    ).toThrow();
  });

  it("treats an already complete exact boundary as idempotent", () => {
    expect(
      detectMissingCreditMigrationPrivileges({
        databaseName: DATABASE,
        grants: [
          ...BASE_GRANTS,
          "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO `credit_migrator`@`%`",
        ],
        requireSuper: false,
      }),
    ).toEqual([]);
  });

  it("builds only the exact grant and matching rollback statement", () => {
    const privileges = ["CREATE", "TRIGGER", "CREATE ROUTINE", "ALTER ROUTINE"];
    expect(
      buildCreditMigrationPrivilegeStatement({
        account: ACCOUNT,
        databaseName: DATABASE,
        operation: "grant",
        privileges,
      }),
    ).toBe(
      "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO 'credit_migrator'@'%'",
    );
    expect(
      buildCreditMigrationPrivilegeStatement({
        account: ACCOUNT,
        databaseName: DATABASE,
        operation: "revoke",
        privileges: ["TRIGGER", "ALTER ROUTINE"],
      }),
    ).toBe(
      "REVOKE TRIGGER, ALTER ROUTINE ON `leaderbot`.* FROM 'credit_migrator'@'%'",
    );
  });

  it("grants, verifies, and releases the private lock", async () => {
    const { readState, root, statements } = rootHarness();
    const verify = vi.fn(async () => undefined);
    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: false,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify,
        verifyRollback: vi.fn(),
      }),
    ).resolves.toBe("repaired");
    expect(verify).toHaveBeenCalledOnce();
    expect(statements).toContain(
      "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO 'credit_migrator'@'%'",
    );
    expect(statements.at(-1)).toContain("RELEASE_LOCK");
  });

  it("revokes only newly added rights when verification fails", async () => {
    const { readState, root, statements } = rootHarness();
    const verifyRollback = vi.fn(async () => undefined);
    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: false,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify: async () => {
          throw new Error("synthetic");
        },
        verifyRollback,
      }),
    ).rejects.toThrow("synthetic");
    expect(verifyRollback).toHaveBeenCalledWith([
      "CREATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
    ]);
    expect(statements).toContain(
      "REVOKE CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* FROM 'credit_migrator'@'%'",
    );
  });

  it("surfaces an incomplete rollback with a fixed error type", async () => {
    const { readState, root } = rootHarness({ failRevoke: true });
    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: false,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify: async () => {
          throw new Error("synthetic");
        },
        verifyRollback: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
  });

  it("observes and revokes a GRANT committed before transport loss", async () => {
    const { readState, root, statements } = rootHarness({
      failGrantAfterApply: true,
    });
    const verifyRollback = vi.fn(async () => undefined);
    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: false,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify: vi.fn(),
        verifyRollback,
      }),
    ).rejects.toThrow("synthetic transport loss");
    expect(statements).toContain(
      "REVOKE CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* FROM 'credit_migrator'@'%'",
    );
    expect(verifyRollback).toHaveBeenCalledWith([
      "CREATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
    ]);
  });

  it("reconnects under a fresh lock to roll back a committed uncertain GRANT", async () => {
    let state = migrationState();
    let disconnected = false;
    const firstRoot = {
      execute: vi.fn(async (statement) => {
        if (disconnected) throw new Error("connection lost");
        if (statement.startsWith("SELECT GET_LOCK")) return ["1"];
        if (statement.startsWith("SELECT COUNT(*) FROM mysql.user")) {
          return ["1"];
        }
        if (statement.startsWith("SELECT IS_USED_LOCK")) return ["1"];
        if (statement.startsWith("GRANT ")) {
          state = migrationState([
            ...BASE_GRANTS,
            "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO `credit_migrator`@`%`",
          ]);
          disconnected = true;
          throw new Error("connection lost");
        }
        return [];
      }),
    };
    const replacementStatements = [];
    const replacementRoot = {
      execute: vi.fn(async (statement) => {
        replacementStatements.push(statement);
        if (statement.startsWith("SELECT GET_LOCK")) return ["1"];
        if (statement.startsWith("SELECT COUNT(*) FROM mysql.user")) {
          return ["1"];
        }
        if (statement.startsWith("SELECT IS_USED_LOCK")) return ["1"];
        if (statement.startsWith("SELECT RELEASE_LOCK")) return ["1"];
        if (statement.startsWith("REVOKE ")) state = migrationState();
        return [];
      }),
    };
    const recoverRoot = vi.fn(async () => replacementRoot);
    const verifyRollback = vi.fn(async () => undefined);

    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: false,
        readState: vi.fn(async () => state),
        recoverRoot,
        root: firstRoot,
        verify: vi.fn(),
        verifyRollback,
      }),
    ).rejects.toThrow("connection lost");
    expect(recoverRoot).toHaveBeenCalledWith(firstRoot);
    expect(replacementStatements).toContain(
      "REVOKE CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* FROM 'credit_migrator'@'%'",
    );
    expect(verifyRollback).toHaveBeenCalledOnce();
  });

  it("makes the privilege decision only after acquiring the repair lock", async () => {
    const { readState, root, statements } = rootHarness();
    await repairCreditMigrationPrincipal({
      account: ACCOUNT,
      databaseName: DATABASE,
      requireSuper: false,
      readState,
      recoverRoot: vi.fn(async () => root),
      root,
      verify: vi.fn(async () => undefined),
      verifyRollback: vi.fn(),
    });
    expect(readState).toHaveBeenCalled();
    expect(statements[0]).toContain("GET_LOCK");
    expect(readState.mock.invocationCallOrder[0]).toBeGreaterThan(
      root.execute.mock.invocationCallOrder[2],
    );
  });
});

describe("credit migration principal repair resumability", () => {
  it.each(["0017_credit_wallet_expand", "0018_credit_checkout_reservation"])(
    "keeps %s verification-only and never opens root",
    async (phase) => {
      const connection = { end: vi.fn(async () => undefined) };
      const openRoot = vi.fn();
      const verifyRuntime = vi.fn(async () => undefined);
      await expect(
        executeRepair(
          {
            app: "leaderbot-portal-mysql",
            machineId: "080d3ddb5099e8",
          },
          {
            migrationUrl:
              "mysql://credit_migrator:secret@127.0.0.1:13306/leaderbot",
            mysql: {
              createConnection: vi.fn(async () => connection),
            },
            openRoot,
            readPhase: vi.fn(async () => phase),
            readState: vi.fn(async () =>
              migrationState([
                ...BASE_GRANTS,
                "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO `credit_migrator`@`%`",
              ]),
            ),
            signal: new AbortController().signal,
            verifyRuntime,
          },
        ),
      ).resolves.toBe("already_ready");
      expect(openRoot).not.toHaveBeenCalled();
      expect(verifyRuntime).toHaveBeenCalledWith(connection, "credit-expand");
      expect(connection.end).toHaveBeenCalledOnce();
    },
  );

  it("classifies only exact reviewed credit migration histories", () => {
    const contract = {
      version: 8,
      history0016: { rows: [16] },
      history0017: { rows: [16, 17] },
      history0018: { rows: [16, 17, 18] },
    };
    expect(classifyCreditMigrationHistory(contract, { rows: [16, 17] })).toBe(
      "0017_credit_wallet_expand",
    );
    expect(() =>
      classifyCreditMigrationHistory(contract, { rows: [16, 18] }),
    ).toThrow();
  });
});

describe("credit migration principal repair CLI", () => {
  it("requires the exact database app and one Machine", () => {
    expect(
      parseCliArguments([
        "--database-app",
        "leaderbot-portal-mysql",
        "--database-machine-id",
        "080d3ddb5099e8",
      ]),
    ).toEqual({
      app: "leaderbot-portal-mysql",
      machineId: "080d3ddb5099e8",
    });
    expect(() =>
      parseCliArguments([
        "--database-app",
        "other",
        "--database-machine-id",
        "080d3ddb5099e8",
      ]),
    ).toThrow();
  });

  it("prints only fixed success or failure markers", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(
      runCli(
        [
          "--database-app",
          "leaderbot-portal-mysql",
          "--database-machine-id",
          "080d3ddb5099e8",
        ],
        { execute: vi.fn(async () => "repaired") },
      ),
    ).resolves.toBe(CREDIT_MIGRATION_PRINCIPAL_READY_MARKER);
    expect(output).toHaveBeenLastCalledWith(
      `${CREDIT_MIGRATION_PRINCIPAL_READY_MARKER}\n`,
    );
    output.mockClear();
    await expect(runCli([], { execute: vi.fn() })).resolves.toBe(
      CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
    );
    expect(output).toHaveBeenLastCalledWith(
      `${CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER}\n`,
    );
    output.mockRestore();
  });

  it("keeps the cleanup-incomplete marker distinct", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(
      runCli(
        [
          "--database-app",
          "leaderbot-portal-mysql",
          "--database-machine-id",
          "080d3ddb5099e8",
        ],
        {
          execute: vi.fn(async () => {
            throw new CreditMigrationPrincipalCleanupError();
          }),
        },
      ),
    ).resolves.toBe(CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER);
    expect(output).toHaveBeenLastCalledWith(
      `${CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER}\n`,
    );
    output.mockRestore();
  });
});
