import { describe, expect, it, vi } from "vitest";

import {
  CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER,
  CreditMigrationPrincipalCleanupError,
  assertCreditMigrationSuperCleanupBoundary,
  buildCreditMigrationPrivilegeStatement,
  buildCreditMigrationPrivilegeStatements,
  detectMissingCreditMigrationPrivileges,
  hasCreditMigrationGlobalSuper,
  parseCreditMigrationAccount,
  repairCreditMigrationPrincipal,
  revokeTemporaryCreditMigrationSuper,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";
import {
  classifyCreditMigrationHistory,
  executeRepair,
  executeSuperCleanup,
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

const COMPLETE_SCHEMA_GRANT =
  "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO `credit_migrator`@`%`";
const SUPER_GRANT = "GRANT SUPER ON *.* TO `credit_migrator`@`%`";
const POST_DDL_GRANTS = Object.freeze([
  ...BASE_GRANTS,
  COMPLETE_SCHEMA_GRANT,
  "GRANT EXECUTE ON PROCEDURE `leaderbot`.`credit_create_wallet` TO `credit_migrator`@`%`",
]);
const INVALID_CLEANUP_GRANTS = [
  ["a different SUPER-only account", [SUPER_GRANT]],
  [
    "global administration",
    ["GRANT ALL PRIVILEGES ON *.* TO `credit_migrator`@`%`"],
  ],
  [
    "excess global rights",
    [
      ...BASE_GRANTS,
      SUPER_GRANT,
      "GRANT PROCESS ON *.* TO `credit_migrator`@`%`",
    ],
  ],
  [
    "excess schema rights",
    [
      ...BASE_GRANTS,
      SUPER_GRANT,
      "GRANT DELETE ON `leaderbot`.* TO `credit_migrator`@`%`",
    ],
  ],
  ["grant delegation", [...BASE_GRANTS, `${SUPER_GRANT} WITH GRANT OPTION`]],
  [
    "a missing non-repairable base right",
    [
      ...BASE_GRANTS.map((grant) => grant.replace("REFERENCES, ", "")),
      SUPER_GRANT,
    ],
  ],
  [
    "an unreviewed routine",
    [
      ...BASE_GRANTS,
      SUPER_GRANT,
      "GRANT EXECUTE ON PROCEDURE `leaderbot`.`other_helper` TO `credit_migrator`@`%`",
    ],
  ],
];

function migrationState(grants = BASE_GRANTS, requireSuper = false) {
  return {
    account: ACCOUNT,
    databaseName: DATABASE,
    grants: [...grants],
    requireSuper,
  };
}

function rootHarness({
  failGrantAfterApply = false,
  failGrantAfterApplyAt,
  failRevoke = false,
  initialGrants = BASE_GRANTS,
  requireSuper = false,
} = {}) {
  const statements = [];
  let state = migrationState(initialGrants, requireSuper);
  let appliedGrantCount = 0;
  const root = {
    execute: vi.fn(async (statement) => {
      statements.push(statement);
      if (statement.startsWith("SELECT GET_LOCK")) return ["1"];
      if (statement.startsWith("SELECT COUNT(*) FROM mysql.user")) return ["1"];
      if (statement.startsWith("SELECT IS_USED_LOCK")) return ["1"];
      if (statement.startsWith("SELECT RELEASE_LOCK")) return ["1"];
      if (statement.startsWith("GRANT ")) {
        const grants = [...state.grants];
        if (statement.includes(" ON *.* ")) grants.push(SUPER_GRANT);
        else grants.push(COMPLETE_SCHEMA_GRANT);
        state = migrationState([...new Set(grants)], requireSuper);
        appliedGrantCount += 1;
        if (
          (failGrantAfterApply && appliedGrantCount === 1) ||
          appliedGrantCount === failGrantAfterApplyAt
        ) {
          throw new Error("synthetic transport loss");
        }
      }
      if (statement.startsWith("REVOKE") && failRevoke) {
        throw new Error("synthetic");
      }
      if (statement.startsWith("REVOKE")) {
        state = migrationState(
          state.grants.filter((grant) =>
            statement.includes(" ON *.* ")
              ? grant !== SUPER_GRANT
              : grant !== COMPLETE_SCHEMA_GRANT,
          ),
          requireSuper,
        );
      }
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

function postDdlPrepareHarness(phase, rootOptions = {}) {
  const harness = rootHarness({
    initialGrants: POST_DDL_GRANTS,
    requireSuper: true,
    ...rootOptions,
  });
  const connection = { end: vi.fn(async () => undefined) };
  const options = {
    migrationUrl: "mysql://credit_migrator:secret@127.0.0.1:13306/leaderbot",
    mysql: { createConnection: vi.fn(async () => connection) },
    openRoot: vi.fn(async () => harness.root),
    readPhase: vi.fn(async () => phase),
    readState: harness.readState,
    signal: new AbortController().signal,
    verifyRuntime: vi.fn(async () => undefined),
  };
  return {
    ...harness,
    connection,
    options,
    prepare: () =>
      executeRepair(
        { app: "leaderbot-portal-mysql", machineId: "080d3ddb5099e8" },
        options,
      ),
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

  it("detects conditional global SUPER only when binary logging requires it", () => {
    expect(
      detectMissingCreditMigrationPrivileges({
        databaseName: DATABASE,
        grants: BASE_GRANTS,
        requireSuper: true,
      }),
    ).toEqual([
      "CREATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
      "SUPER",
    ]);
    expect(
      detectMissingCreditMigrationPrivileges({
        databaseName: DATABASE,
        grants: [...BASE_GRANTS, COMPLETE_SCHEMA_GRANT, SUPER_GRANT],
        requireSuper: true,
      }),
    ).toEqual([]);
    expect(hasCreditMigrationGlobalSuper([...BASE_GRANTS, SUPER_GRANT])).toBe(
      true,
    );
    expect(hasCreditMigrationGlobalSuper(BASE_GRANTS)).toBe(false);
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
    expect(
      buildCreditMigrationPrivilegeStatements({
        account: ACCOUNT,
        databaseName: DATABASE,
        operation: "grant",
        privileges: [...privileges, "SUPER"],
      }),
    ).toEqual([
      "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO 'credit_migrator'@'%'",
      "GRANT SUPER ON *.* TO 'credit_migrator'@'%'",
    ]);
    expect(
      buildCreditMigrationPrivilegeStatements({
        account: ACCOUNT,
        databaseName: DATABASE,
        operation: "revoke",
        privileges: [...privileges, "SUPER"],
      }),
    ).toEqual([
      "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
      "REVOKE CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* FROM 'credit_migrator'@'%'",
    ]);
  });

  it("grants conditional SUPER last and revokes it after failed verification", async () => {
    const { readState, root, statements } = rootHarness({
      requireSuper: true,
    });
    const verifyRollback = vi.fn(async () => undefined);
    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: true,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify: async () => {
          throw new Error("synthetic verification failure");
        },
        verifyRollback,
      }),
    ).rejects.toThrow("synthetic verification failure");
    expect(statements).toContain("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
    expect(statements).toContain(
      "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
    );
    expect(verifyRollback).toHaveBeenCalledWith([
      "CREATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
      "SUPER",
    ]);
  });

  it("revokes both deltas when SUPER commits before its transport fails", async () => {
    const { readState, root, statements } = rootHarness({
      failGrantAfterApplyAt: 2,
      requireSuper: true,
    });
    const verifyRollback = vi.fn(async () => undefined);
    await expect(
      repairCreditMigrationPrincipal({
        account: ACCOUNT,
        databaseName: DATABASE,
        requireSuper: true,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify: vi.fn(),
        verifyRollback,
      }),
    ).rejects.toThrow("synthetic transport loss");
    const superRevoke = statements.indexOf(
      "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
    );
    const schemaRevoke = statements.indexOf(
      "REVOKE CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* FROM 'credit_migrator'@'%'",
    );
    expect(superRevoke).toBeGreaterThan(-1);
    expect(schemaRevoke).toBeGreaterThan(superRevoke);
    expect(verifyRollback).toHaveBeenCalledWith([
      "CREATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
      "SUPER",
    ]);
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

describe("temporary migration SUPER cleanup", () => {
  it("accepts every approved four-right repair subset with or without SUPER", () => {
    const repairRights = [
      "CREATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
    ];
    for (let subset = 0; subset < 16; subset += 1) {
      const privileges = repairRights.filter(
        (_, index) => subset & (1 << index),
      );
      for (const superPresent of [false, true]) {
        const grants = [
          ...BASE_GRANTS,
          ...(privileges.length
            ? [
                `GRANT ${privileges.join(", ")} ON \`leaderbot\`.* TO \`credit_migrator\`@\`%\``,
              ]
            : []),
          ...(superPresent ? [SUPER_GRANT] : []),
        ];
        expect(() =>
          assertCreditMigrationSuperCleanupBoundary(
            migrationState(grants, !superPresent),
          ),
        ).not.toThrow();
      }
    }
  });

  it.each(INVALID_CLEANUP_GRANTS)(
    "refuses %s under the lock before revoking anything",
    async (_label, grants) => {
      const { root, statements } = rootHarness();
      const verify = vi.fn();
      await expect(
        revokeTemporaryCreditMigrationSuper({
          account: ACCOUNT,
          databaseName: DATABASE,
          root,
          readState: async () => migrationState(grants),
          recoverRoot: vi.fn(),
          verify,
        }),
      ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
      expect(
        statements.some((statement) => statement.startsWith("REVOKE")),
      ).toBe(false);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it.each(["recovered", "revoked"])(
    "refuses a changed grant boundary after the root was %s",
    async (stage) => {
      const { root, readState, statements } = rootHarness({
        failRevoke: stage === "recovered",
      });
      await root.execute("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
      const initial = await readState();
      readState
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(
          migrationState([
            ...BASE_GRANTS,
            ...(stage === "recovered" ? [SUPER_GRANT] : []),
            "GRANT PROCESS ON *.* TO `credit_migrator`@`%`",
          ]),
        );
      const verify = vi.fn();
      await expect(
        revokeTemporaryCreditMigrationSuper({
          account: ACCOUNT,
          databaseName: DATABASE,
          root,
          readState,
          recoverRoot: vi.fn(async () => root),
          verify,
        }),
      ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
      expect(
        statements.filter((statement) => statement.startsWith("REVOKE")),
      ).toHaveLength(1);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    [false, false],
    [true, false],
  ])(
    "revokes SUPER independently of binlog policy (%s -> %s)",
    async (before, after) => {
      const { readState, root } = rootHarness({ requireSuper: true });
      await root.execute("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
      let reads = 0;
      const verify = vi.fn(async () => undefined);

      await expect(
        revokeTemporaryCreditMigrationSuper({
          account: ACCOUNT,
          databaseName: DATABASE,
          readState: async () => ({
            ...(await readState()),
            requireSuper: reads++ === 0 ? before : after,
          }),
          recoverRoot: vi.fn(),
          root,
          verify,
        }),
      ).resolves.toBe("revoked");
      expect(hasCreditMigrationGlobalSuper((await readState()).grants)).toBe(
        false,
      );
      expect(verify).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "recovers a revoke transport loss (already applied: %s)",
    async (applied) => {
      const { readState, root: replacementRoot, statements } = rootHarness();
      await replacementRoot.execute(
        "GRANT SUPER ON *.* TO 'credit_migrator'@'%'",
      );
      statements.length = 0;
      const firstRoot = {
        execute: vi.fn(async (statement) => {
          if (statement.startsWith("REVOKE")) {
            if (applied) await replacementRoot.execute(statement);
            throw new Error("synthetic transport loss");
          }
          return ["1"];
        }),
      };
      const recoverRoot = vi.fn(async () => replacementRoot);
      const verify = vi.fn(async () => undefined);

      await expect(
        revokeTemporaryCreditMigrationSuper({
          account: ACCOUNT,
          databaseName: DATABASE,
          readState,
          recoverRoot,
          root: firstRoot,
          verify,
        }),
      ).resolves.toBe("revoked");
      expect(recoverRoot).toHaveBeenCalledExactlyOnceWith(firstRoot);
      expect(
        statements.filter((statement) => statement.startsWith("REVOKE")),
      ).toEqual(["REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'"]);
      expect(statements).toContain(
        "SELECT GET_LOCK('leaderbot_credit_migration_principal_repair_v1',0)",
      );
      expect(hasCreditMigrationGlobalSuper((await readState()).grants)).toBe(
        false,
      );
      expect(verify).toHaveBeenCalledOnce();
    },
  );

  it("reports cleanup incomplete after one unsuccessful recovery attempt", async () => {
    const { readState, root, statements } = rootHarness({ failRevoke: true });
    await root.execute("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
    const recoverRoot = vi.fn(async () => root);
    const verify = vi.fn();

    await expect(
      revokeTemporaryCreditMigrationSuper({
        account: ACCOUNT,
        databaseName: DATABASE,
        readState,
        recoverRoot,
        root,
        verify,
      }),
    ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
    expect(recoverRoot).toHaveBeenCalledOnce();
    expect(
      statements.filter((statement) => statement.startsWith("REVOKE")),
    ).toHaveLength(2);
    expect(hasCreditMigrationGlobalSuper((await readState()).grants)).toBe(
      true,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    { account: { ...ACCOUNT, username: "different_migrator" } },
    { account: { ...ACCOUNT, hostname: "localhost" } },
    { databaseName: "different_database" },
  ])(
    "refuses a changed cleanup identity after reconnect: %j",
    async (changed) => {
      const { readState, root, statements } = rootHarness({ failRevoke: true });
      await root.execute("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
      const initial = await readState();
      readState
        .mockResolvedValueOnce(initial)
        .mockResolvedValue({ ...initial, ...changed });
      const verify = vi.fn();

      await expect(
        revokeTemporaryCreditMigrationSuper({
          account: ACCOUNT,
          databaseName: DATABASE,
          readState,
          recoverRoot: vi.fn(async () => root),
          root,
          verify,
        }),
      ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
      expect(
        statements.filter((statement) => statement.startsWith("REVOKE")),
      ).toHaveLength(1);
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it("revokes SUPER under the private lock and verifies it is absent", async () => {
    const { readState, root, statements } = rootHarness({ requireSuper: true });
    await root.execute(
      "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO 'credit_migrator'@'%'",
    );
    await root.execute("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
    statements.length = 0;
    const verify = vi.fn(async () => undefined);
    await expect(
      revokeTemporaryCreditMigrationSuper({
        account: ACCOUNT,
        databaseName: DATABASE,
        readState,
        recoverRoot: vi.fn(async () => root),
        root,
        verify,
      }),
    ).resolves.toBe("revoked");
    expect(statements).toContain(
      "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
    );
    expect(verify).toHaveBeenCalledOnce();
    expect(hasCreditMigrationGlobalSuper((await readState()).grants)).toBe(
      false,
    );
  });

  it.each([false, true])(
    "is idempotent when SUPER is absent (required: %s)",
    async (requireSuper) => {
      const { readState, root, statements } = rootHarness({ requireSuper });
      const verify = vi.fn(async () => undefined);
      await expect(
        revokeTemporaryCreditMigrationSuper({
          account: ACCOUNT,
          databaseName: DATABASE,
          readState,
          recoverRoot: vi.fn(async () => root),
          root,
          verify,
        }),
      ).resolves.toBe("already_revoked");
      expect(
        statements.some((statement) => statement.startsWith("REVOKE")),
      ).toBe(false);
      expect(verify).toHaveBeenCalledOnce();
    },
  );
});

describe("credit migration principal repair resumability", () => {
  it.each(INVALID_CLEANUP_GRANTS)(
    "rejects a misconfigured cleanup secret with %s before opening root",
    async (_label, grants) => {
      const connection = { end: vi.fn(async () => undefined) };
      const openRoot = vi.fn();
      await expect(
        executeSuperCleanup(
          {
            app: "leaderbot-portal-mysql",
            machineId: "080d3ddb5099e8",
            operation: "revoke-super",
          },
          {
            migrationUrl:
              "mysql://other_admin:synthetic@127.0.0.1:13306/leaderbot",
            mysql: { createConnection: vi.fn(async () => connection) },
            openRoot,
            readPhase: vi.fn(async () => "0016_expand"),
            readState: vi.fn(async () => ({
              ...migrationState(
                grants.map((grant) =>
                  grant.replaceAll("credit_migrator", "other_admin"),
                ),
              ),
              account: { username: "other_admin", hostname: "%" },
            })),
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow();
      expect(openRoot).not.toHaveBeenCalled();
      expect(connection.end).toHaveBeenCalledOnce();
    },
  );

  it("revokes temporary SUPER through the isolated cleanup command", async () => {
    const connection = { end: vi.fn(async () => undefined) };
    const { readState, root } = rootHarness({ requireSuper: true });
    await root.execute(
      "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO 'credit_migrator'@'%'",
    );
    await root.execute("GRANT SUPER ON *.* TO 'credit_migrator'@'%'");
    await expect(
      executeSuperCleanup(
        {
          app: "leaderbot-portal-mysql",
          machineId: "080d3ddb5099e8",
          operation: "revoke-super",
        },
        {
          migrationUrl:
            "mysql://credit_migrator:secret@127.0.0.1:13306/leaderbot",
          mysql: {
            createConnection: vi.fn(async () => connection),
          },
          openRoot: vi.fn(async () => root),
          readPhase: vi.fn(async () => "0018_credit_checkout_reservation"),
          readState,
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toBe("revoked");
    expect(hasCreditMigrationGlobalSuper((await readState()).grants)).toBe(
      false,
    );
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("preserves cleanup-incomplete when closing the migration connection also fails", async () => {
    const connection = {
      end: vi.fn(async () => {
        throw new Error("synthetic close failure");
      }),
    };
    const { readState, root } = rootHarness({ failRevoke: true });

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
          openRoot: vi.fn(async () => root),
          readPhase: vi.fn(async () => "0016_expand"),
          readState,
          signal: new AbortController().signal,
          verifyRuntime: vi.fn(async () => {
            throw new Error("synthetic verification failure");
          }),
        },
      ),
    ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
    expect(connection.end).toHaveBeenCalledOnce();
  });

  it.each(["0017_credit_wallet_expand", "0018_credit_checkout_reservation"])(
    "keeps %s verification-only without a conditional SUPER requirement",
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
      expect(verifyRuntime).toHaveBeenCalledWith(
        connection,
        "credit-expand-postddl",
      );
      expect(connection.end).toHaveBeenCalledOnce();
    },
  );

  describe.each([
    "0017_credit_wallet_expand",
    "0018_credit_checkout_reservation",
  ])("conditional SUPER preparation at %s", (phase) => {
    it("grants only SUPER after full boundary verification and rechecks the same history", async () => {
      const { prepare, options, statements, readState, connection } =
        postDdlPrepareHarness(phase);
      await expect(prepare()).resolves.toBe("repaired");
      expect(statements.filter((sql) => /^(GRANT|REVOKE) /.test(sql))).toEqual([
        "GRANT SUPER ON *.* TO 'credit_migrator'@'%'",
      ]);
      expect(options.verifyRuntime.mock.calls).toEqual([
        [connection, "credit-expand-postddl"],
        [connection, "credit-expand"],
      ]);
      expect(options.verifyRuntime.mock.invocationCallOrder[0]).toBeLessThan(
        options.openRoot.mock.invocationCallOrder[0],
      );
      expect(options.readPhase).toHaveBeenCalledTimes(4);
      expect((await readState()).grants).toEqual([
        ...POST_DDL_GRANTS,
        SUPER_GRANT,
      ]);
      expect(connection.end).toHaveBeenCalledOnce();
    });

    it("accepts required SUPER already present without opening root", async () => {
      const { prepare, options, connection } = postDdlPrepareHarness(phase, {
        initialGrants: [...POST_DDL_GRANTS, SUPER_GRANT],
      });
      await expect(prepare()).resolves.toBe("already_ready");
      expect(options.openRoot).not.toHaveBeenCalled();
      expect(options.verifyRuntime).toHaveBeenCalledExactlyOnceWith(
        connection,
        "credit-expand",
      );
    });

    it.each([
      ["missing schema rights", BASE_GRANTS],
      [
        "missing table rights",
        POST_DDL_GRANTS.filter((grant) => !grant.includes("`billing_intents`")),
      ],
      [
        "excess table rights",
        [
          ...POST_DDL_GRANTS,
          "GRANT UPDATE ON `leaderbot`.`credit_wallets` TO `credit_migrator`@`%`",
        ],
      ],
      [
        "an unreviewed role",
        [
          ...POST_DDL_GRANTS,
          "GRANT `administrator`@`%` TO `credit_migrator`@`%`",
        ],
      ],
      [
        "an unreviewed routine",
        [
          ...POST_DDL_GRANTS,
          "GRANT EXECUTE ON PROCEDURE `leaderbot`.`other_helper` TO `credit_migrator`@`%`",
        ],
      ],
    ])("rejects %s before opening root", async (_label, initialGrants) => {
      const { prepare, options } = postDdlPrepareHarness(phase, {
        initialGrants,
      });
      await expect(prepare()).rejects.toThrow();
      expect(options.openRoot).not.toHaveBeenCalled();
    });

    it("rejects runtime or routine-ownership failure before opening root", async () => {
      const { prepare, options } = postDdlPrepareHarness(phase);
      options.verifyRuntime.mockRejectedValue(
        new Error("synthetic runtime failure"),
      );
      await expect(prepare()).rejects.toThrow("synthetic runtime failure");
      expect(options.openRoot).not.toHaveBeenCalled();
    });

    it("rejects unnecessary retained SUPER before opening root", async () => {
      const { prepare, options } = postDdlPrepareHarness(phase, {
        initialGrants: [...POST_DDL_GRANTS, SUPER_GRANT],
        requireSuper: false,
      });
      await expect(prepare()).rejects.toThrow("excessive global SUPER");
      expect(options.openRoot).not.toHaveBeenCalled();
    });

    it("never repairs schema rights that disappear before the root lock", async () => {
      const { prepare, options, statements } = postDdlPrepareHarness(phase);
      options.readState
        .mockResolvedValueOnce(migrationState(POST_DDL_GRANTS, true))
        .mockResolvedValueOnce(migrationState(POST_DDL_GRANTS, true))
        .mockResolvedValue(migrationState(BASE_GRANTS, true));
      await expect(prepare()).rejects.toThrow();
      expect(statements.some((sql) => /^(GRANT|REVOKE) /.test(sql))).toBe(
        false,
      );
    });

    it("rejects history changes before the locked grant", async () => {
      const { prepare, options, statements } = postDdlPrepareHarness(phase);
      options.readPhase
        .mockResolvedValueOnce(phase)
        .mockResolvedValueOnce(phase)
        .mockResolvedValue("synthetic changed history");
      await expect(prepare()).rejects.toThrow();
      expect(statements.some((sql) => /^(GRANT|REVOKE) /.test(sql))).toBe(
        false,
      );
    });

    it.each([false, true])(
      "reconnects and rolls back only SUPER when grant transport fails (applied=%s)",
      async (applied) => {
        const { prepare, options, root, statements, readState } =
          postDdlPrepareHarness(phase);
        let disconnected = false;
        const failedRoot = {
          initialize: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          execute: vi.fn(async (sql) => {
            if (disconnected) throw new Error("synthetic disconnected root");
            if (sql.startsWith("GRANT ")) {
              if (applied) await root.execute(sql);
              disconnected = true;
              throw new Error("synthetic grant transport loss");
            }
            return root.execute(sql);
          }),
        };
        options.openRoot
          .mockResolvedValueOnce(failedRoot)
          .mockResolvedValueOnce(root);
        await expect(prepare()).rejects.toThrow(
          "synthetic grant transport loss",
        );
        expect(options.openRoot).toHaveBeenCalledTimes(2);
        expect(
          statements.filter((sql) => /^(GRANT|REVOKE) /.test(sql)),
        ).toEqual(
          applied
            ? [
                "GRANT SUPER ON *.* TO 'credit_migrator'@'%'",
                "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
              ]
            : [],
        );
        expect((await readState()).grants).toEqual(POST_DDL_GRANTS);
        expect(root.close).toHaveBeenCalledOnce();
      },
    );

    it("fails closed when an applied SUPER grant cannot be rolled back", async () => {
      const { prepare, options, root, readState, statements } =
        postDdlPrepareHarness(phase, {
          failGrantAfterApply: true,
          failRevoke: true,
        });
      await expect(prepare()).rejects.toBeInstanceOf(
        CreditMigrationPrincipalCleanupError,
      );
      expect(options.openRoot).toHaveBeenCalledOnce();
      expect(root.close).toHaveBeenCalledOnce();
      expect(hasCreditMigrationGlobalSuper((await readState()).grants)).toBe(
        true,
      );
      expect(statements.filter((sql) => sql.startsWith("REVOKE "))).toEqual([
        "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
      ]);
    });

    it("rolls back only SUPER if the post-grant runtime recheck fails", async () => {
      const { prepare, options, readState, statements } =
        postDdlPrepareHarness(phase);
      options.verifyRuntime
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new Error("synthetic post-grant runtime failure"),
        );
      await expect(prepare()).rejects.toThrow(
        "synthetic post-grant runtime failure",
      );
      expect((await readState()).grants).toEqual(POST_DDL_GRANTS);
      expect(statements.filter((sql) => sql.startsWith("REVOKE "))).toEqual([
        "REVOKE SUPER ON *.* FROM 'credit_migrator'@'%'",
      ]);
    });
  });

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
        "--operation",
        "prepare",
      ]),
    ).toEqual({
      app: "leaderbot-portal-mysql",
      machineId: "080d3ddb5099e8",
      operation: "prepare",
    });
    expect(() =>
      parseCliArguments([
        "--database-app",
        "other",
        "--database-machine-id",
        "080d3ddb5099e8",
        "--operation",
        "prepare",
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
          "--operation",
          "prepare",
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
          "--operation",
          "prepare",
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

  it("prints the fixed marker after temporary SUPER cleanup", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(
      runCli(
        [
          "--database-app",
          "leaderbot-portal-mysql",
          "--database-machine-id",
          "080d3ddb5099e8",
          "--operation",
          "revoke-super",
        ],
        { cleanup: vi.fn(async () => "revoked") },
      ),
    ).resolves.toBe(CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER);
    expect(output).toHaveBeenLastCalledWith(
      `${CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER}\n`,
    );
    output.mockRestore();
  });
});
