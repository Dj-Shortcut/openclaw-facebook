import { describe, expect, it } from "vitest";

import {
  assertCreditProvisionerGrantScope,
  canonicalJson,
  canonicalPrettyJson,
  productionRuntimeWritableTableNames,
} from "./production-schema-contract.mjs";

describe("credit provisioner session inventory privilege boundary", () => {
  const baseGrants = [
    "GRANT CREATE USER ON *.* TO `credit_provisioner`@`%`",
    "GRANT SELECT ON `mysql`.`user` TO `credit_provisioner`@`%`",
    "GRANT SELECT, EXECUTE ON `leaderbot`.* TO `credit_provisioner`@`%` WITH GRANT OPTION",
    ...productionRuntimeWritableTableNames.map(
      tableName =>
        `GRANT INSERT, UPDATE, DELETE ON \`leaderbot\`.\`${tableName}\` TO \`credit_provisioner\`@\`%\` WITH GRANT OPTION`
    ),
    "GRANT DELETE, CREATE ON `leaderbot`.`credit_wallets` TO `credit_provisioner`@`%` WITH GRANT OPTION",
  ];
  const inventoryGrant =
    "GRANT SELECT (NAME, TYPE, PROCESSLIST_ID, PROCESSLIST_USER) ON `performance_schema`.`threads` TO `credit_provisioner`@`%`";
  const required = { requireSessionInventory: true };

  it("preserves the original maintenance profile without granting inventory access", () => {
    expect(() =>
      assertCreditProvisionerGrantScope(baseGrants, "leaderbot")
    ).not.toThrow();
    expect(() =>
      assertCreditProvisionerGrantScope(baseGrants, "leaderbot", required)
    ).toThrow("credit provisioner privilege boundary mismatch");
  });

  it.each([
    inventoryGrant,
    "GRANT SELECT (`processlist_user`, `name`, `processlist_id`, `type`) ON `performance_schema`.`threads` TO `credit_provisioner`@`%`",
  ])("accepts only the exact four columns, independent of order: %s", grant => {
    const grants = [...baseGrants, grant];
    expect(() =>
      assertCreditProvisionerGrantScope(grants, "leaderbot")
    ).not.toThrow();
    expect(() =>
      assertCreditProvisionerGrantScope(grants, "leaderbot", required)
    ).not.toThrow();
  });

  it.each([
    ["missing column", inventoryGrant.replace(", PROCESSLIST_USER", "")],
    ["duplicate column", inventoryGrant.replace("PROCESSLIST_USER", "NAME")],
    [
      "SQL text access",
      inventoryGrant.replace("TYPE,", "TYPE, PROCESSLIST_INFO,"),
    ],
    [
      "whole table access",
      inventoryGrant.replace(/SELECT \([^)]*\)/, "SELECT"),
    ],
    [
      "whole schema access",
      inventoryGrant
        .replace(/SELECT \([^)]*\)/, "SELECT")
        .replace("`threads`", "*"),
    ],
    ["grant delegation", `${inventoryGrant} WITH GRANT OPTION`],
    ["extra privilege", inventoryGrant.replace(") ON", "), UPDATE ON")],
    [
      "wrong table",
      inventoryGrant.replace("`threads`", "`events_statements_current`"),
    ],
    [
      "wrong schema",
      inventoryGrant.replace("`performance_schema`", "`leaderbot`"),
    ],
    ["confusable column", inventoryGrant.replace("NAME,", "`NA``ME`,")],
    [
      "global process access",
      "GRANT PROCESS ON *.* TO `credit_provisioner`@`%`",
    ],
  ])("rejects %s even when inventory is optional", (_label, grant) => {
    for (const options of [{}, required]) {
      expect(() =>
        assertCreditProvisionerGrantScope(
          [...baseGrants, grant],
          "leaderbot",
          options
        )
      ).toThrow("credit provisioner privilege boundary mismatch");
    }
  });

  it("rejects duplicate grants instead of treating them as one accepted permission", () => {
    expect(() =>
      assertCreditProvisionerGrantScope(
        [...baseGrants, inventoryGrant, inventoryGrant],
        "leaderbot"
      )
    ).toThrow("credit provisioner privilege boundary mismatch");
  });

  it("rejects partial grants distributed across rows", () => {
    expect(() =>
      assertCreditProvisionerGrantScope(
        [
          ...baseGrants,
          inventoryGrant.replace("NAME, TYPE, ", ""),
          inventoryGrant.replace(", PROCESSLIST_ID, PROCESSLIST_USER", ""),
        ],
        "leaderbot"
      )
    ).toThrow("credit provisioner privilege boundary mismatch");
  });

  it("still requires the complete base privilege profile", () => {
    for (let index = 0; index < baseGrants.length; index += 1) {
      expect(() =>
        assertCreditProvisionerGrantScope(
          [
            ...baseGrants.filter((_grant, position) => position !== index),
            inventoryGrant,
          ],
          "leaderbot",
          required
        )
      ).toThrow("credit provisioner privilege boundary mismatch");
    }
  });
});

describe("production schema contract serialization", () => {
  it("produces identical pretty JSON regardless of object insertion order", () => {
    const mysqlOrder = {
      tables: {
        workspaces: "workspace-hash",
        workspaceUsageDaily: "usage-hash",
      },
      states: [{ resumeFrom: 0, schema: { zeta: 2, alpha: 1 } }],
    };
    const alternateOrder = {
      states: [{ schema: { alpha: 1, zeta: 2 }, resumeFrom: 0 }],
      tables: {
        workspaceUsageDaily: "usage-hash",
        workspaces: "workspace-hash",
      },
    };

    expect(canonicalPrettyJson(mysqlOrder)).toBe(
      canonicalPrettyJson(alternateOrder)
    );
    expect(canonicalPrettyJson(mysqlOrder)).toBe(`{
  "states": [
    {
      "resumeFrom": 0,
      "schema": {
        "alpha": 1,
        "zeta": 2
      }
    }
  ],
  "tables": {
    "workspaceUsageDaily": "usage-hash",
    "workspaces": "workspace-hash"
  }
}`);
  });

  it("ignores field insertion order without ignoring array row order", () => {
    expect(canonicalJson([{ id: 1, hash: "one" }])).toBe(
      canonicalJson([{ hash: "one", id: 1 }])
    );
    expect(
      canonicalJson([
        { id: 1, hash: "one" },
        { id: 2, hash: "two" },
      ])
    ).not.toBe(
      canonicalJson([
        { id: 2, hash: "two" },
        { id: 1, hash: "one" },
      ])
    );
  });
});
