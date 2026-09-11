import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  billingExecutionControls,
  billingSchedulerTenants,
  workspaces,
} from "../../../drizzle/schema";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  assertBillingTenantLeaseOwnedInTransaction,
  assertTestPaymentOperatorReadback,
  disableBillingSchedulerTenant,
  enableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
  resolveBillingOperatorOwner,
  releaseBillingTenantLease,
  wakeBillingSchedulerTenant,
} from "./billingSchedulerStore";

const OPERATOR_AUDIT = Object.freeze({
  source: "protected_workflow" as const,
  githubActorId: "123",
  githubRunId: "456",
  githubRunAttempt: 1,
  sourceSha: "a".repeat(40),
  deploymentIdentity: "deploy-789-1",
  runtimePrincipalSha256: "b".repeat(64),
  operatorImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"c".repeat(64)}`,
  artifactSourceSha: "d".repeat(40),
  bundleSha256: "e".repeat(64),
  runtimeImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"f".repeat(64)}`,
});
const OPERATOR_INPUT = {
  workspaceId: 10,
  mode: "test" as const,
  actorUserId: 7,
  requestId: "77777777-7777-4777-8777-777777777777",
  expectedExecutionEpoch: 1,
  reason: "protected workflow test payment preparation",
  operatorAudit: OPERATOR_AUDIT,
};

