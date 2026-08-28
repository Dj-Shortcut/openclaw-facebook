import { createHash, randomUUID } from "node:crypto";

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);
const USER_KEY = "a".repeat(64);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Scope = {
  workspaceId: number;
  channelConnectionId: number;
  financialRef: string;
};

type Request = Scope & {
  intentId: string;
  walletId: string;
  idempotencyKey: string;
  checkoutScopeKey: string;
  capabilityHash: string;
  metadataHash: string;
};

suite("0018 atomic credit checkout reservation", () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
    await connection.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    await connection.query("SET SESSION sql_require_primary_key=ON");
  });

  afterAll(async () => connection?.end());

  async function createScope(): Promise<Scope> {
    const suffix = randomUUID();
    const [workspace] = await connection.query<ResultSetHeader>(
      "INSERT INTO `workspaces` (`name`,`slug`) VALUES (?,?)",
      ["0018 checkout", `credit-checkout-${suffix}`]
    );
    const workspaceId = workspace.insertId;
    await connection.query(
      "INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`) VALUES (?,'test',true,2)",
      [workspaceId]
    );
    const [channel] = await connection.query<ResultSetHeader>(
      "INSERT INTO `channelConnections` (`workspaceId`,`channel`,`status`,`externalId`,`bindingEpoch`) VALUES (?,'facebook_messenger','connected',?,1)",
      [workspaceId, `page-${suffix}`]
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
      [workspaceId, channel.insertId, USER_KEY]
    );
    return {
      workspaceId,
      channelConnectionId: channel.insertId,
      financialRef: hash(`financial:${suffix}`),
    };
  }

  function request(scope: Scope, label = randomUUID()): Request {
    return {
      ...scope,
      intentId: randomUUID(),
      walletId: randomUUID(),
      idempotencyKey: "",
      checkoutScopeKey: `credit-checkout:v1:${hash(`scope:${label}`)}`,
      capabilityHash: hash(`capability:${label}`),
      metadataHash: hash(`metadata:${label}`),
    } as Request;
  }

  async function reserve(client: Connection, value: Request) {
    const [rows] = await client.query<RowDataPacket[][]>(
      "CALL `credit_reserve_checkout_intent`(?,?,?,'test',?,1,1,?,?,2,'premium_images_8_medium_v1','4.99',8,'Leaderbot - 8 premium beeldcredits',?,?,?,?,TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
      [
        value.intentId,
        value.walletId,
        value.workspaceId,
        value.channelConnectionId,
        USER_KEY,
        value.financialRef,
        value.metadataHash,
        `credit-payment:${value.intentId}`,
        value.checkoutScopeKey,
        value.capabilityHash,
      ]
    );
    return rows[0]![0]!;
  }

  async function peer(): Promise<Connection> {
    const client = await mysql.createConnection(process.env.DATABASE_URL!);
    await client.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    return client;
  }

  async function waitForLockWait(
    client: Connection,
    expectedCount = 1
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [rows] = await client.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits"
      );
      if (Number(rows[0]?.count) >= expectedCount) return;
    }
    throw new Error("expected an overlapping InnoDB row-lock wait");
  }

  async function counts(value: Request) {
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `credit_wallets` WHERE `wallet_id`=?",
      [value.walletId]
    );
    const [[intent]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `billing_intents` WHERE `intent_id`=?",
      [value.intentId]
    );
    return { wallet: Number(wallet.count), intent: Number(intent.count) };
  }

  it("creates one wallet and intent and exact replay is idempotent", async () => {
    const value = request(await createScope());
    await expect(reserve(connection, value)).resolves.toMatchObject({
      result: "applied",
      intent_id: value.intentId,
      wallet_id: value.walletId,
    });
    await expect(reserve(connection, value)).resolves.toMatchObject({
      result: "already_applied",
      intent_id: value.intentId,
      wallet_id: value.walletId,
    });
    expect(await counts(value)).toEqual({ wallet: 1, intent: 1 });

    const [[stored]] = await connection.query<RowDataPacket[]>(
      "SELECT UNIX_TIMESTAMP(`checkout_capability_expires_at`) AS expiresAt FROM `billing_intents` WHERE `intent_id`=?",
      [value.intentId]
    );
    await connection.query("SET timestamp=?", [Number(stored.expiresAt) - 60]);
    await expect(reserve(connection, value)).resolves.toMatchObject({
      result: "already_applied",
      intent_id: value.intentId,
      wallet_id: value.walletId,
    });
    await connection.query("SET timestamp=?", [Number(stored.expiresAt) + 1]);
    await expect(reserve(connection, value)).rejects.toMatchObject({
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "credit checkout replay conflicts with immutable request",
    });
    await connection.query("SET timestamp=0");
  });

  it("rolls back a newly inserted wallet when intent insertion faults", async () => {
    const value = request(await createScope());
    await connection.query(
      `CREATE TRIGGER \`credit_0018_test_intent_fault\` BEFORE INSERT ON \`billing_intents\`
       FOR EACH ROW
       BEGIN
         IF BINARY NEW.\`intent_id\`=BINARY '${value.intentId}' THEN
           SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected intent insert failure';
         END IF;
       END`
    );
    try {
      await expect(reserve(connection, value)).rejects.toMatchObject({
        code: "ER_SIGNAL_EXCEPTION",
        sqlMessage: "injected intent insert failure",
      });
      expect(await counts(value)).toEqual({ wallet: 0, intent: 0 });
    } finally {
      await connection.query("DROP TRIGGER `credit_0018_test_intent_fault`");
    }
  });

  it("rejects caller-controlled offer or noncanonical payment keys", async () => {
    const value = request(await createScope());
    await expect(
      connection.query(
        "CALL `credit_reserve_checkout_intent`(?,?,?,'test',?,1,1,?,?,2,'premium_images_8_medium_v1','0.01',8000,'Leaderbot - 8 premium beeldcredits',?,?,?,?,TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
        [
          value.intentId,
          value.walletId,
          value.workspaceId,
          value.channelConnectionId,
          USER_KEY,
          value.financialRef,
          value.metadataHash,
          `wrong:${value.intentId}`,
          value.checkoutScopeKey,
          value.capabilityHash,
        ]
      )
    ).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
    expect(await counts(value)).toEqual({ wallet: 0, intent: 0 });
  });

  it("fails conflicting stable-scope replay without mutation", async () => {
    const scope = await createScope();
    const original = request(scope);
    await reserve(connection, original);
    const conflict = {
      ...request(scope),
      walletId: original.walletId,
      checkoutScopeKey: original.checkoutScopeKey,
    };
    await expect(reserve(connection, conflict)).rejects.toMatchObject({
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "credit checkout replay conflicts with immutable request",
    });
    expect(await counts(conflict)).toEqual({ wallet: 1, intent: 0 });
  });

  it("serializes duplicate requests without duplicate rows or lock failures", async () => {
    const value = request(await createScope());
    const blocker = await peer();
    const first = await peer();
    const second = await peer();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `workspace_id` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [value.workspaceId]
      );
      const one = reserve(first, value);
      const two = reserve(second, value);
      await waitForLockWait(connection);
      await blocker.commit();
      const settled = await Promise.allSettled([one, two]);
      expect(settled.every(result => result.status === "fulfilled")).toBe(true);
      const results = settled.map(result =>
        result.status === "fulfilled" ? result.value.result : "rejected"
      );
      expect(results.sort()).toEqual(["already_applied", "applied"]);
      expect(await counts(value)).toEqual({ wallet: 1, intent: 1 });
    } finally {
      await blocker.rollback().catch(() => undefined);
      await Promise.all([blocker.end(), first.end(), second.end()]);
    }
  });

  for (const race of ["disable", "disconnect", "privacy"] as const) {
    it(`lets ${race} win before reservation without unauthorized rows`, async () => {
      const value = request(await createScope());
      const blocker = await peer();
      const contender = await peer();
      try {
        await blocker.beginTransaction();
        if (race === "disable") {
          await blocker.query(
            "UPDATE `billing_execution_controls` SET `commercial_enabled`=false,`authorization_epoch`=3 WHERE `workspace_id`=? AND `mode`='test'",
            [value.workspaceId]
          );
        } else if (race === "disconnect") {
          await blocker.query(
            "UPDATE `channelConnections` SET `status`='disconnected',`bindingEpoch`=2 WHERE `id`=?",
            [value.channelConnectionId]
          );
        } else {
          await blocker.query(
            "UPDATE `messenger_privacy_subjects` SET `status`='erased',`privacy_epoch`=2,`erased_at`=CURRENT_TIMESTAMP WHERE `workspace_id`=? AND `channel_connection_id`=? AND `user_key`=?",
            [value.workspaceId, value.channelConnectionId, USER_KEY]
          );
        }
        const pending = reserve(contender, value).then(
          result => ({ status: "fulfilled" as const, result }),
          error => ({ status: "rejected" as const, error })
        );
        await waitForLockWait(connection);
        await blocker.commit();
        const expectedMessage = {
          disable: "credit checkout authorization is disabled or stale",
          disconnect: "credit checkout connection scope is stale",
          privacy: "credit checkout privacy scope is stale",
        }[race];
        const outcome = await pending;
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("unauthorized reservation unexpectedly succeeded");
        }
        expect(outcome.error).toMatchObject({
          code: "ER_SIGNAL_EXCEPTION",
          sqlMessage: expectedMessage,
        });
        expect(await counts(value)).toEqual({ wallet: 0, intent: 0 });
      } finally {
        await blocker.rollback().catch(() => undefined);
        await Promise.all([blocker.end(), contender.end()]);
      }
    });
  }

  it("serializes reserve before a concurrent disable without a lock cycle", async () => {
    const value = request(await createScope());
    const blocker = await peer();
    const reserver = await peer();
    const disabler = await peer();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `id` FROM `channelConnections` WHERE `id`=? FOR UPDATE",
        [value.channelConnectionId]
      );
      const pendingReserve = reserve(reserver, value);
      await waitForLockWait(connection);
      const pendingDisable = disabler.query(
        "UPDATE `billing_execution_controls` SET `commercial_enabled`=false,`authorization_epoch`=3 WHERE `workspace_id`=? AND `mode`='test'",
        [value.workspaceId]
      );
      await waitForLockWait(connection, 2);
      await blocker.commit();
      const [reserved, disabled] = await Promise.allSettled([
        pendingReserve,
        pendingDisable,
      ]);
      expect(reserved.status).toBe("fulfilled");
      expect(disabled.status).toBe("fulfilled");
      if (reserved.status === "fulfilled") {
        expect(reserved.value.result).toBe("applied");
      }
      expect(await counts(value)).toEqual({ wallet: 1, intent: 1 });
    } finally {
      await blocker.rollback().catch(() => undefined);
      await Promise.all([blocker.end(), reserver.end(), disabler.end()]);
    }
  });

  it("serializes reserve before a concurrent privacy erasure without a lock cycle", async () => {
    const scope = await createScope();
    const first = request(scope);
    await reserve(connection, first);
    const value = { ...request(scope), walletId: first.walletId };
    const blocker = await peer();
    const reserver = await peer();
    const eraser = await peer();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `wallet_id` FROM `credit_wallets` WHERE `wallet_id`=? FOR UPDATE",
        [value.walletId]
      );
      const pendingReserve = reserve(reserver, value);
      await waitForLockWait(connection);
      const pendingErase = eraser.query(
        "UPDATE `messenger_privacy_subjects` SET `status`='erased',`privacy_epoch`=2,`erased_at`=CURRENT_TIMESTAMP WHERE `workspace_id`=? AND `channel_connection_id`=? AND `user_key`=?",
        [value.workspaceId, value.channelConnectionId, USER_KEY]
      );
      await waitForLockWait(connection, 2);
      await blocker.commit();
      const [reserved, erased] = await Promise.allSettled([
        pendingReserve,
        pendingErase,
      ]);
      expect(reserved.status).toBe("fulfilled");
      expect(erased.status).toBe("fulfilled");
      if (reserved.status === "fulfilled") {
        expect(reserved.value.result).toBe("applied");
      }
      expect(await counts(value)).toEqual({ wallet: 1, intent: 1 });
    } finally {
      await blocker.rollback().catch(() => undefined);
      await Promise.all([blocker.end(), reserver.end(), eraser.end()]);
    }
  });
});
