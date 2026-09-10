import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingExecutionControls,
  billingSchedulerProcessHeartbeats,
  billingSchedulerTenants,
  workspaceBillingProfiles,
} from "../../../drizzle/schema";

const mocks = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock("../../db", () => ({ getDatabaseOrThrow: mocks.getDatabase }));

import { assertBillingDatabaseReadiness } from "./billingReadiness";

const dialect = new MySqlDialect();
const kinds = ["outbox", "reconciliation", "profile_expiry", "ai_finalization"];

function databaseReturning(
  options: {
    missingControl?: boolean;
    staleLane?: boolean;
    missingHeartbeat?: boolean;
    otherOwnerEnabled?: boolean;
  } = {}
) {
  const profileRead = vi.fn();
  const predicates: Array<{ sql: string; params: unknown[] }> = [];
  const database = {
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (predicate: SQL) => {
          const query = dialect.sqlToQuery(predicate);
          predicates.push(query);
          let rows: unknown[] = [];
          if (!query.sql.includes("1 = 0")) {
            if (table === billingExecutionControls && !options.missingControl) {
              rows = [
                {
                  workspaceId: 1,
                  commercialEnabled: true,
                  authorizationEpoch: 2,
                },
              ];
            } else if (table === billingSchedulerTenants) {
              rows =
                "count" in fields
                  ? [{ count: options.otherOwnerEnabled ? 1 : 0 }]
                  : kinds.map(kind => ({
                      workspaceId: 1,
                      kind,
                      enabled: true,
                      executionEpoch: options.staleLane ? 1 : 2,
                      operatorRequestId: "reviewed-request",
                      enabledByUserId: 91,
                      enabledAt: new Date("2026-09-01"),
                      deadLetterCount: 0,
                    }));
            } else if (table === billingSchedulerProcessHeartbeats) {
              rows = [{ laneCount: options.missingHeartbeat ? 0 : 3 }];
            } else if (table === workspaceBillingProfiles) {
              profileRead();
            }
          }
          const result = Promise.resolve(rows);
          return Object.assign(result, { limit: () => result });
        },
      }),
    })),
  };
  mocks.getDatabase.mockResolvedValue(database);
  return { profileRead, predicates };
}

describe("credit readiness without the retired customer portal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const [name, value] of Object.entries({
      MOLLIE_BILLING_ENABLED: "false",
      MOLLIE_BILLING_DRAIN_ENABLED: "true",
      MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
      MOLLIE_BILLING_WORKER_WORKSPACE_ID: "1",
      MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED: "false",
      AI_ANSWER_FINALIZATION_DRAIN_ENABLED: "false",
      AI_ANSWER_QUOTA_PREFLIGHT_ENABLED: "false",
      BILLING_NOTIFICATION_PLANE_ENABLED: "true",
      MOLLIE_RECONCILIATION_ENABLED: "true",
      FLY_MACHINE_ID: "test-machine",
    }))
      vi.stubEnv(name, value);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])(
    "checks actual DB readiness without querying a portal profile (heartbeat=%s)",
    async requireRuntimeHeartbeat => {
      const { profileRead, predicates } = databaseReturning();
      await expect(
        assertBillingDatabaseReadiness("test", { requireRuntimeHeartbeat })
      ).resolves.toBeUndefined();
      expect(profileRead).not.toHaveBeenCalled();
      expect(predicates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ params: ["test", 1] }),
        ])
      );
    }
  );

  it("still rejects new legacy sales without an eligible profile", async () => {
    vi.stubEnv("MOLLIE_BILLING_ENABLED", "true");
    const { profileRead } = databaseReturning();
    await expect(
      assertBillingDatabaseReadiness("test", { requireRuntimeHeartbeat: false })
    ).rejects.toThrow("Pinned billing workspace has no eligible profile");
    expect(profileRead).toHaveBeenCalledOnce();
  });

  it.each([
    [{ missingControl: true }, "No billing execution control"],
    [{ staleLane: true }, "execution epochs are incoherent"],
    [{ missingHeartbeat: true }, "process heartbeat is incomplete"],
    [{ otherOwnerEnabled: true }, "exceeds pilot pin"],
  ] as const)(
    "retains operational rejection for %j",
    async (options, message) => {
      const { profileRead } = databaseReturning(options);
      await expect(assertBillingDatabaseReadiness("test")).rejects.toThrow(
        message
      );
      expect(profileRead).not.toHaveBeenCalled();
    }
  );
});
