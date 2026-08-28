import { sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ getDatabaseOrThrow: getDatabaseMock }));

import {
  billingIntents,
  billingOutbox,
  billingProfileOperatorActions,
  billingProviderOperations,
  billingSubscriptions,
  users,
  workspaceBillingProfiles,
} from "../../../drizzle/schema";
import {
  expireWorkspaceBillingProfileIfDue,
  revokeWorkspaceBillingProfile,
} from "./billingProfileStore";

const NOW = new Date("2026-08-28T09:00:00.000Z");
const LEGACY_INTENT_ID = "11111111-1111-4111-8111-111111111111";
const CREDIT_INTENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => vi.clearAllMocks());

describe("legacy billing-profile containment isolation", () => {
  it("revokes legacy billing without selecting or mutating credit purchases", async () => {
    const fixture = profileMutationDatabase("revoke");
    getDatabaseMock.mockResolvedValue(fixture.database);

    await expect(
      revokeWorkspaceBillingProfile({
        requestId: "a35ee776-d81e-4dd4-8799-45d4f34d4892",
        workspaceId: 7,
        actorUserId: 99,
        expectedVersion: 1,
        reason: "operator requested revocation",
        now: NOW,
      })
    ).resolves.toEqual({ eligibilityVersion: 2 });

    assertCreditPurchaseExcludedFromEveryIntentPredicate(fixture);
    assertProviderContainmentUsesLegacyIntentSubquery(fixture);
    expect(fixture.insertedFor(billingOutbox)).toContainEqual(
      expect.objectContaining({
        eventType: "cancel_payment",
        payload: expect.objectContaining({
          intentId: LEGACY_INTENT_ID,
          targetPaymentId: "tr_legacy_open",
        }),
      })
    );
    expect(JSON.stringify(fixture.insertedFor(billingOutbox))).not.toContain(
      CREDIT_INTENT_ID
    );
  });

  it("expires legacy billing without selecting or mutating credit purchases", async () => {
    const fixture = profileMutationDatabase("expiry");
    getDatabaseMock.mockResolvedValue(fixture.database);

    await expect(expireWorkspaceBillingProfileIfDue(7, NOW)).resolves.toBe(
      true
    );

    assertCreditPurchaseExcludedFromEveryIntentPredicate(fixture);
    assertProviderContainmentUsesLegacyIntentSubquery(fixture);
    expect(fixture.insertedFor(billingOutbox)).toContainEqual(
      expect.objectContaining({
        eventType: "cancel_payment",
        payload: expect.objectContaining({
          intentId: LEGACY_INTENT_ID,
          targetPaymentId: "tr_legacy_open",
        }),
      })
    );
    expect(JSON.stringify(fixture.insertedFor(billingOutbox))).not.toContain(
      CREDIT_INTENT_ID
    );
  });
});

function assertCreditPurchaseExcludedFromEveryIntentPredicate(
  fixture: ReturnType<typeof profileMutationDatabase>
): void {
  const predicates = fixture.predicatesFor(billingIntents);
  expect(predicates.length).toBeGreaterThanOrEqual(3);
  for (const expression of predicates) {
    const query = new MySqlDialect().sqlToQuery(expression);
    expect(query.sql).toContain("`billing_intents`.`kind` <> ?");
    expect(query.params).toContain("credit_purchase");
  }
}

function assertProviderContainmentUsesLegacyIntentSubquery(
  fixture: ReturnType<typeof profileMutationDatabase>
): void {
  const providerUpdates = fixture.updatesFor(billingProviderOperations);
  expect(providerUpdates).toHaveLength(1);
  const query = new MySqlDialect().sqlToQuery(providerUpdates[0]!.where);
  expect(query.sql).toContain("`billing_provider_operations`.`intent_id` in");
  expect(query.sql).toContain(
    "select `billing_intents`.`intent_id` from `billing_intents`"
  );
  expect(query.sql).toContain("`billing_intents`.`kind` <> ?");
  expect(query.params).toContain("credit_purchase");
}

function profileMutationDatabase(operation: "revoke" | "expiry") {
  type Table = object;
  type UpdateCapture = { values: unknown; where: unknown };

  const predicates = new Map<Table, unknown[]>();
  const updates = new Map<Table, UpdateCapture[]>();
  const inserts = new Map<Table, unknown[]>();

  const rowsFor = (table: Table, selection: Record<string, unknown> | null) => {
    if (table === users) return [{ userId: 99 }];
    if (table === billingProfileOperatorActions) return [];
    if (table === workspaceBillingProfiles) {
      return operation === "revoke"
        ? [
            {
              evidenceReferenceHash: `sha256:${"a".repeat(64)}`,
              eligibilityVersion: 1,
              verificationStatus: "verified",
            },
          ]
        : [
            {
              eligibilityVersion: 1,
              verificationExpiresAt: new Date("2026-08-28T08:00:00.000Z"),
            },
          ];
    }
    if (table === billingIntents && selection) {
      const fields = Object.keys(selection);
      if (fields.includes("molliePaymentId") && fields.length > 1) {
        return [
          {
            intentId: LEGACY_INTENT_ID,
            mode: "test",
            status: "open",
            molliePaymentId: "tr_legacy_open",
          },
        ];
      }
    }
    if (table === billingSubscriptions) return [];
    return [];
  };

  const select = vi.fn((selection?: Record<string, unknown>) => {
    let table: Table | null = null;
    let whereExpression: unknown;
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn((selectedTable: Table) => {
      table = selectedTable;
      return builder;
    });
    builder.where = vi.fn((expression: unknown) => {
      whereExpression = expression;
      if (!table) throw new Error("test select missing table");
      predicates.set(table, [...(predicates.get(table) ?? []), expression]);
      return builder;
    });
    builder.limit = vi.fn(() => builder);
    builder.for = vi.fn(async () => rowsFor(table!, selection ?? null));
    builder.getSQL = () => {
      if (table !== billingIntents || whereExpression === undefined) {
        throw new Error("unexpected test subquery");
      }
      return sql`select ${billingIntents.intentId} from ${billingIntents} where ${whereExpression}`;
    };
    builder.then = (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown
    ) =>
      Promise.resolve(rowsFor(table!, selection ?? null)).then(resolve, reject);
    return builder;
  });

  const update = vi.fn((table: Table) => ({
    set: vi.fn((values: unknown) => ({
      where: vi.fn(async (expression: unknown) => {
        predicates.set(table, [...(predicates.get(table) ?? []), expression]);
        updates.set(table, [
          ...(updates.get(table) ?? []),
          { values, where: expression },
        ]);
        return [{ affectedRows: 1 }, []];
      }),
    })),
  }));

  const insert = vi.fn((table: Table) => ({
    values: vi.fn((values: unknown) => {
      inserts.set(table, [...(inserts.get(table) ?? []), values]);
      return {
        onDuplicateKeyUpdate: vi.fn(async () => undefined),
      };
    }),
  }));

  const tx = { select, update, insert };
  return {
    database: {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      ),
    },
    predicatesFor: (table: Table) => predicates.get(table) ?? [],
    updatesFor: (table: Table) => updates.get(table) ?? [],
    insertedFor: (table: Table) => inserts.get(table) ?? [],
  };
}
