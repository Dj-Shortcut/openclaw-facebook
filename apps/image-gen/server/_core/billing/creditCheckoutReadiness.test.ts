import { afterEach, describe, expect, it, vi } from "vitest";

import {
  creditWalletRoutineNames,
  productionRuntimeWritableTableNames,
} from "../../../scripts/production-schema-contract.mjs";
import {
  assertCreditCheckoutBoundaryReadiness,
  assertCreditCheckoutDatabaseReadiness,
} from "./creditCheckoutReadiness";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({ getDatabaseOrThrow: getDatabaseOrThrowMock }));

const DATABASE_NAME = "leaderbot_credit_runtime";

function runtimeGrants(): string[] {
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

function databaseHarness(grants: readonly string[]) {
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
  const results = [
    [],
    [],
    [],
    [],
    [],
    [],
    [
      {
        workspaceId: 42,
        commercialEnabled: true,
        authorizationEpoch: 7,
      },
    ],
    [
      {
        workspaceId: 42,
        kind: "outbox",
        enabled: true,
        executionEpoch: 7,
        deadLetterCount: 0,
      },
    ],
  ];
  let resultIndex = 0;
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const rows = results[resultIndex++] ?? [];
        return {
          limit: vi.fn(async () => rows),
          then: (
            onFulfilled: (value: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown
          ) => Promise.resolve(rows).then(onFulfilled, onRejected),
        };
      }),
    })),
  }));
  return {
    database: { $client: { promise: () => ({ query }) }, select },
    query,
    select,
  };
}

function ready(
  overrides: {
    commercialExposureEnabled?: boolean;
    commercialEnabled?: boolean;
    enabled?: boolean;
    controlEpoch?: number;
    laneEpoch?: number;
    deadLetterCount?: number;
  } = {}
) {
  return {
    workspaceId: 42,
    commercialExposureEnabled: overrides.commercialExposureEnabled ?? true,
    controls: [
      {
        workspaceId: 42,
        commercialEnabled: overrides.commercialEnabled ?? true,
        authorizationEpoch: overrides.controlEpoch ?? 7,
      },
    ],
    outboxLanes: [
      {
        workspaceId: 42,
        kind: "outbox",
        enabled: overrides.enabled ?? true,
        executionEpoch: overrides.laneEpoch ?? 7,
        deadLetterCount: overrides.deadLetterCount ?? 0,
      },
    ],
  };
}

describe("credit checkout database boundary readiness", () => {
  afterEach(() => {
    getDatabaseOrThrowMock.mockReset();
  });

  it("accepts an enabled exact pilot boundary", () => {
    expect(() => assertCreditCheckoutBoundaryReadiness(ready())).not.toThrow();
  });

  it("keeps the safety lane bootable after commercial exposure is disabled", () => {
    expect(() =>
      assertCreditCheckoutBoundaryReadiness(
        ready({
          commercialExposureEnabled: false,
          commercialEnabled: false,
          deadLetterCount: 2,
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["missing control", { controls: [] }],
    [
      "duplicate control",
      { controls: ready().controls.concat(ready().controls) },
    ],
    ["disabled commercial control", ready({ commercialEnabled: false })],
    ["disabled safety lane", ready({ enabled: false })],
    ["stale safety epoch", ready({ laneEpoch: 6 })],
    ["dead letter", ready({ deadLetterCount: 1 })],
  ])("rejects %s", (_label, value) => {
    const input = "workspaceId" in value ? value : { ...ready(), ...value };
    expect(() => assertCreditCheckoutBoundaryReadiness(input)).toThrow();
  });

  it("checks the exact runtime principal before probing credit tables", async () => {
    const harness = databaseHarness(runtimeGrants());
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      assertCreditCheckoutDatabaseReadiness({
        mode: "test",
        workspaceId: 42,
        commercialExposureEnabled: true,
      })
    ).resolves.toBeUndefined();

    expect(harness.query.mock.calls.map(call => call[0])).toEqual([
      "SELECT DATABASE() AS databaseName",
      "SHOW GRANTS FOR CURRENT_USER()",
    ]);
    expect(harness.select).toHaveBeenCalledTimes(8);
  });

  it("rejects a broad principal before probing credit tables", async () => {
    const harness = databaseHarness([
      "GRANT ALL PRIVILEGES ON *.* TO `root`@`%`",
    ]);
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      assertCreditCheckoutDatabaseReadiness({
        mode: "test",
        workspaceId: 42,
        commercialExposureEnabled: true,
      })
    ).rejects.toThrow(
      "Credit runtime database privilege boundary is not ready"
    );
    expect(harness.select).not.toHaveBeenCalled();
  });
});