function operatorDatabase() {
  const state = {
    owners: [{ ownerUserId: 7, userRole: "admin" }],
    principal: OPERATOR_AUDIT.runtimePrincipalSha256,
    blocked: 0,
    control: { commercialEnabled: false, authorizationEpoch: 1 },
    lanes: [
      "ai_finalization",
      "outbox",
      "profile_expiry",
      "reconciliation",
    ].map(kind => ({
      kind,
      enabled: kind === "outbox",
      executionEpoch: 1,
      pendingWorkCount: 0,
      deadLetterCount: 0,
      operatorRequestId: null as string | null,
      operatorRequestFingerprint: null as string | null,
    })),
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const locks: unknown[] = [];
  const audit = vi.fn(async () => undefined);
  const dialect = new MySqlDialect();
  const tx = {
    select: vi.fn(() => ({
      from(table: unknown) {
        const rows =
          table === workspaces
            ? state.owners
            : table === billingExecutionControls
              ? [state.control]
              : state.lanes;
        const promise = Promise.resolve(rows);
        const query = {
          innerJoin: vi.fn(() => query),
          leftJoin: vi.fn(() => query),
          where: vi.fn(predicate => {
            queries.push(dialect.sqlToQuery(predicate));
            return query;
          }),
          limit: vi.fn(() => query),
          orderBy: vi.fn(() => query),
          for: vi.fn(async () => {
            locks.push(table);
            return rows;
          }),
          then: promise.then.bind(promise),
        };
        return query;
      },
    })),
    execute: vi.fn(async (statement): Promise<unknown[][]> => {
      const query = dialect.sqlToQuery(statement);
      queries.push(query);
      return query.sql.includes("CURRENT_USER()")
        ? [[{ principalSha256: state.principal }]]
        : [[{ blocked: state.blocked }]];
    }),
    update: vi.fn((table: unknown) => ({
      set: vi.fn(values => ({
        where: vi.fn(async () => {
          if (table === billingExecutionControls)
            Object.assign(state.control, values);
          else state.lanes.forEach(row => Object.assign(row, values));
          return [{ affectedRows: table === billingExecutionControls ? 1 : 4 }];
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: audit })),
  };
  getDatabaseOrThrowMock.mockResolvedValue({
    ...tx,
    transaction: vi.fn(async callback => callback(tx)),
  });
  return { state, tx, audit, locks, queries };
}

describe("protected workflow scheduler audit", () => {
  beforeEach(() => getDatabaseOrThrowMock.mockReset());

  it.each([
    "matching",
    "missing_lane",
    "epoch",
    "control",
    "disabled_lane",
    "request",
    "owner",
  ])(
    "validates persisted %s state with one exact scoped readback",
    async scenario => {
      const rows = [
        "ai_finalization",
        "outbox",
        "profile_expiry",
        "reconciliation",
      ].map(kind => ({
        kind,
        commercialEnabled: true,
        authorizationEpoch: 2,
        enabled: true,
        executionEpoch: 2,
        actorUserId: 7,
        requestId: OPERATOR_INPUT.requestId,
      }));
      if (scenario === "missing_lane") rows.pop();
      if (scenario === "epoch") rows[0]!.executionEpoch = 3;
      if (scenario === "control") rows[0]!.commercialEnabled = false;
      if (scenario === "disabled_lane") rows[0]!.enabled = false;
      if (scenario === "request") rows[0]!.requestId = "other-request";
      if (scenario === "owner") rows[0]!.actorUserId = 8;
      const limit = vi.fn(async () => rows);
      const where = vi.fn(() => ({ limit }));
      const database = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where })) })),
        })),
      };
      getDatabaseOrThrowMock.mockResolvedValue(database);
      const result = assertTestPaymentOperatorReadback({
        workspaceId: 10,
        actorUserId: 7,
        requestId: OPERATOR_INPUT.requestId,
        executionEpoch: 2,
      });
      if (scenario === "matching")
        await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("readback mismatch");
      expect(
        new MySqlDialect().sqlToQuery(where.mock.calls[0]![0]).params
      ).toEqual([10, "test"]);
      expect(limit).toHaveBeenCalledWith(5);
    }
  );

  it("locks the actual owner and scopes the empty-work check before audited activation", async () => {
    const { tx, audit, locks, queries } = operatorDatabase();
    await expect(enableBillingSchedulerTenant(OPERATOR_INPUT)).resolves.toEqual(
      { executionEpoch: 2 }
    );
    expect(locks).toEqual([
      workspaces,
      billingExecutionControls,
      billingSchedulerTenants,
    ]);
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(queries[1].params).toEqual([10, "owner"]);
    const workQuery = queries.find(query => query.sql.includes("AS blocked"))!;
    expect(workQuery.params).toEqual(Array(7).fill(10));
    expect(workQuery.sql).toMatch(
      /billing_outbox` WHERE[^)]*'pending','processing','failed'/
    );
    expect(workQuery.sql).toMatch(
      /billing_notification_receiver_outbox` WHERE[^)]*'pending','processing','dead_letter'/
    );
    for (const table of [
      "billing_provider_operations",
      "billing_subscriptions",
      "billing_webhook_routes",
      "payment_ledger",
      "billing_intents",
      "billing_outbox",
      "billing_notification_receiver_outbox",
    ]) {
      expect(workQuery.sql).toContain(table);
    }
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        metadata: expect.objectContaining({
          operator: OPERATOR_AUDIT,
          onBehalfOfOwnerUserId: 7,
        }),
      })
    );
  });

  it("replays exact provenance without a second audit, but rejects changed run evidence", async () => {
    const { audit, tx } = operatorDatabase();
    await enableBillingSchedulerTenant(OPERATOR_INPUT);
    await expect(enableBillingSchedulerTenant(OPERATOR_INPUT)).resolves.toEqual(
      { executionEpoch: 2 }
    );
    expect(audit).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledTimes(2);
    await expect(
      enableBillingSchedulerTenant({
        ...OPERATOR_INPUT,
        operatorAudit: { ...OPERATOR_AUDIT, githubRunId: "457" },
      })
    ).rejects.toThrow("request conflicts");
    expect(audit).toHaveBeenCalledOnce();
  });

  it.each(["missing", "ambiguous", "non_admin", "changed"])(
    "rejects %s ownership before mutations",
    async reason => {
      const { state, tx } = operatorDatabase();
      if (reason === "missing") state.owners = [];
      if (reason === "ambiguous")
        state.owners.push({ ownerUserId: 8, userRole: "admin" });
      if (reason === "non_admin") state.owners[0]!.userRole = "user";
      if (reason === "changed") state.owners[0]!.ownerUserId = 8;
      await expect(
        enableBillingSchedulerTenant(OPERATOR_INPUT)
      ).rejects.toThrow("billing operator owner");
      expect(tx.update).not.toHaveBeenCalled();
      expect(tx.insert).not.toHaveBeenCalled();
    }
  );

  it.each([
    "operatorImage",
    "artifactSourceSha",
    "bundleSha256",
    "runtimeImage",
  ] as const)("binds the durable replay to %s", async field => {
    const { audit, tx } = operatorDatabase();
    await enableBillingSchedulerTenant(OPERATOR_INPUT);
    const replacement = field.endsWith("Image")
      ? `registry.fly.io/leaderbot-fb-image-gen@sha256:${"1".repeat(64)}`
      : "1".repeat(field === "artifactSourceSha" ? 40 : 64);
    await expect(
      enableBillingSchedulerTenant({
        ...OPERATOR_INPUT,
        operatorAudit: { ...OPERATOR_AUDIT, [field]: replacement },
      })
    ).rejects.toThrow("request conflicts");
    expect(audit).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    [],
    {},
    [{ principalSha256: OPERATOR_AUDIT.runtimePrincipalSha256 }],
    "invalid",
  ])("rejects malformed scalar query rows before writes: %j", async row => {
    const { tx } = operatorDatabase();
    tx.execute.mockResolvedValueOnce([[row]]);
    await expect(enableBillingSchedulerTenant(OPERATOR_INPUT)).rejects.toThrow(
      "principal mismatch"
    );
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { blocked: false }, { blocked: 1 }, { blocked: "" }])(
    "rejects malformed or nonempty work rows before writes: %j",
    async row => {
      const { tx } = operatorDatabase();
      tx.execute
        .mockResolvedValueOnce([
          [{ principalSha256: OPERATOR_AUDIT.runtimePrincipalSha256 }],
        ])
        .mockResolvedValueOnce([[row]]);
      await expect(
        enableBillingSchedulerTenant(OPERATOR_INPUT)
      ).rejects.toThrow("work is not empty");
      expect(tx.update).not.toHaveBeenCalled();
    }
  );

  it("resolves ownership without mutating or accepting two owners", async () => {
    const { state, tx } = operatorDatabase();
    await expect(resolveBillingOperatorOwner(10)).resolves.toBe(7);
    state.owners.push({ ownerUserId: 8, userRole: "admin" });
    await expect(resolveBillingOperatorOwner(10)).rejects.toThrow(
      "owner unavailable"
    );
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each([
    "principal",
    "work",
    "epoch",
    "lane",
    "pending_counter",
    "failed_counter",
  ])("rejects %s drift before mutation", async reason => {
    const { state, tx } = operatorDatabase();
    if (reason === "principal") state.principal = "c".repeat(64);
    if (reason === "work") state.blocked = 1;
    if (reason === "epoch") state.control.authorizationEpoch = 2;
    if (reason === "lane") state.lanes[0]!.executionEpoch = 2;
    if (reason === "pending_counter") state.lanes[0]!.pendingWorkCount = 1;
    if (reason === "failed_counter") state.lanes[0]!.deadLetterCount = 1;
    await expect(
      enableBillingSchedulerTenant(OPERATOR_INPUT)
    ).rejects.toThrow();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rejects live or malformed operator provenance before database access", async () => {
    await expect(
      enableBillingSchedulerTenant({ ...OPERATOR_INPUT, mode: "live" })
    ).rejects.toThrow("test-only");
    await expect(
      enableBillingSchedulerTenant({
        ...OPERATOR_INPUT,
        operatorAudit: { ...OPERATOR_AUDIT, sourceSha: "private-input" },
      })
    ).rejects.toThrow("provenance");
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });

  it("propagates an audit write failure through the transaction", async () => {
    const { audit } = operatorDatabase();
    audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(enableBillingSchedulerTenant(OPERATOR_INPUT)).rejects.toThrow(
      "audit unavailable"
    );
  });
});

