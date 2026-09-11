import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import { getOwnerMessengerLegacyWorkState } from "./billingDrainLifecycle";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("owner-operated Messenger legacy-work query", () => {
  it("maps only actual unresolved query results to startup blockers", async () => {
    const harness = queryHarness([
      [{ id: "legacy-intent" }],
      [{ id: "legacy-operation" }],
      [{ id: 7 }],
      [{ id: 9 }],
    ]);
    databaseMock.mockResolvedValue(harness.database);

    await expect(getOwnerMessengerLegacyWorkState()).resolves.toEqual({
      unresolvedProviderIntent: true,
      unresolvedProviderOperation: true,
      activeSubscription: true,
      retiredOutboxDelivery: true,
    });
  });

  it("excludes terminal history while retaining paid, ambiguous and queued work", async () => {
    const harness = queryHarness([[], [], [], []]);
    databaseMock.mockResolvedValue(harness.database);

    await expect(getOwnerMessengerLegacyWorkState()).resolves.toEqual({
      unresolvedProviderIntent: false,
      unresolvedProviderOperation: false,
      activeSubscription: false,
      retiredOutboxDelivery: false,
    });

    const dialect = new MySqlDialect();
    const [intent, operation, subscription, outbox] = harness.predicates.map(
      predicate => dialect.sqlToQuery(predicate).params
    );
    expect(intent).toEqual(
      expect.arrayContaining([
        "credit_purchase",
        "creating_payment",
        "open",
        "paid",
        "mismatch",
        "api_unknown",
      ])
    );
    expect(operation).toEqual(
      expect.arrayContaining([
        "credit_purchase",
        "created",
        "paid",
        "reserved",
        "transport_started",
        "succeeded",
        "ambiguous",
        "reconciliation_only",
      ])
    );
    expect(subscription).toEqual(
      expect.arrayContaining([
        "provisioning",
        "active",
        "past_due",
        "suspended",
        "manual_review",
      ])
    );
    expect(outbox).toEqual(
      expect.arrayContaining([
        "ensure_subscription",
        "send_portal_handoff",
        "pending",
        "processing",
      ])
    );
    for (const terminal of ["failed", "canceled", "expired", "contained"]) {
      expect(intent).not.toContain(terminal);
      expect(operation).not.toContain(terminal);
    }
    expect(subscription).not.toContain("canceled");
    expect(subscription).not.toContain("completed");
    expect(outbox).not.toContain("failed");
    expect(outbox).not.toContain("completed");

    const join = dialect.sqlToQuery(harness.joins[0]!).sql;
    expect(join).toContain("intent_id");
    expect(join).toContain("workspace_id");
    expect(join).toContain("mode");
    expect(join).toContain("billing_profile_version");
    expect(join).toContain("authorization_epoch");
  });
});

function queryHarness(rowsByQuery: readonly unknown[][]) {
  const predicates: SQL[] = [];
  const joins: SQL[] = [];
  let queryIndex = 0;
  const database = {
    select: vi.fn(() => {
      const rows = rowsByQuery[queryIndex++] ?? [];
      const where = (predicate: SQL) => {
        predicates.push(predicate);
        return { limit: vi.fn(async () => rows) };
      };
      return {
        from: vi.fn(() => ({
          where: vi.fn(where),
          innerJoin: vi.fn((_table: unknown, join: SQL) => {
            joins.push(join);
            return { where: vi.fn(where) };
          }),
        })),
      };
    }),
  };
  return { database, predicates, joins };
}
