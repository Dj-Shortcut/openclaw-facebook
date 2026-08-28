import { describe, expect, it, vi } from "vitest";

import {
  creditWalletRoutineNames,
  productionRuntimeWritableTableNames,
} from "../../../scripts/production-schema-contract.mjs";
import {
  assertCreditRuntimePrivilegeReadiness,
  CreditRuntimePrivilegeReadinessError,
} from "./creditRuntimePrivilegeReadiness";

const DATABASE_NAME = "leaderbot_credit_runtime";

function exactRuntimeGrants(): string[] {
  return [
    "GRANT USAGE ON *.* TO `credit_runtime`@`%`",
    `GRANT SELECT ON \`${DATABASE_NAME}\`.* TO \`credit_runtime\`@\`%\``,
    ...productionRuntimeWritableTableNames.map(
      tableName =>
        `GRANT INSERT, UPDATE, DELETE ON \`${DATABASE_NAME}\`.\`${tableName}\` TO \`credit_runtime\`@\`%\``
    ),
    ...creditWalletRoutineNames.map(
      routineName =>
        `GRANT EXECUTE ON PROCEDURE \`${DATABASE_NAME}\`.\`${routineName}\` TO \`credit_runtime\`@\`%\``
    ),
  ];
}

function metadataConnection(grants: readonly unknown[]) {
  const query = vi.fn(async (statement: string) => {
    if (statement === "SELECT DATABASE() AS databaseName") {
      return [[{ databaseName: DATABASE_NAME }], []] as const;
    }
    if (statement === "SHOW GRANTS FOR CURRENT_USER()") {
      return [
        grants.map((grant, index) => ({ [`grant_${index}`]: grant })),
        [],
      ] as const;
    }
    throw new Error("unexpected metadata query");
  });
  return { connection: { query }, query };
}

describe("credit runtime privilege readiness", () => {
  it("accepts the exact canonical least-privilege runtime principal", async () => {
    const { connection, query } = metadataConnection(exactRuntimeGrants());

    await expect(
      assertCreditRuntimePrivilegeReadiness(connection)
    ).resolves.toBeUndefined();
    expect(query.mock.calls.map(call => call[0])).toEqual([
      "SELECT DATABASE() AS databaseName",
      "SHOW GRANTS FOR CURRENT_USER()",
    ]);
  });

  it.each([
    ["root-style global access", ["GRANT ALL PRIVILEGES ON *.* TO `root`@`%`"]],
    [
      "broad schema DML",
      [
        "GRANT USAGE ON *.* TO `credit_runtime`@`%`",
        `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DATABASE_NAME}\`.* TO \`credit_runtime\`@\`%\``,
      ],
    ],
    [
      "credit-table DML",
      exactRuntimeGrants().concat(
        `GRANT UPDATE ON \`${DATABASE_NAME}\`.\`credit_wallets\` TO \`credit_runtime\`@\`%\``
      ),
    ],
    [
      "missing normal-table DML",
      exactRuntimeGrants().filter(
        grant =>
          !grant.includes(
            `.\`${productionRuntimeWritableTableNames[0] as string}\``
          )
      ),
    ],
    ["missing wallet routine", exactRuntimeGrants().slice(0, -1)],
  ])("rejects %s without exposing the grant text", async (_label, grants) => {
    const { connection } = metadataConnection(grants);

    const error = await assertCreditRuntimePrivilegeReadiness(connection).catch(
      (failure: unknown) => failure
    );

    expect(error).toBeInstanceOf(CreditRuntimePrivilegeReadinessError);
    expect(String((error as Error).message)).not.toContain("GRANT");
    expect(String((error as Error).message)).not.toContain(DATABASE_NAME);
  });

  it.each([
    ["missing schema", []],
    ["malformed grant metadata", [null]],
  ])("fails closed on %s", async (kind, grants) => {
    void kind;
    const { connection } = metadataConnection(grants);
    if (grants.length === 0) {
      connection.query = vi.fn(async (statement: string) =>
        statement.startsWith("SELECT")
          ? ([[], []] as const)
          : ([[], []] as const)
      );
    }

    await expect(
      assertCreditRuntimePrivilegeReadiness(connection)
    ).rejects.toBeInstanceOf(CreditRuntimePrivilegeReadinessError);
  });
});
