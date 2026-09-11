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
import {
  enableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
} from "./_core/billing/billingSchedulerStore";

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
        LEADERBOT_TEST_PAYMENT_OPERATOR_OPERATOR_IMAGE: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"b".repeat(64)}`,
        LEADERBOT_TEST_PAYMENT_OPERATOR_ARTIFACT_SOURCE_SHA: "c".repeat(40),
        LEADERBOT_TEST_PAYMENT_OPERATOR_BUNDLE_SHA256: "d".repeat(64),
        LEADERBOT_TEST_PAYMENT_OPERATOR_RUNTIME_IMAGE: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"e".repeat(64)}`,
      };
      const snapshot = async () => {
        const [controls] = await connection.query<RowDataPacket[]>(
          "SELECT commercial_enabled,authorization_epoch FROM billing_execution_controls WHERE workspace_id=? AND mode='test'",
          [workspaceId]
        );
        const [lanes] = await connection.query<RowDataPacket[]>(
          "SELECT kind,enabled,execution_epoch,pending_work_count,dead_letter_count,operator_request_id,operator_request_fingerprint,enabled_by_user_id FROM billing_scheduler_tenants WHERE workspace_id=? AND mode='test' ORDER BY kind",
          [workspaceId]
        );
        const [audits] = await connection.query<RowDataPacket[]>(
          "SELECT userId,metadata FROM auditLog WHERE workspaceId=? AND event='billing_scheduler_enabled'",
          [workspaceId]
        );
        return { controls, lanes, audits };
      };
      // Neither a non-admin owner nor missing registration may create controls.
      await connection.query("UPDATE users SET role='user' WHERE id=?", [
        userIds[0],
      ]);
      await expect(enableTestPayments(env)).rejects.toMatchObject({
        failedStage: "owner",
      });
      expect(await snapshot()).toEqual({ controls: [], lanes: [], audits: [] });
      await connection.query("UPDATE users SET role='admin' WHERE id=?", [
        userIds[0],
      ]);
      await expect(enableTestPayments(env)).rejects.toMatchObject({
        failedStage: "activation",
        committed: false,
      });
      expect(await snapshot()).toEqual({ controls: [], lanes: [], audits: [] });

      // Provision only this disposable fixture explicitly; the operator does
      // not create or reset scheduler state as a side effect of an enable.
      await registerBillingSchedulerTenant(workspaceId, "test");
      const failedDeliveryId = randomUUID();
      const [failedOutbox] = await connection.query<ResultSetHeader>(
        "INSERT INTO billing_outbox (delivery_id,workspace_id,mode,event_type,deduplication_key,payload,status,attempt_count,max_attempts,last_error_code) VALUES (?,?,'test','manual_review',?,JSON_OBJECT('reason','synthetic_operator_failed_outbox'),'failed',1,1,'synthetic_operator_failure')",
        [failedDeliveryId, workspaceId, `operator-ci-failed-${suffix}`]
      );
      const blocked = await snapshot();
      expect(blocked.controls).toMatchObject([
        { commercial_enabled: 0, authorization_epoch: 1 },
      ]);
      expect(blocked.lanes).toHaveLength(4);
      expect(blocked.lanes.find(lane => lane.kind === "outbox")).toMatchObject({
        pending_work_count: 0,
        dead_letter_count: 1,
      });
      expect(blocked.audits).toEqual([]);
      await expect(enableTestPayments(env)).rejects.toMatchObject({
        failedStage: "activation",
        committed: false,
      });
      expect(await snapshot()).toEqual(blocked);
      // The real counter trigger handles status transitions, not DELETE.
      // Complete only this synthetic row before removing it from the fixture.
      await connection.query(
        "UPDATE billing_outbox SET status='completed' WHERE id=? AND workspace_id=? AND delivery_id=? AND status='failed'",
        [failedOutbox.insertId, workspaceId, failedDeliveryId]
      );
      await connection.query(
        "DELETE FROM billing_outbox WHERE id=? AND workspace_id=? AND delivery_id=?",
        [failedOutbox.insertId, workspaceId, failedDeliveryId]
      );
      const cleared = await snapshot();
      expect(cleared.controls).toEqual(blocked.controls);
      expect(cleared.audits).toEqual([]);
      for (const lane of cleared.lanes) {
        expect(lane).toMatchObject({
          pending_work_count: 0,
          dead_letter_count: 0,
          execution_epoch: 1,
        });
      }
      const first = await enableTestPayments(env);
      expect(first).toMatchObject({
        executionEpoch: 2,
        committed: true,
        workspaceId,
      });
      await expect(enableTestPayments(env)).resolves.toEqual(first);
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
          ["billing_outbox", "workspace_id"],
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
