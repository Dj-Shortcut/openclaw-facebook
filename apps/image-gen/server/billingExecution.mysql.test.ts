import { createHash, randomUUID } from "node:crypto";

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertBillingTriggerRuntimePreflight } from "../scripts/billing-trigger-runtime-preflight.mjs";
import {
  creditWalletRoutineNames,
  productionRuntimeWritableTableNames,
} from "../scripts/production-schema-contract.mjs";

const databaseMock = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ getDatabaseOrThrow: databaseMock }));
import {
  enableTestPayments,
  readTestPaymentOperatorEnv,
} from "./_core/billing/testPaymentOperator";
import { enableBillingSchedulerTenant } from "./_core/billing/billingSchedulerStore";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);

suite("billing trigger MySQL runtime boundary", () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await connection?.end();
  });

  it("executes every retained billing trigger and rolls back all probe data", async () => {
    const [[database]] = await connection.query<RowDataPacket[]>(
      "SELECT DATABASE() AS databaseName"
    );
    const databaseName = String(database.databaseName ?? "");
    expect(databaseName).not.toBe("");

    const runtimeUser = `lb_ci_rt_${process.pid}_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 8)}`;
    const runtimePassword = randomUUID().replaceAll("-", "");
    const databaseIdentifier = mysql.escapeId(databaseName);
    let runtimePrincipalCreated = false;

    try {
      await connection.query(
        `CREATE USER \`${runtimeUser}\`@'%' IDENTIFIED BY '${runtimePassword}'`
      );
      runtimePrincipalCreated = true;
      await connection.query(
        `GRANT SELECT ON ${databaseIdentifier}.* TO \`${runtimeUser}\`@'%'`
      );
      for (const tableName of productionRuntimeWritableTableNames) {
        await connection.query(
          `GRANT INSERT, UPDATE, DELETE ON ${databaseIdentifier}.${mysql.escapeId(tableName)} TO \`${runtimeUser}\`@'%'`
        );
      }
      for (const routineName of creditWalletRoutineNames) {
        await connection.query(
          `GRANT EXECUTE ON PROCEDURE ${databaseIdentifier}.${mysql.escapeId(routineName)} TO \`${runtimeUser}\`@'%'`
        );
      }

      const runtimeUrl = new URL(process.env.DATABASE_URL!);
      runtimeUrl.username = runtimeUser;
      runtimeUrl.password = runtimePassword;
      const runtimeConnection = await mysql.createConnection(runtimeUrl.href);
      try {
        await assertBillingTriggerRuntimePreflight(runtimeConnection, "test");
      } finally {
        await runtimeConnection.end();
      }
    } finally {
      if (runtimePrincipalCreated) {
        await connection.query(`DROP USER \`${runtimeUser}\`@'%'`);
      }
    }
  });

  it("activates Test processing with the restricted principal and real owner, replaying only once", async () => {
    const [[database]] = await connection.query<RowDataPacket[]>(
      "SELECT DATABASE() AS databaseName"
    );
    const databaseIdentifier = mysql.escapeId(String(database.databaseName));
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const runtimeUser = `lb_ci_op_${suffix}`;
    const runtimePassword = randomUUID().replaceAll("-", "");
    const principalSha256 = createHash("sha256")
      .update(runtimeUser)
      .digest("hex");
    let principalCreated = false;
    let runtimeConnection: Connection | undefined;
    let workspaceId: number | undefined;
    const userIds: number[] = [];
    try {
      await connection.query(
        `CREATE USER \`${runtimeUser}\`@'%' IDENTIFIED BY '${runtimePassword}'`
      );
      principalCreated = true;
      await connection.query(
        `GRANT SELECT ON ${databaseIdentifier}.* TO \`${runtimeUser}\`@'%'`
      );
      for (const tableName of productionRuntimeWritableTableNames) {
        await connection.query(
          `GRANT INSERT, UPDATE, DELETE ON ${databaseIdentifier}.${mysql.escapeId(tableName)} TO \`${runtimeUser}\`@'%'`
        );
      }
      for (const routineName of creditWalletRoutineNames) {
        await connection.query(
          `GRANT EXECUTE ON PROCEDURE ${databaseIdentifier}.${mysql.escapeId(routineName)} TO \`${runtimeUser}\`@'%'`
        );
      }
      for (const label of ["owner", "other"]) {
        const [inserted] = await connection.query<ResultSetHeader>(
          "INSERT INTO users (openId,role) VALUES (?,'admin')",
          [`operator-ci-${suffix}-${label}`]
        );
        userIds.push(inserted.insertId);
      }
      const [workspace] = await connection.query<ResultSetHeader>(
        "INSERT INTO workspaces (name,slug) VALUES (?,?)",
        ["Synthetic operator proof", `operator-ci-${suffix}`]
      );
      workspaceId = workspace.insertId;
      await connection.query(
        "INSERT INTO workspaceMembers (workspaceId,userId,role) VALUES (?,?,'owner')",
        [workspaceId, userIds[0]]
      );
      const runtimeUrl = new URL(process.env.DATABASE_URL!);
      runtimeUrl.username = runtimeUser;
      runtimeUrl.password = runtimePassword;
      runtimeConnection = await mysql.createConnection(runtimeUrl.href);
      databaseMock.mockResolvedValue(drizzle(runtimeConnection));
      const requestId = randomUUID();
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        MOLLIE_MODE: "test",
        MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
        MOLLIE_CREDIT_WORKSPACE_ID: String(workspaceId),
        MOLLIE_BILLING_WORKER_WORKSPACE_ID: String(workspaceId),
        BILLING_NOTIFICATION_PLANE_ENABLED: "true",
        MOLLIE_BILLING_DRAIN_ENABLED: "true",
        MOLLIE_RECONCILIATION_ENABLED: "true",
        MOLLIE_BILLING_ENABLED: "false",
        MOLLIE_LIVE_BILLING_ENABLED: "false",
        MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
        MESSENGER_PAID_CREDITS_ENABLED: "false",
        LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-1",
        EXPECTED_RUNTIME_PRINCIPAL_SHA256: principalSha256,
        LEADERBOT_TEST_PAYMENT_OPERATOR_WORKSPACE_ID: String(workspaceId),
        LEADERBOT_TEST_PAYMENT_OPERATOR_REQUEST_ID: requestId,
        LEADERBOT_TEST_PAYMENT_OPERATOR_EXPECTED_EPOCH: "1",
        LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_ACTOR_ID: "123",
        LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_RUN_ID: "456",
        LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_RUN_ATTEMPT: "1",
        LEADERBOT_TEST_PAYMENT_OPERATOR_SOURCE_SHA: "a".repeat(40),
        LEADERBOT_TEST_PAYMENT_OPERATOR_DEPLOYMENT_IDENTITY: "deploy-123-1",
      };
      // A persisted but non-admin owner must fail before even registration.
      await connection.query("UPDATE users SET role='user' WHERE id=?", [
        userIds[0],
      ]);
      await expect(enableTestPayments(env)).rejects.toMatchObject({
        failedStage: "owner",
      });
      const [[unregistered]] = await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM billing_execution_controls WHERE workspace_id=?",
        [workspaceId]
      );
      expect(Number(unregistered.total)).toBe(0);
      await connection.query("UPDATE users SET role='admin' WHERE id=?", [
        userIds[0],
      ]);
      const first = await enableTestPayments(env);
      expect(first).toMatchObject({
        executionEpoch: 2,
        committed: true,
        workspaceId,
      });
      await expect(enableTestPayments(env)).resolves.toEqual(first);
      const snapshot = async () => {
        const [controls] = await connection.query<RowDataPacket[]>(
          "SELECT commercial_enabled,authorization_epoch FROM billing_execution_controls WHERE workspace_id=? AND mode='test'",
          [workspaceId]
        );
        const [lanes] = await connection.query<RowDataPacket[]>(
          "SELECT kind,enabled,execution_epoch,operator_request_id,operator_request_fingerprint,enabled_by_user_id FROM billing_scheduler_tenants WHERE workspace_id=? AND mode='test' ORDER BY kind",
          [workspaceId]
        );
        const [audits] = await connection.query<RowDataPacket[]>(
          "SELECT userId,metadata FROM auditLog WHERE workspaceId=? AND event='billing_scheduler_enabled'",
          [workspaceId]
        );
        return { controls, lanes, audits };
      };
      const committed = await snapshot();
      expect(committed.controls).toMatchObject([
        { commercial_enabled: 1, authorization_epoch: 2 },
      ]);
      expect(committed.lanes).toHaveLength(4);
      for (const lane of committed.lanes)
        expect(lane).toMatchObject({
          enabled: 1,
          execution_epoch: 2,
          operator_request_id: requestId,
          enabled_by_user_id: userIds[0],
        });
      expect(committed.audits).toHaveLength(1);
      const metadata =
        typeof committed.audits[0].metadata === "string"
          ? JSON.parse(committed.audits[0].metadata)
          : committed.audits[0].metadata;
      expect(metadata.operator).toEqual(
        readTestPaymentOperatorEnv(env).operatorAudit
      );
      const input = {
        ...readTestPaymentOperatorEnv(env),
        actorUserId: userIds[0]!,
        mode: "test" as const,
        reason: "protected workflow test payment preparation",
      };
      await expect(
        enableBillingSchedulerTenant({ ...input, actorUserId: userIds[1]! })
      ).rejects.toThrow("owner changed");
      await expect(
        enableBillingSchedulerTenant({ ...input, requestId: randomUUID() })
      ).rejects.toThrow("epoch mismatch");
      await expect(
        enableBillingSchedulerTenant({
          ...input,
          operatorAudit: { ...input.operatorAudit, githubRunId: "457" },
        })
      ).rejects.toThrow("request conflicts");
      expect(await snapshot()).toEqual(committed);
    } finally {
      databaseMock.mockReset();
      await runtimeConnection?.end();
      if (workspaceId !== undefined) {
        for (const [table, key] of [
          ["auditLog", "workspaceId"],
          ["billing_scheduler_tenants", "workspace_id"],
          ["billing_execution_controls", "workspace_id"],
          ["workspaceMembers", "workspaceId"],
          ["workspaces", "id"],
        ]) {
          await connection.query(
            `DELETE FROM ${mysql.escapeId(table)} WHERE ${mysql.escapeId(key)}=?`,
            [workspaceId]
          );
        }
      }
      for (const userId of userIds)
        await connection.query("DELETE FROM users WHERE id=?", [userId]);
      if (principalCreated)
        await connection.query(`DROP USER \`${runtimeUser}\`@'%'`);
    }
  });
});