describe("billing scheduler lifecycle boundaries", () => {
  beforeEach(() => {
    getDatabaseOrThrowMock.mockReset();
    process.env.MOLLIE_BILLING_SCHEDULER_MODE = "multi_tenant";
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
  });

  it("fails closed before DB access when rollout mode is not explicit", async () => {
    delete process.env.MOLLIE_BILLING_SCHEDULER_MODE;
    const { claimNextBillingTenant } = await import("./billingSchedulerStore");
    await expect(claimNextBillingTenant("test")).rejects.toThrow(
      "MOLLIE_BILLING_SCHEDULER_MODE"
    );
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });

  it("registration never re-enables an operator-disabled existing row", async () => {
    const duplicateSet = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onDuplicateKeyUpdate: duplicateSet }));
    const tx = { insert: vi.fn(() => ({ values })) };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await registerBillingSchedulerTenant(10, "test", new Date("2030-01-01"));

    expect(duplicateSet).toHaveBeenCalledTimes(5);
    const insertedRows = values.mock.calls.slice(1).map(call => call[0]);
    expect(insertedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "outbox", enabled: true }),
        expect.objectContaining({ kind: "reconciliation", enabled: false }),
        expect.objectContaining({ kind: "profile_expiry", enabled: false }),
        expect.objectContaining({ kind: "ai_finalization", enabled: false }),
      ])
    );
    const update = duplicateSet.mock.calls[1]![0] as {
      set: Record<string, unknown>;
    };
    expect(update.set).not.toHaveProperty("enabled");
    expect(update.set).not.toHaveProperty("mode");
  });

  it("checkout wake-up fails closed for missing or disabled registry rows", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(updateDatabaseResult(0));
    await expect(wakeBillingSchedulerTenant(10, "test")).resolves.toBe(false);

    getDatabaseOrThrowMock.mockResolvedValue(updateDatabaseResult(1));
    await expect(wakeBillingSchedulerTenant(10, "test")).resolves.toBe(true);
  });

  it("enables all four lanes only through the fenced audited operator flow", async () => {
    const rows = [
      "ai_finalization",
      "outbox",
      "profile_expiry",
      "reconciliation",
    ].map(kind => ({
      id: kind,
      workspaceId: 10,
      mode: "test",
      kind,
      enabled: false,
      executionEpoch: 1,
      operatorRequestId: null,
      operatorRequestFingerprint: null,
    }));
    const auditValues = vi.fn(async () => undefined);
    const controlWhere = vi.fn(async () => [{ affectedRows: 1 }]);
    const laneWhere = vi.fn(async () => [{ affectedRows: 4 }]);
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({
                for: vi.fn(async () => [
                  { commercialEnabled: false, authorizationEpoch: 1 },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ for: vi.fn(async () => rows) })),
            })),
          })),
        }),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: vi.fn(() => ({ where: controlWhere })) })
        .mockReturnValueOnce({ set: vi.fn(() => ({ where: laneWhere })) }),
      insert: vi.fn(() => ({ values: auditValues })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(
      enableBillingSchedulerTenant({
        workspaceId: 10,
        mode: "test",
        actorUserId: 7,
        requestId: "77777777-7777-4777-8777-777777777777",
        expectedExecutionEpoch: 1,
        reason: "approved pilot rollout",
      })
    ).resolves.toEqual({ executionEpoch: 2 });
    expect(controlWhere).toHaveBeenCalledOnce();
    expect(laneWhere).toHaveBeenCalledOnce();
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 10,
        userId: 7,
        event: "billing_scheduler_enabled",
      })
    );
  });

  it("detects stale-owner lease release instead of reporting scheduler success", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(updateDatabaseResult(0));
    await expect(
      releaseBillingTenantLease({
        workspaceId: 10,
        mode: "test",
        kind: "outbox",
        leaseToken: "stale-token",
        nextAt: new Date("2030-01-02"),
        failed: false,
      })
    ).resolves.toBe(false);
  });

  it("contains known and reconciles ambiguous customerless credit Payments on disable", async () => {
    const knownIntentId = "11111111-1111-4111-8111-111111111111";
    const ambiguousIntentId = "22222222-2222-4222-8222-222222222222";
    const knownOperationId = "33333333-3333-4333-8333-333333333333";
    const ambiguousOperationId = "44444444-4444-4444-8444-444444444444";
    const paymentId = "tr_creditknown1";
    const creditIntent = (intentId: string, marker: string) => ({
      intentId,
      kind: "credit_purchase",
      planCode: "premium_images_8_medium_v1",
      expectedAmount: "4.99",
      currency: "EUR",
      interval: "oneoff",
      mollieDescription: "Leaderbot - 8 premium beeldcredits",
      molliePaymentId: null,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
      messengerChannelConnectionId: 7,
      messengerBindingEpoch: 3,
      messengerPrivacyEpoch: 4,
      creditWalletId: `${marker.repeat(8)}-${marker.repeat(4)}-8${marker.repeat(3)}-8${marker.repeat(3)}-${marker.repeat(12)}`,
      creditFinancialSubjectRef: marker.repeat(64),
      creditCount: 8,
      creditMetadataHash: marker.repeat(64),
    });
    const knownIntent = creditIntent(knownIntentId, "a");
    const ambiguousIntent = creditIntent(ambiguousIntentId, "b");
    const schedulerRows = [
      "ai_finalization",
      "outbox",
      "profile_expiry",
      "reconciliation",
    ].map(kind => ({
      kind,
      enabled: true,
      executionEpoch: 2,
      operatorRequestId: null,
      operatorRequestFingerprint: null,
    }));
    const selectRows = [
      [{ commercialEnabled: true, authorizationEpoch: 2 }],
      [{ intentId: knownIntentId }, { intentId: ambiguousIntentId }],
      schedulerRows,
      [knownIntent, ambiguousIntent],
      [
        {
          operationId: knownOperationId,
          operationType: "create_payment",
          operationKey: knownIntentId,
          intentId: knownIntentId,
          state: "succeeded",
          providerResourceId: paymentId,
          providerCustomerId: null,
          requestFingerprint: knownIntent.creditMetadataHash,
          authorizationEpoch: 2,
          billingProfileVersion: 0,
          credentialGenerationId: "credential-v1",
        },
        {
          operationId: ambiguousOperationId,
          operationType: "create_payment",
          operationKey: ambiguousIntentId,
          intentId: ambiguousIntentId,
          state: "reconciliation_only",
          providerResourceId: null,
          providerCustomerId: null,
          requestFingerprint: ambiguousIntent.creditMetadataHash,
          authorizationEpoch: 2,
          billingProfileVersion: 0,
          credentialGenerationId: "credential-v1",
        },
      ],
      [{ workspaceId: 10, intentId: knownIntentId }],
      [],
    ];
    let selected = 0;
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = selectRows[selected++] ?? [];
          const locked = vi.fn(async () => rows);
          return {
            for: locked,
            limit: vi.fn(() => ({ for: locked })),
            orderBy: vi.fn(() => ({ for: locked })),
          };
        }),
      })),
    }));
    const updates: Array<{ table: unknown; value: Record<string, unknown> }> =
      [];
    let updateIndex = 0;
    const updateAffectedRows = [1, 4, 2, 1, 1];
    const inserts: Array<Record<string, unknown>> = [];
    const tx = {
      select,
      update: vi.fn((table: unknown) => ({
        set: vi.fn((value: Record<string, unknown>) => {
          updates.push({ table, value });
          return {
            where: vi.fn(async () => [
              { affectedRows: updateAffectedRows[updateIndex++] ?? 1 },
            ]),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return {
            onDuplicateKeyUpdate: vi.fn(async () => undefined),
          };
        }),
      })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(
      disableBillingSchedulerTenant({
        workspaceId: 10,
        mode: "test",
        actorUserId: 7,
        requestId: "55555555-5555-4555-8555-555555555555",
        expectedExecutionEpoch: 2,
        reason: "disable customerless credit checkout",
      })
    ).resolves.toEqual({ executionEpoch: 3 });

    const creditCancels = inserts.filter(
      value =>
        value.eventType === "cancel_payment" &&
        (value.payload as Record<string, unknown>)?.creditPurpose ===
          "premium_image_credits"
    );
    expect(creditCancels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            providerOperationId: knownOperationId,
            targetCustomerId: null,
            targetPaymentId: paymentId,
            creditWalletId: knownIntent.creditWalletId,
            creditMetadataHash: knownIntent.creditMetadataHash,
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            providerOperationId: ambiguousOperationId,
            targetCustomerId: null,
            targetPaymentId: null,
            creditWalletId: ambiguousIntent.creditWalletId,
            creditMetadataHash: ambiguousIntent.creditMetadataHash,
          }),
        }),
      ])
    );
    expect(
      updates.filter(item =>
        Object.prototype.hasOwnProperty.call(item.value, "resolutionDueAt")
      )
    ).toHaveLength(1);
  });

  it.each([
    ["owned", [{ workspaceId: 10 }]],
    ["lost", []],
  ] as const)(
    "atomically treats a transaction lease as %s",
    async (state, rows) => {
      const forUpdate = vi.fn(async () => rows);
      const query = {
        limit: vi.fn(() => ({ for: forUpdate })),
      };
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn(() => query) })),
        })),
      } as never;
      const assertion = assertBillingTenantLeaseOwnedInTransaction(tx, {
        workspaceId: 10,
        mode: "test",
        kind: "reconciliation",
        leaseToken: "lease-token",
        executionEpoch: 2,
      });
      if (state === "owned") {
        await expect(assertion).resolves.toBeUndefined();
      } else {
        await expect(assertion).rejects.toThrow(
          "billing scheduler lease ownership was lost"
        );
      }
      expect(forUpdate).toHaveBeenCalledOnce();
    }
  );
});

function updateDatabaseResult(affectedRows: number) {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => [{ affectedRows }]),
      })),
    })),
  };
}
