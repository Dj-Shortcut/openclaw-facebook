import { createHash, randomUUID } from "node:crypto";

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listExpiredPristineCreditCheckouts } from "./_core/billing/creditReservationExpiryStore";
import { closeDatabasePool } from "./db";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);
const USER_KEY = "a".repeat(64);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Checkout = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  intentId: string;
  walletId: string;
  financialSubjectRef: string;
  capabilityHash: string;
}>;

suite("expired pristine credit checkout retention", () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
    await connection.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
  });

  afterAll(async () => {
    await connection?.end();
    await closeDatabasePool();
  });

  async function createCheckout(client = connection): Promise<Checkout> {
    const suffix = randomUUID();
    const [workspace] = await client.query<ResultSetHeader>(
      "INSERT INTO `workspaces` (`name`,`slug`) VALUES (?,?)",
      ["credit retention", `credit-retention-${suffix}`]
    );
    const workspaceId = workspace.insertId;
    await client.query(
      "INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`) VALUES (?,'test',true,2)",
      [workspaceId]
    );
    const [channel] = await client.query<ResultSetHeader>(
      "INSERT INTO `channelConnections` (`workspaceId`,`channel`,`status`,`externalId`,`bindingEpoch`) VALUES (?,'facebook_messenger','connected',?,1)",
      [workspaceId, `page-${suffix}`]
    );
    const channelConnectionId = channel.insertId;
    await client.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
      [workspaceId, channelConnectionId, USER_KEY]
    );
    const value = {
      workspaceId,
      channelConnectionId,
      intentId: randomUUID(),
      walletId: randomUUID(),
      financialSubjectRef: hash(`financial:${suffix}`),
      capabilityHash: hash(`capability:${suffix}`),
    };
    await client.query(
      "CALL `credit_reserve_checkout_intent`(?,?,?,'test',?,1,1,?,?,2,'premium_images_8_medium_v1','4.99',8,'Leaderbot - 8 premium beeldcredits',?,?,?, ?,TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
      [
        value.intentId,
        value.walletId,
        value.workspaceId,
        value.channelConnectionId,
        USER_KEY,
        value.financialSubjectRef,
        hash(`metadata:${suffix}`),
        `credit-payment:${value.intentId}`,
        `credit-checkout:v1:${hash(`scope:${suffix}`)}`,
        value.capabilityHash,
      ]
    );
    return value;
  }

  async function expireAt(
    client: Connection,
    value: Checkout
  ): Promise<number> {
    const [[row]] = await client.query<RowDataPacket[]>(
      "SELECT UNIX_TIMESTAMP(`checkout_capability_expires_at`) AS expiresAt FROM `billing_intents` WHERE `intent_id`=?",
      [value.intentId]
    );
    return Number(row.expiresAt) + 1;
  }

  async function cleanup(client: Connection, value: Checkout) {
    const [rows] = await client.query<RowDataPacket[][]>(
      "CALL `credit_expire_pristine_checkout`(?, 'test', ?, 1, 1, ?, ?, ?, ?)",
      [
        value.workspaceId,
        value.channelConnectionId,
        USER_KEY,
        value.walletId,
        value.financialSubjectRef,
        value.intentId,
      ]
    );
    return rows[0]![0]!;
  }

  async function counts(value: Checkout) {
    const [[row]] = await connection.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM `billing_intents` WHERE `intent_id`=?) AS intents,(SELECT COUNT(*) FROM `credit_wallets` WHERE `wallet_id`=?) AS wallets",
      [value.intentId, value.walletId]
    );
    return { intents: Number(row.intents), wallets: Number(row.wallets) };
  }

  async function peer(): Promise<Connection> {
    const client = await mysql.createConnection(process.env.DATABASE_URL!);
    await client.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    return client;
  }

  async function waitForLockWait(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits"
      );
      if (Number(rows[0]?.count) >= 2) return;
    }
    throw new Error("expected two checkout retention lock waits");
  }

  it("atomically removes the expired unused intent and empty wallet and replays", async () => {
    const value = await createCheckout();
    const expiredAt = await expireAt(connection, value);
    const candidates = await listExpiredPristineCreditCheckouts(
      "test",
      new Date(expiredAt * 1_000),
      100
    );
    expect(candidates).toContainEqual({
      intentId: value.intentId,
      walletId: value.walletId,
      workspaceId: value.workspaceId,
      mode: "test",
      channelConnectionId: value.channelConnectionId,
      bindingEpoch: 1,
      privacyEpoch: 1,
      userKey: USER_KEY,
      financialSubjectRef: value.financialSubjectRef,
    });
    await connection.query("SET timestamp=?", [expiredAt]);
    await expect(cleanup(connection, value)).resolves.toMatchObject({
      result: "applied",
      intent_id: value.intentId,
    });
    expect(await counts(value)).toEqual({ intents: 0, wallets: 0 });
    await expect(cleanup(connection, value)).resolves.toMatchObject({
      result: "already_applied",
      intent_id: value.intentId,
    });
    await connection.query("SET timestamp=DEFAULT");
  });

  it("preserves a consumed checkout after its capability expires", async () => {
    const value = await createCheckout();
    await connection.query(
      "CALL `credit_consume_checkout_capability`(?, 'test', ?, 1, 1, ?, ?, ?, ?, ?, ?)",
      [
        value.workspaceId,
        value.channelConnectionId,
        USER_KEY,
        value.walletId,
        value.financialSubjectRef,
        value.intentId,
        value.capabilityHash,
        hash(`retention-browser-session:${value.intentId}`),
      ]
    );
    await connection.query("SET timestamp=?", [
      await expireAt(connection, value),
    ]);
    await expect(cleanup(connection, value)).resolves.toMatchObject({
      result: "skipped",
    });
    expect(await counts(value)).toEqual({ intents: 1, wallets: 1 });
    await connection.query("SET timestamp=DEFAULT");
  });

  it("preserves an intent with any provider, webhook-route, or outbox evidence", async () => {
    const value = await createCheckout();
    const operationId = randomUUID();
    await connection.query(
      "INSERT INTO `billing_provider_operations` (`operation_id`,`workspace_id`,`mode`,`operation_type`,`operation_key`,`intent_id`,`billing_profile_version`,`authorization_epoch`,`state`,`request_fingerprint`,`idempotency_key_hash`,`credential_generation_id`,`provider_resource_id`,`provider_customer_id`,`attempt_count`,`lease_token`,`lease_until`,`resolution_due_at`) VALUES (? ,?,'test','create_payment',?,?,0,2,'reserved',?,?,?,NULL,NULL,0,?,TIMESTAMPADD(MINUTE,1,CURRENT_TIMESTAMP),TIMESTAMPADD(MINUTE,5,CURRENT_TIMESTAMP))",
      [
        operationId,
        value.workspaceId,
        value.intentId,
        value.intentId,
        hash("request"),
        hash("idempotency"),
        hash("credential-generation"),
        randomUUID(),
      ]
    );
    await connection.query(
      "INSERT INTO `billing_webhook_routes` (`mode`,`mollie_payment_id`,`workspace_id`,`intent_id`) VALUES ('test',?,?,?)",
      [
        `tr_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        value.workspaceId,
        value.intentId,
      ]
    );
    await connection.query(
      "INSERT INTO `billing_outbox` (`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`) VALUES (?,?,'test','manual_review',?,JSON_OBJECT('intentId',?,'creditWalletId',?),'pending')",
      [
        randomUUID(),
        value.workspaceId,
        `retention-review:${value.intentId}`,
        value.intentId,
        value.walletId,
      ]
    );
    await connection.query("SET timestamp=?", [
      await expireAt(connection, value),
    ]);
    await expect(cleanup(connection, value)).resolves.toMatchObject({
      result: "skipped",
    });
    expect(await counts(value)).toEqual({ intents: 1, wallets: 1 });
    await connection.query("SET timestamp=DEFAULT");
  });

  it("serializes capability consumption against expiry without deletion or deadlock", async () => {
    const value = await createCheckout();
    const expiry = (await expireAt(connection, value)) - 1;
    const blocker = await peer();
    const consumer = await peer();
    const cleaner = await peer();
    try {
      await blocker.beginTransaction();
      await blocker.query(
        "SELECT `workspace_id` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [value.workspaceId]
      );
      await consumer.query("SET timestamp=?", [expiry]);
      await cleaner.query("SET timestamp=?", [expiry + 1]);
      const consumePromise = consumer.query(
        "CALL `credit_consume_checkout_capability`(?, 'test', ?, 1, 1, ?, ?, ?, ?, ?, ?)",
        [
          value.workspaceId,
          value.channelConnectionId,
          USER_KEY,
          value.walletId,
          value.financialSubjectRef,
          value.intentId,
          value.capabilityHash,
          hash(`race-session:${value.intentId}`),
        ]
      );
      const cleanupPromise = cleanup(cleaner, value);
      await waitForLockWait();
      await blocker.commit();
      await expect(consumePromise).resolves.toBeDefined();
      await expect(cleanupPromise).resolves.toMatchObject({
        result: "skipped",
      });
      expect(await counts(value)).toEqual({ intents: 1, wallets: 1 });
    } finally {
      await Promise.allSettled([
        blocker.rollback(),
        blocker.end(),
        consumer.end(),
        cleaner.end(),
      ]);
    }
  });
});
