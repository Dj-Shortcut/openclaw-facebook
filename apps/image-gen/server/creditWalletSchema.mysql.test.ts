import { createHash, randomUUID } from "node:crypto";

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveCreditWalletIdentity } from "./_core/billing/creditCheckoutIdentity";
import { deriveCreditCheckoutTestUserKeyHash } from "./_core/billing/creditCheckoutConfig";
import {
  reservePaidCreditGeneration,
  type CreditGenerationAdmissionDependencies,
} from "./_core/billing/creditGenerationAdmission";
import {
  readCurrentCreditWalletIdentity,
  readCreditGenerationReservation,
  readSpendableCreditWallet,
} from "./_core/billing/creditGenerationAdmissionStore";
import {
  enqueueCreditReservationTransportReview,
  listDueCreditReservationResolutions,
} from "./_core/billing/creditReservationExpiryStore";
import { runCreditReservationExpiryOnce } from "./_core/billing/creditReservationExpiryWorker";
import {
  commitCreditReservation,
  createCreditReservationHold,
  eraseCreditWalletsForPrivacySubject,
  expirePristineCreditCheckout,
  expireCreditReservation,
  markCreditReservationProviderAccepted,
  markCreditReservationTransportStarted,
  releaseCreditReservation,
} from "./_core/billing/creditWalletStore";
import {
  creditWalletRoutineNames,
  productionRuntimeWritableTableNames,
} from "../scripts/production-schema-contract.mjs";
import {
  assertProvisionerGrants,
  buildProvisionerSql,
} from "../../../scripts/image-gen-credit-provisioner-bootstrap-contract.mjs";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);

const USER_A = `u2.k1.${"a".repeat(64)}`;
const USER_B = `u2.k1.${"b".repeat(64)}`;
const LEGACY_USER_A = "d".repeat(64);
const LEGACY_USER_B = "e".repeat(64);
const FINANCIAL_REF = "c".repeat(64);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Scope = {
  channelConnectionId: number;
  checkoutReservation: {
    capabilityHash: string;
    checkoutScopeKey: string;
    intentId: string;
    metadataHash: string;
  };
  financialSubjectRef: string;
  userKey: string;
  walletId: string;
  workspaceId: number;
};

suite("0019 credit wallet MySQL 8.4 procedure boundary", () => {
  let connection: Connection;

  beforeAll(async () => {
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
    const [[version]] = await connection.query<RowDataPacket[]>(
      "SELECT VERSION() AS version,@@innodb_page_size AS pageSize,@@binlog_format AS binlogFormat"
    );
    expect(version.version).toBe("8.4.11");
    expect([8192, 16384]).toContain(Number(version.pageSize));
    expect(version.binlogFormat).toBe("ROW");
    await connection.query("SET SESSION sql_require_primary_key=ON");
    await connection.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
  });

  afterAll(async () => {
    await connection?.end();
  });

  async function createScope(
    options: {
      dedicatedSecret?: Uint8Array;
      secondSubject?: boolean;
      secondUserKey?: string;
      userKey?: string;
    } = {}
  ) {
    const userKey = options.userKey ?? USER_A;
    const suffix = randomUUID();
    const [workspace] = await connection.query<ResultSetHeader>(
      "INSERT INTO `workspaces` (`name`,`slug`) VALUES (?,?)",
      ["Credit wallet test", `credit-${suffix}`]
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
    const channelConnectionId = channel.insertId;
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
      [workspaceId, channelConnectionId, userKey]
    );
    if (options.secondSubject) {
      await connection.query(
        "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
        [workspaceId, channelConnectionId, options.secondUserKey ?? USER_B]
      );
    }
    const walletIdentity = options.dedicatedSecret
      ? deriveCreditWalletIdentity({
          dedicatedSecret: options.dedicatedSecret,
          scope: {
            workspaceId,
            mode: "test",
            channel: "facebook_messenger",
            channelConnectionId,
            bindingEpoch: 1,
            privacyEpoch: 1,
            userKey,
          },
        })
      : {
          financialSubjectRef: FINANCIAL_REF,
          walletId: randomUUID(),
        };
    const { financialSubjectRef, walletId } = walletIdentity;
    const intentId = randomUUID();
    const metadataHash = hash(`checkout-metadata:${suffix}`);
    const checkoutScopeKey = `credit-checkout:v1:${hash(
      `checkout-scope:${suffix}`
    )}`;
    const capabilityHash = hash(`checkout-capability:${suffix}`);
    const [rows] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_reserve_checkout_intent`(?, ?, ?, 'test', ?, 1, 1, ?, ?, 2, 'premium_images_9_medium_v2', '5.00', 9, 'Leaderbot - 9 premium beeldcredits', ?, ?, ?, ?, TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
      [
        intentId,
        walletId,
        workspaceId,
        channelConnectionId,
        userKey,
        financialSubjectRef,
        metadataHash,
        `credit-payment:${intentId}`,
        checkoutScopeKey,
        capabilityHash,
      ]
    );
    expect(rows[0]?.[0]?.result).toBe("applied");
    return {
      channelConnectionId,
      checkoutReservation: {
        capabilityHash,
        checkoutScopeKey,
        intentId,
        metadataHash,
      },
      financialSubjectRef,
      userKey,
      walletId,
      workspaceId,
    } satisfies Scope;
  }

  async function createCreditIntent(scope: Scope, label: string) {
    const intentId = randomUUID();
    const capabilityHash = hash(`capability:${label}`);
    const metadataHash = hash(`metadata:${label}`);
    await connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_channel_connection_id`,`messenger_binding_epoch`,`messenger_privacy_epoch`,`credit_wallet_id`,`credit_financial_subject_ref`,`credit_count`,`credit_metadata_hash`,`checkout_capability_hash`,`checkout_capability_expires_at`,`billing_profile_version`,`authorization_epoch`) VALUES (?,?, 'test','premium_once_v1','credit_purchase','19.00','EUR','oneoff',JSON_OBJECT(),'Ten premium image credits',?,?,?,?,1,1,?,?,10,?,?,TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP),0,2)",
      [
        intentId,
        scope.workspaceId,
        `credit-idempotency-${label}`,
        `credit-scope-${label}`,
        scope.userKey,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        metadataHash,
        capabilityHash,
      ]
    );
    return { capabilityHash, intentId, metadataHash };
  }

  async function markReservationProviderAccepted(
    scope: Scope,
    reservationId: string,
    ownerTokenHash: string
  ): Promise<void> {
    const shared = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.userKey,
      scope.walletId,
      scope.financialSubjectRef,
      reservationId,
      ownerTokenHash,
    ];
    const [started] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_mark_reservation_transport_started`(?,'test',?,1,1,?,?,?,?,?)",
      shared
    );
    expect(["applied", "already_applied"]).toContain(started[0]?.[0]?.result);
    const [accepted] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_mark_reservation_provider_accepted`(?,'test',?,1,1,?,?,?,?,?)",
      shared
    );
    expect(["applied", "already_applied"]).toContain(accepted[0]?.[0]?.result);
  }

  async function makeIntentPaid(
    scope: Scope,
    intent: Awaited<ReturnType<typeof createCreditIntent>>,
    label: string,
    options: {
      consume?: boolean;
      exposed?: boolean;
      grossAmount?: string;
      operationState?: "ambiguous" | "contained" | "succeeded";
    } = {}
  ) {
    const paymentId = `tr_${label.replaceAll("-", "").slice(0, 60)}`;
    const evidenceHash = hash(`snapshot:${label}`);
    const exposed = options.exposed ?? true;
    const operationState = options.operationState ?? "succeeded";
    if (options.consume ?? true) {
      await connection.query(
        "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.userKey,
          scope.walletId,
          scope.financialSubjectRef,
          intent.intentId,
          intent.capabilityHash,
          hash(`checkout-session:${label}`),
        ]
      );
    }
    await connection.query(
      `UPDATE \`billing_intents\` SET \`status\`='paid',\`mollie_payment_id\`=?,\`url_exposed_at\`=${exposed ? "CURRENT_TIMESTAMP" : "NULL"},\`paid_at\`=CURRENT_TIMESTAMP WHERE \`intent_id\`=?`,
      [paymentId, intent.intentId]
    );
    await connection.query(
      "INSERT INTO `billing_provider_operations` (`operation_id`,`workspace_id`,`mode`,`operation_type`,`operation_key`,`intent_id`,`billing_profile_version`,`authorization_epoch`,`state`,`request_fingerprint`,`idempotency_key_hash`,`credential_generation_id`,`provider_resource_id`,`attempt_count`,`lease_token`,`lease_until`,`first_started_at`,`resolution_due_at`,`completed_at`) VALUES (?,?,'test','create_payment',?,?,0,2,?,?,?,?, ?,1,?,TIMESTAMPADD(MINUTE,1,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP,TIMESTAMPADD(DAY,1,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP)",
      [
        randomUUID(),
        scope.workspaceId,
        `operation-${label}`,
        intent.intentId,
        operationState,
        intent.metadataHash,
        hash(`idempotency:${label}`),
        hash(`credential:${label}`),
        paymentId,
        randomUUID(),
      ]
    );
    const [payment] = await connection.query<ResultSetHeader>(
      "INSERT INTO `payment_ledger` (`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`payment_method`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`paid_effect_applied`,`occurred_at`) VALUES (?,?,'test',?,'EUR','paid','bancontact',JSON_ARRAY(),JSON_ARRAY(),?,0,CURRENT_TIMESTAMP)",
      [
        paymentId,
        scope.workspaceId,
        options.grossAmount ?? "19.00",
        evidenceHash,
      ]
    );
    return { evidenceHash, paymentId, paymentLedgerId: payment.insertId };
  }

  async function grant(
    scope: Scope,
    intentId: string,
    paymentId: string,
    evidenceHash: string
  ) {
    const entryId = randomUUID();
    const [rows] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_grant_purchase`(?, 'test', ?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        intentId,
        paymentId,
        entryId,
        evidenceHash,
      ]
    );
    return { entryId, result: rows[0]?.[0]?.result as string };
  }

  function paidGenerationDependencies(
    scope: Scope,
    dedicatedSecret: Uint8Array
  ): CreditGenerationAdmissionDependencies {
    return {
      enabled: () => true,
      config: () => ({
        checkoutEnabled: true,
        paidCreditsEnabled: true,
        paidImageProviderMaxCostUsd: 1,
        workspaceId: scope.workspaceId,
        mode: "test",
        testPilotScope: {
          channelConnectionId: scope.channelConnectionId,
          bindingEpoch: 1,
          privacyEpoch: 1,
          userKeyHash: deriveCreditCheckoutTestUserKeyHash(scope.userKey),
        },
      }),
      withKeyring: callback =>
        callback([{ keyId: "k1", secret: dedicatedSecret }]),
      readWalletIdentity: readCurrentCreditWalletIdentity,
      readWallet: readSpendableCreditWallet,
      readReservation: readCreditGenerationReservation,
      reserve: createCreditReservationHold,
      markTransportStarted: markCreditReservationTransportStarted,
      markProviderAccepted: markCreditReservationProviderAccepted,
      commit: commitCreditReservation,
      release: releaseCreditReservation,
    };
  }

  async function reserveCheckoutForSubject(
    scope: Pick<Scope, "channelConnectionId" | "workspaceId">,
    userKey: string,
    financialSubjectRef: string
  ): Promise<Scope> {
    const suffix = randomUUID();
    const walletId = randomUUID();
    const intentId = randomUUID();
    const metadataHash = hash(`checkout-metadata:${suffix}`);
    const checkoutScopeKey = `credit-checkout:v1:${hash(
      `checkout-scope:${suffix}`
    )}`;
    const capabilityHash = hash(`checkout-capability:${suffix}`);
    const [rows] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_reserve_checkout_intent`(?, ?, ?, 'test', ?, 1, 1, ?, ?, 2, 'premium_images_9_medium_v2', '5.00', 9, 'Leaderbot - 9 premium beeldcredits', ?, ?, ?, ?, TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
      [
        intentId,
        walletId,
        scope.workspaceId,
        scope.channelConnectionId,
        userKey,
        financialSubjectRef,
        metadataHash,
        `credit-payment:${intentId}`,
        checkoutScopeKey,
        capabilityHash,
      ]
    );
    expect(rows[0]?.[0]?.result).toBe("applied");
    return {
      channelConnectionId: scope.channelConnectionId,
      checkoutReservation: {
        capabilityHash,
        checkoutScopeKey,
        intentId,
        metadataHash,
      },
      financialSubjectRef,
      userKey,
      walletId,
      workspaceId: scope.workspaceId,
    };
  }

  async function openPeer() {
    const peer = await mysql.createConnection(process.env.DATABASE_URL!);
    await peer.query("SET SESSION sql_require_primary_key=ON");
    await peer.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    return peer;
  }

  async function runBehindControlBarrier<T>(
    scope: Scope,
    actions: [
      (peer: Connection) => Promise<T>,
      (peer: Connection) => Promise<T>,
    ]
  ) {
    const blocker = await openPeer();
    const observer = await openPeer();
    const first = await openPeer();
    const second = await openPeer();
    let pending: [Promise<T>, Promise<T>] | undefined;
    try {
      await blocker.beginTransaction();
      const [[identity]] = await blocker.query<RowDataPacket[]>(
        "SELECT CONNECTION_ID() AS connectionId"
      );
      await blocker.query(
        "SELECT `authorization_epoch` FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test' FOR UPDATE",
        [scope.workspaceId]
      );
      pending = [actions[0](first), actions[1](second)];
      const deadline = Date.now() + 3_000;
      let waiters = 0;
      while (Date.now() < deadline && waiters < 2) {
        const [[row]] = await observer.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS waiters FROM performance_schema.data_lock_waits waits JOIN performance_schema.threads blocker_thread ON blocker_thread.THREAD_ID=waits.BLOCKING_THREAD_ID WHERE blocker_thread.PROCESSLIST_ID=?",
          [identity.connectionId]
        );
        waiters = Number(row.waiters);
      }
      expect(waiters).toBe(2);
      await blocker.commit();
      return await Promise.allSettled(pending);
    } finally {
      await blocker.rollback().catch(() => undefined);
      if (pending) await Promise.allSettled(pending);
      await Promise.all([
        blocker.end(),
        observer.end(),
        first.end(),
        second.end(),
      ]);
    }
  }

  it("creates the exact restricted provisioner and verifies its effective grants", async () => {
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    const username = `lbcp_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const password = `Aa1!${hash(randomUUID())}${hash(randomUUID()).slice(0, 32)}`;
    const sql = buildProvisionerSql({ databaseName, password, username });
    let deniedTable: string | undefined;
    let provisioner: Connection | undefined;
    try {
      await connection.query(sql.createStatement);
      for (const statement of sql.grantStatements) {
        await connection.query(statement);
      }
      const [grantRows] = await connection.query<RowDataPacket[]>(
        `SHOW GRANTS FOR ${sql.account}`
      );
      const grants = grantRows.flatMap(row => Object.values(row)).map(String);
      expect(() => assertProvisionerGrants(grants, databaseName)).not.toThrow();

      const provisionerUrl = new URL(databaseUrl);
      provisionerUrl.username = username;
      provisionerUrl.password = password;
      const candidateDeniedTable = `lbcp_denied_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 16)}`;
      await connection.query(
        `CREATE TABLE \`${candidateDeniedTable}\` (\`id\` BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB`
      );
      deniedTable = candidateDeniedTable;
      provisioner = await mysql.createConnection(provisionerUrl.href);
      const [[identity]] = await provisioner.query<RowDataPacket[]>(
        "SELECT CURRENT_USER() AS currentUser,DATABASE() AS databaseName"
      );
      expect(identity).toMatchObject({
        currentUser: `${username}@%`,
        databaseName,
      });
      await expect(
        provisioner.query("DELETE FROM ?? WHERE 1=0", [deniedTable])
      ).rejects.toMatchObject({
        code: "ER_TABLEACCESS_DENIED_ERROR",
        errno: 1142,
        sqlState: "42000",
      });
      await expect(
        provisioner.query("DROP TABLE ??", [deniedTable])
      ).rejects.toMatchObject({
        code: "ER_TABLEACCESS_DENIED_ERROR",
        errno: 1142,
        sqlState: "42000",
      });
    } finally {
      if (provisioner) {
        await provisioner.end().catch(() => undefined);
      }
      try {
        if (deniedTable) {
          await connection.query(`DROP TABLE IF EXISTS \`${deniedTable}\``);
        }
      } finally {
        await connection.query(`DROP USER IF EXISTS ${sql.account}`);
      }
    }
  });

  it("preserves the 0016 ownerless paid-effect writer and closes NULL shapes", async () => {
    const scope = await createScope();
    const [payment] = await connection.query<ResultSetHeader>(
      "INSERT INTO `payment_ledger` (`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`paid_effect_applied`,`occurred_at`) VALUES (?,?,'test','19.00','EUR','open',JSON_ARRAY(),JSON_ARRAY(),REPEAT('1',64),0,CURRENT_TIMESTAMP)",
      [`tr_legacy_${randomUUID()}`, scope.workspaceId]
    );
    await connection.query(
      "UPDATE `payment_ledger` SET `status`='paid',`occurred_at`=TIMESTAMPADD(SECOND,1,`occurred_at`),`observed_snapshot_hash`=REPEAT('2',64),`paid_effect_applied`=1 WHERE `id`=?",
      [payment.insertId]
    );
    const [[legacy]] = await connection.query<RowDataPacket[]>(
      "SELECT `paid_effect_applied` AS applied,`payment_effect_owner_kind` AS ownerKind FROM `payment_ledger` WHERE `id`=?",
      [payment.insertId]
    );
    expect(legacy).toMatchObject({ applied: 1, ownerKind: null });

    await expect(
      connection.query(
        "INSERT INTO `payment_ledger` (`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`credit_purpose`,`payment_effect_owner_kind`,`occurred_at`) VALUES (?,?,'test','19.00','EUR','paid',JSON_ARRAY(),JSON_ARRAY(),REPEAT('3',64),'premium_image_credits','credit_grant',CURRENT_TIMESTAMP)",
        [`tr_null_${randomUUID()}`, scope.workspaceId]
      )
    ).rejects.toThrow();
    await expect(
      connection.query(
        "INSERT INTO `credit_wallets` (`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`current_user_key_hash`,`financial_subject_ref`) VALUES (?,?,'live',?,1,1,REPEAT('a',64),?)",
        [
          randomUUID(),
          scope.workspaceId,
          scope.channelConnectionId,
          hash("other-financial"),
        ]
      )
    ).rejects.toThrow();
  });

  it("binds capability consumption to one browser nonce and exact current scope", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const nonce = hash(`browser-nonce:${randomUUID()}`);
    const args = [
      scope.workspaceId,
      scope.channelConnectionId,
      USER_A,
      scope.walletId,
      scope.financialSubjectRef,
      intent.intentId,
      intent.capabilityHash,
      nonce,
    ];
    const [first] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
      args
    );
    expect(first[0]?.[0]?.result).toBe("applied");
    const [replay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
      args
    );
    expect(replay[0]?.[0]?.result).toBe("already_applied");
    await expect(
      connection.query(
        "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
        [...args.slice(0, -1), hash("different-browser")]
      )
    ).rejects.toThrow("another browser session");
    const [[expiry]] = await connection.query<RowDataPacket[]>(
      "SELECT UNIX_TIMESTAMP(`checkout_capability_expires_at`)+1 AS afterExpiry FROM `billing_intents` WHERE `intent_id`=?",
      [intent.intentId]
    );
    try {
      await connection.query("SET timestamp=?", [Number(expiry.afterExpiry)]);
      await expect(
        connection.query(
          "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
          args
        )
      ).rejects.toThrow("credit checkout capability is expired");
    } finally {
      await connection.query("SET timestamp=0");
    }
    await expect(
      connection.query(
        "CALL `credit_consume_checkout_capability`(?,'live',?,1,1,?,?,?,?,?,?)",
        args
      )
    ).rejects.toThrow();

    const missingControlScope = await createScope();
    const missingControlIntent = await createCreditIntent(
      missingControlScope,
      randomUUID()
    );
    await connection.query(
      "DELETE FROM `billing_execution_controls` WHERE `workspace_id`=? AND `mode`='test'",
      [missingControlScope.workspaceId]
    );
    await expect(
      connection.query(
        "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          missingControlScope.workspaceId,
          missingControlScope.channelConnectionId,
          USER_A,
          missingControlScope.walletId,
          missingControlScope.financialSubjectRef,
          missingControlIntent.intentId,
          missingControlIntent.capabilityHash,
          hash("missing-control-browser"),
        ]
      )
    ).rejects.toThrow("credit checkout is disabled");
  });

  it("claims one paid payment once and projects one immutable grant", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    const applied = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    expect(applied.result).toBe("applied");
    const [replayRows] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        intent.intentId,
        payment.paymentId,
        applied.entryId,
        payment.evidenceHash,
      ]
    );
    expect(replayRows[0]?.[0]?.result).toBe("already_applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`balance_version` AS version,`last_ledger_entry_id` AS lastEntry FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({
      balance: 10,
      lastEntry: applied.entryId,
      reserved: 0,
      version: 2,
    });
    const [[owner]] = await connection.query<RowDataPacket[]>(
      "SELECT `paid_effect_applied` AS applied,`payment_effect_owner_kind` AS ownerKind,`payment_effect_owner_ref` AS ownerRef FROM `payment_ledger` WHERE `id`=?",
      [payment.paymentLedgerId]
    );
    expect(owner).toMatchObject({
      applied: 1,
      ownerKind: "credit_grant",
      ownerRef: intent.intentId,
    });
    const [walletReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_reserve_checkout_intent`(?, ?, ?, 'test', ?, 1, 1, ?, ?, 2, 'premium_images_9_medium_v2', '5.00', 9, 'Leaderbot - 9 premium beeldcredits', ?, ?, ?, ?, TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
      [
        scope.checkoutReservation.intentId,
        scope.walletId,
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.financialSubjectRef,
        scope.checkoutReservation.metadataHash,
        `credit-payment:${scope.checkoutReservation.intentId}`,
        scope.checkoutReservation.checkoutScopeKey,
        scope.checkoutReservation.capabilityHash,
      ]
    );
    expect(walletReplay[0]?.[0]?.result).toBe("already_applied");
    await expect(
      connection.query(
        "UPDATE `credit_wallets` SET `credit_balance`=999,`balance_version`=`balance_version`+1 WHERE `wallet_id`=?",
        [scope.walletId]
      )
    ).rejects.toThrow("wallet projection");
    await expect(
      connection.query("DELETE FROM `credit_ledger` WHERE `entry_id`=?", [
        applied.entryId,
      ])
    ).rejects.toThrow("append only");

    const unconsumedScope = await createScope();
    const unconsumedIntent = await createCreditIntent(
      unconsumedScope,
      randomUUID()
    );
    const unconsumedPayment = await makeIntentPaid(
      unconsumedScope,
      unconsumedIntent,
      randomUUID(),
      { consume: false }
    );
    await expect(
      grant(
        unconsumedScope,
        unconsumedIntent.intentId,
        unconsumedPayment.paymentId,
        unconsumedPayment.evidenceHash
      )
    ).rejects.toThrow("credit grant intent evidence is unavailable");
    const [[unconsumedWallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`last_ledger_entry_id` AS lastEntry FROM `credit_wallets` WHERE `wallet_id`=?",
      [unconsumedScope.walletId]
    );
    expect(unconsumedWallet).toMatchObject({ balance: 0, lastEntry: null });
  });

  it("binds a production legacy privacy subject through reserve, grant and hold", async () => {
    const scope = await createScope({
      secondSubject: true,
      secondUserKey: USER_B,
      userKey: LEGACY_USER_A,
    });
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    const granted = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    expect(granted.result).toBe("applied");

    const wrongUserReservation = randomUUID();
    await expect(
      connection.query(
        "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_B,
          scope.walletId,
          scope.financialSubjectRef,
          wrongUserReservation,
          hash("legacy-wrong-user-generation"),
          hash("legacy-wrong-user-owner"),
          1,
          randomUUID(),
          hash("legacy-wrong-user-evidence"),
        ]
      )
    ).rejects.toThrow();

    const otherTenant = await createScope({ userKey: LEGACY_USER_B });
    const wrongTenantReservation = randomUUID();
    await expect(
      connection.query(
        "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
        [
          otherTenant.workspaceId,
          otherTenant.channelConnectionId,
          otherTenant.userKey,
          scope.walletId,
          scope.financialSubjectRef,
          wrongTenantReservation,
          hash("legacy-wrong-tenant-generation"),
          hash("legacy-wrong-tenant-owner"),
          1,
          randomUUID(),
          hash("legacy-wrong-tenant-evidence"),
        ]
      )
    ).rejects.toThrow();

    const reservationId = randomUUID();
    const [held] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash("legacy-generation"),
        hash("legacy-owner"),
        1,
        randomUUID(),
        hash("legacy-evidence"),
      ]
    );
    expect(held[0]?.[0]?.result).toBe("applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`current_user_key_hash` AS userKey FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({
      balance: 10,
      reserved: 1,
      userKey: LEGACY_USER_A,
    });
    const [[wrongReservations]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `credit_reservations` WHERE `reservation_id` IN (?,?)",
      [wrongUserReservation, wrongTenantReservation]
    );
    expect(Number(wrongReservations.count)).toBe(0);
  });

  it("rejects another subject before transition and replays exact terminal proof", async () => {
    const scope = await createScope({ secondSubject: true });
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const reservationId = randomUUID();
    const ownerHash = hash("reservation-owner");
    const holdEntryId = randomUUID();
    const holdEvidence = hash("hold-evidence");
    const [hold] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash("generation-request"),
        ownerHash,
        1,
        holdEntryId,
        holdEvidence,
      ]
    );
    expect(hold[0]?.[0]?.result).toBe("applied");
    const [holdReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash("generation-request"),
        ownerHash,
        1,
        holdEntryId,
        holdEvidence,
      ]
    );
    expect(holdReplay[0]?.[0]?.result).toBe("already_applied");
    const commitEntryId = randomUUID();
    const commitEvidence = hash("commit-evidence");
    for (const [candidateOwner, candidateEntry, candidateEvidence] of [
      [null, commitEntryId, commitEvidence],
      [ownerHash, null, commitEvidence],
      [ownerHash, commitEntryId, null],
    ] as const) {
      await expect(
        connection.query(
          "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            USER_A,
            scope.walletId,
            scope.financialSubjectRef,
            reservationId,
            candidateOwner,
            candidateEntry,
            candidateEvidence,
          ]
        )
      ).rejects.toThrow("credit commit proof is malformed");
    }
    await expect(
      connection.query(
        "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_B,
          scope.walletId,
          scope.financialSubjectRef,
          reservationId,
          ownerHash,
          commitEntryId,
          commitEvidence,
        ]
      )
    ).rejects.toThrow();
    const [[afterWrongUser]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`state_version` AS stateVersion FROM `credit_reservations` WHERE `reservation_id`=?",
      [reservationId]
    );
    expect(afterWrongUser).toMatchObject({
      stateVersion: 2,
      status: "reserved",
    });
    await markReservationProviderAccepted(scope, reservationId, ownerHash);
    const [committed] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        ownerHash,
        commitEntryId,
        commitEvidence,
      ]
    );
    expect(committed[0]?.[0]?.result).toBe("applied");
    const [commitReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        ownerHash,
        commitEntryId,
        commitEvidence,
      ]
    );
    expect(commitReplay[0]?.[0]?.result).toBe("already_applied");
    const [crossSubjectReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_B,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        ownerHash,
        commitEntryId,
        commitEvidence,
      ]
    );
    expect(crossSubjectReplay[0]?.[0]?.result).toBe("already_applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`balance_version` AS version FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({ balance: 9, reserved: 0, version: 4 });
    const [[reservation]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`state_version` AS stateVersion,`terminal_ledger_entry_id` AS terminalEntry FROM `credit_reservations` WHERE `reservation_id`=?",
      [reservationId]
    );
    expect(reservation).toMatchObject({
      stateVersion: 3,
      status: "committed",
      terminalEntry: commitEntryId,
    });

    const releaseReservationId = randomUUID();
    const releaseOwnerHash = hash("release-owner");
    const releaseHoldEntryId = randomUUID();
    const releaseHoldEvidence = hash("release-hold-evidence");
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        releaseReservationId,
        hash("release-generation"),
        releaseOwnerHash,
        1,
        releaseHoldEntryId,
        releaseHoldEvidence,
      ]
    );
    const releaseEntryId = randomUUID();
    const releaseEvidence = hash("release-evidence");
    await expect(
      connection.query(
        "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_A,
          scope.walletId,
          scope.financialSubjectRef,
          releaseReservationId,
          null,
          "pretransport",
          releaseEntryId,
          releaseEvidence,
        ]
      )
    ).rejects.toThrow("credit release proof is malformed");
    await expect(
      connection.query(
        "CALL `credit_expire_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_A,
          scope.walletId,
          scope.financialSubjectRef,
          releaseReservationId,
          null,
          randomUUID(),
          hash("expire-evidence"),
        ]
      )
    ).rejects.toThrow("credit expiry proof is malformed");
    const [released] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        releaseReservationId,
        releaseOwnerHash,
        "pretransport",
        releaseEntryId,
        releaseEvidence,
      ]
    );
    expect(released[0]?.[0]?.result).toBe("applied");
    const [releaseCrossSubjectReplay] = await connection.query<
      RowDataPacket[][]
    >("CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)", [
      scope.workspaceId,
      scope.channelConnectionId,
      USER_B,
      scope.walletId,
      scope.financialSubjectRef,
      releaseReservationId,
      releaseOwnerHash,
      "pretransport",
      releaseEntryId,
      releaseEvidence,
    ]);
    expect(releaseCrossSubjectReplay[0]?.[0]?.result).toBe("already_applied");
  });

  it("never expires a provider-accepted hold after a commit crash", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );

    const reservationId = randomUUID();
    const ownerTokenHash = hash("provider-accepted-crash-owner");
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash("provider-accepted-crash-request"),
        ownerTokenHash,
        1,
        randomUUID(),
        hash("provider-accepted-crash-hold"),
      ]
    );
    await markReservationProviderAccepted(scope, reservationId, ownerTokenHash);

    const [[clock]] = await connection.query<RowDataPacket[]>(
      "SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP)+960 AS futureTimestamp"
    );
    await connection.query("SET SESSION timestamp=?", [
      Number(clock.futureTimestamp),
    ]);
    try {
      await expect(
        connection.query(
          "CALL `credit_expire_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            scope.userKey,
            scope.walletId,
            scope.financialSubjectRef,
            reservationId,
            ownerTokenHash,
            randomUUID(),
            hash("provider-accepted-crash-expiry"),
          ]
        )
      ).rejects.toThrow("credit expiry requires one expired owned hold");
    } finally {
      await connection.query("SET SESSION timestamp=0");
    }

    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    const [[reservation]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`transport_state` AS transportState FROM `credit_reservations` WHERE `reservation_id`=?",
      [reservationId]
    );
    expect(wallet).toMatchObject({ balance: 10, reserved: 1 });
    expect(reservation).toMatchObject({
      status: "reserved",
      transportState: "known_accepted",
    });
  });

  it("keeps a due started transport held and queues one opaque review", async () => {
    const dedicatedSecret = Buffer.from(
      hash(`started-transport-secret:${randomUUID()}`),
      "hex"
    );
    try {
      const scope = await createScope({ dedicatedSecret });
      const payment = await makeIntentPaid(
        scope,
        scope.checkoutReservation,
        randomUUID(),
        { grossAmount: "5.00" }
      );
      expect(
        (
          await grant(
            scope,
            scope.checkoutReservation.intentId,
            payment.paymentId,
            payment.evidenceHash
          )
        ).result
      ).toBe("applied");

      const decision = await reservePaidCreditGeneration(
        {
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          bindingEpoch: 1,
          privacyEpoch: 1,
          userKey: scope.userKey,
          requestId: `mysql-started-${randomUUID()}`,
        },
        paidGenerationDependencies(scope, dedicatedSecret)
      );
      if (!decision.available) {
        throw new Error(`paid generation was unavailable: ${decision.reason}`);
      }
      await decision.reservation.markTransportStarted();

      const dueRows = await listDueCreditReservationResolutions(
        "test",
        new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000),
        100
      );
      const due = dueRows.find(
        row => row.reservationId === decision.reservation.reservationId
      );
      expect(due?.transportState).toBe("transport_started");
      if (!due) throw new Error("started reservation was not due");

      await enqueueCreditReservationTransportReview(due);
      await enqueueCreditReservationTransportReview(due);

      const [[wallet]] = await connection.query<RowDataPacket[]>(
        "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
        [scope.walletId]
      );
      const [[reservation]] = await connection.query<RowDataPacket[]>(
        "SELECT `status`,`transport_state` AS transportState FROM `credit_reservations` WHERE `reservation_id`=?",
        [due.reservationId]
      );
      const [reviews] = await connection.query<RowDataPacket[]>(
        "SELECT `event_type` AS eventType,`status`,CAST(`payload` AS CHAR) AS payloadText,JSON_UNQUOTE(JSON_EXTRACT(`payload`,'$.reason')) AS reason,JSON_UNQUOTE(JSON_EXTRACT(`payload`,'$.reservationId')) AS reservationId,JSON_UNQUOTE(JSON_EXTRACT(`payload`,'$.walletId')) AS walletId FROM `billing_outbox` WHERE `mode`='test' AND `deduplication_key`=?",
        [`credit_reservation_transport_review:${due.reservationId}`]
      );

      expect(wallet).toMatchObject({ balance: 9, reserved: 1 });
      expect(reservation).toMatchObject({
        status: "reserved",
        transportState: "transport_started",
      });
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        eventType: "manual_review",
        status: "pending",
        reason: "credit_reservation_transport_ambiguous",
        reservationId: due.reservationId,
        walletId: scope.walletId,
      });
      expect(String(reviews[0]?.payloadText)).not.toContain(scope.userKey);
      expect(String(reviews[0]?.payloadText)).not.toContain(
        scope.financialSubjectRef
      );
    } finally {
      dedicatedSecret.fill(0);
    }
  });

  it("releases one transport-started hold only for the exact proven 4xx", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );

    const reservationId = randomUUID();
    const ownerTokenHash = hash("known-rejected-owner");
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash("known-rejected-request"),
        ownerTokenHash,
        1,
        randomUUID(),
        hash("known-rejected-hold"),
      ]
    );
    await connection.query(
      "CALL `credit_mark_reservation_transport_started`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        ownerTokenHash,
      ]
    );

    await expect(
      connection.query(
        "UPDATE `credit_reservations` SET `provider_rejected_status`=400 WHERE `reservation_id`=?",
        [reservationId]
      )
    ).rejects.toThrow(
      "credit reservation rejected evidence transition is invalid"
    );

    const entryId = randomUUID();
    const evidenceHash = hash("known-rejected-evidence:400");
    const args = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.userKey,
      scope.walletId,
      scope.financialSubjectRef,
      reservationId,
      ownerTokenHash,
      400,
      entryId,
      evidenceHash,
    ];
    const [released] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_release_rejected_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      args
    );
    expect(released[0]?.[0]?.result).toBe("applied");
    const [replay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_release_rejected_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      args
    );
    expect(replay[0]?.[0]?.result).toBe("already_applied");
    await expect(
      connection.query(
        "CALL `credit_release_rejected_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
        [...args.slice(0, 7), 403, entryId, evidenceHash]
      )
    ).rejects.toThrow(
      "credit rejected release replay conflicts with terminal evidence"
    );
    await expect(
      connection.query(
        "UPDATE `credit_reservations` SET `provider_rejected_status`=403 WHERE `reservation_id`=?",
        [reservationId]
      )
    ).rejects.toThrow("credit reservation transport evidence is set once");

    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    const [[reservation]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`transport_state` AS transportState,`provider_rejected_status` AS providerRejectedStatus FROM `credit_reservations` WHERE `reservation_id`=?",
      [reservationId]
    );
    expect(wallet).toMatchObject({ balance: 10, reserved: 0 });
    expect(reservation).toMatchObject({
      status: "released",
      transportState: "known_rejected",
      providerRejectedStatus: 400,
    });

    const [[resolution]] = await connection.query<RowDataPacket[]>(
      "SELECT UNIX_TIMESTAMP(`resolution_due_at`)+1 AS futureTimestamp FROM `credit_reservations` WHERE `reservation_id`=?",
      [reservationId]
    );
    await connection.query("SET SESSION timestamp=?", [
      Number(resolution.futureTimestamp),
    ]);
    try {
      const [scrubbed] = await connection.query<RowDataPacket[][]>(
        "CALL `credit_scrub_terminal_reservation`(?,'test',?,1,1,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          reservationId,
        ]
      );
      expect(scrubbed[0]?.[0]?.result).toBe("applied");
    } finally {
      await connection.query("SET SESSION timestamp=0");
    }
    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `status`='erasing',`privacy_epoch`=2 WHERE `workspace_id`=? AND `channel_connection_id`=? AND BINARY `user_key`=BINARY ?",
      [scope.workspaceId, scope.channelConnectionId, scope.userKey]
    );
    await connection.query(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,2,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
      ]
    );
    const [scrubbedReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_release_rejected_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      args
    );
    expect(scrubbedReplay[0]?.[0]?.result).toBe("already_applied");
  });

  it("preserves one spendable wallet across checkout HMAC rotation", async () => {
    const oldSecret = Buffer.from(
      hash(`wallet-rotation-old:${randomUUID()}`),
      "hex"
    );
    const newSecret = Buffer.from(
      hash(`wallet-rotation-new:${randomUUID()}`),
      "hex"
    );
    try {
      const scope = await createScope({ dedicatedSecret: oldSecret });
      const payment = await makeIntentPaid(
        scope,
        scope.checkoutReservation,
        randomUUID(),
        { grossAmount: "5.00" }
      );
      expect(
        (
          await grant(
            scope,
            scope.checkoutReservation.intentId,
            payment.paymentId,
            payment.evidenceHash
          )
        ).result
      ).toBe("applied");

      const decision = await reservePaidCreditGeneration(
        {
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          bindingEpoch: 1,
          privacyEpoch: 1,
          userKey: scope.userKey,
          requestId: `mysql-rotated-${randomUUID()}`,
        },
        {
          ...paidGenerationDependencies(scope, oldSecret),
          withKeyring: callback =>
            callback([
              { keyId: "k2", secret: newSecret },
              { keyId: "k1", secret: oldSecret },
            ]),
        }
      );
      if (!decision.available) {
        throw new Error(`paid generation was unavailable: ${decision.reason}`);
      }

      const [wallets] = await connection.query<RowDataPacket[]>(
        "SELECT `wallet_id` AS walletId FROM `credit_wallets` WHERE `workspace_id`=? AND `mode`='test' AND `channel_connection_id`=? AND `binding_epoch`=1 AND `privacy_epoch`=1 AND BINARY `current_user_key_hash`=BINARY ?",
        [scope.workspaceId, scope.channelConnectionId, scope.userKey]
      );
      expect(wallets).toEqual([{ walletId: scope.walletId }]);
      await decision.reservation.releaseBeforeTransport();
    } finally {
      oldSecret.fill(0);
      newSecret.fill(0);
    }
  });

  it("commits one due known provider acceptance and replays idempotently", async () => {
    const dedicatedSecret = Buffer.from(
      hash(`accepted-transport-secret:${randomUUID()}`),
      "hex"
    );
    try {
      const scope = await createScope({ dedicatedSecret });
      const payment = await makeIntentPaid(
        scope,
        scope.checkoutReservation,
        randomUUID(),
        { grossAmount: "5.00" }
      );
      expect(
        (
          await grant(
            scope,
            scope.checkoutReservation.intentId,
            payment.paymentId,
            payment.evidenceHash
          )
        ).result
      ).toBe("applied");

      const decision = await reservePaidCreditGeneration(
        {
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          bindingEpoch: 1,
          privacyEpoch: 1,
          userKey: scope.userKey,
          requestId: `mysql-accepted-${randomUUID()}`,
        },
        paidGenerationDependencies(scope, dedicatedSecret)
      );
      if (!decision.available) {
        throw new Error(`paid generation was unavailable: ${decision.reason}`);
      }
      await decision.reservation.markTransportStarted();
      const [[proof]] = await connection.query<RowDataPacket[]>(
        "SELECT `owner_token_hash` AS ownerTokenHash FROM `credit_reservations` WHERE `reservation_id`=?",
        [decision.reservation.reservationId]
      );
      await markCreditReservationProviderAccepted({
        workspaceId: scope.workspaceId,
        mode: "test",
        channelConnectionId: scope.channelConnectionId,
        bindingEpoch: 1,
        privacyEpoch: 1,
        userKey: scope.userKey,
        walletId: scope.walletId,
        financialSubjectRef: scope.financialSubjectRef,
        reservationId: decision.reservation.reservationId,
        ownerTokenHash: String(proof.ownerTokenHash),
      });

      const dueRows = await listDueCreditReservationResolutions(
        "test",
        new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000),
        100
      );
      const due = dueRows.find(
        row => row.reservationId === decision.reservation.reservationId
      );
      expect(due?.transportState).toBe("known_accepted");
      if (!due) throw new Error("accepted reservation was not due");

      const recoveryDependencies = {
        modes: () => ["test", "live"] as const,
        list: async () => [],
        listDue: async (mode: "test" | "live") =>
          mode === "test" ? [due] : [],
        listPristineCheckouts: async () => [],
        listTerminalForScrub: async () => [],
        expire: expireCreditReservation,
        expirePristineCheckout: expirePristineCreditCheckout,
        scrubTerminal: async input => ({
          result: "already_applied" as const,
          reservationId: input.reservationId,
        }),
        review: enqueueCreditReservationTransportReview,
      } satisfies Parameters<typeof runCreditReservationExpiryOnce>[2];

      await expect(
        runCreditReservationExpiryOnce(
          25,
          new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000),
          recoveryDependencies
        )
      ).resolves.toBe(1);

      const readTerminalState = async () => {
        const [[wallet]] = await connection.query<RowDataPacket[]>(
          "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
          [scope.walletId]
        );
        const [[reservation]] = await connection.query<RowDataPacket[]>(
          "SELECT `status`,`transport_state` AS transportState FROM `credit_reservations` WHERE `reservation_id`=?",
          [due.reservationId]
        );
        const [[ledger]] = await connection.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS entryCount FROM `credit_ledger` WHERE `reservation_id`=?",
          [due.reservationId]
        );
        return { wallet, reservation, entryCount: Number(ledger.entryCount) };
      };
      expect(await readTerminalState()).toEqual({
        wallet: expect.objectContaining({ balance: 9, reserved: 1 }),
        reservation: expect.objectContaining({
          status: "reserved",
          transportState: "known_accepted",
        }),
        entryCount: 1,
      });

      await expect(
        runCreditReservationExpiryOnce(
          25,
          new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000),
          recoveryDependencies
        )
      ).resolves.toBe(1);
      expect(await readTerminalState()).toEqual({
        wallet: expect.objectContaining({ balance: 9, reserved: 1 }),
        reservation: expect.objectContaining({
          status: "reserved",
          transportState: "known_accepted",
        }),
        entryCount: 1,
      });

      const [[reviews]] = await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS reviewCount FROM `billing_outbox` WHERE `mode`='test' AND `deduplication_key`=?",
        [`credit_reservation_transport_review:${due.reservationId}`]
      );
      expect(Number(reviews.reviewCount)).toBe(1);
    } finally {
      dedicatedSecret.fill(0);
    }
  });

  it("drains an exposed paid checkout after disable but never grants an unexposed one", async () => {
    const exposedScope = await createScope();
    const exposedIntent = await createCreditIntent(exposedScope, randomUUID());
    const exposedPayment = await makeIntentPaid(
      exposedScope,
      exposedIntent,
      randomUUID(),
      { operationState: "contained" }
    );
    await connection.query(
      "UPDATE `billing_execution_controls` SET `commercial_enabled`=false,`authorization_epoch`=3 WHERE `workspace_id`=? AND `mode`='test'",
      [exposedScope.workspaceId]
    );
    expect(
      (
        await grant(
          exposedScope,
          exposedIntent.intentId,
          exposedPayment.paymentId,
          exposedPayment.evidenceHash
        )
      ).result
    ).toBe("applied");

    const hiddenScope = await createScope();
    const hiddenIntent = await createCreditIntent(hiddenScope, randomUUID());
    const hiddenPayment = await makeIntentPaid(
      hiddenScope,
      hiddenIntent,
      randomUUID(),
      { exposed: false, operationState: "contained" }
    );
    await connection.query(
      "UPDATE `billing_execution_controls` SET `commercial_enabled`=false,`authorization_epoch`=3 WHERE `workspace_id`=? AND `mode`='test'",
      [hiddenScope.workspaceId]
    );
    await expect(
      grant(
        hiddenScope,
        hiddenIntent.intentId,
        hiddenPayment.paymentId,
        hiddenPayment.evidenceHash
      )
    ).rejects.toThrow("intent evidence is unavailable");
    const [[hiddenWallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`last_ledger_entry_id` AS lastEntry FROM `credit_wallets` WHERE `wallet_id`=?",
      [hiddenScope.walletId]
    );
    expect(hiddenWallet).toMatchObject({ balance: 0, lastEntry: null });
  });

  it("serializes same-payment grants and competing last-credit holds", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    const firstEntry = randomUUID();
    const secondEntry = randomUUID();
    const outcomes = await runBehindControlBarrier(scope, [
      a =>
        a.query("CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)", [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_A,
          scope.walletId,
          scope.financialSubjectRef,
          intent.intentId,
          payment.paymentId,
          firstEntry,
          payment.evidenceHash,
        ]),
      b =>
        b.query("CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)", [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_A,
          scope.walletId,
          scope.financialSubjectRef,
          intent.intentId,
          payment.paymentId,
          secondEntry,
          payment.evidenceHash,
        ]),
    ]);
    expect(
      outcomes.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      outcomes.filter(result => result.status === "rejected")
    ).toHaveLength(1);
    const grantRejection = outcomes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(
      (grantRejection?.reason as { code?: string; message?: string }).code
    ).toBe("ER_SIGNAL_EXCEPTION");
    expect((grantRejection?.reason as { message?: string }).message).toContain(
      "credit grant replay conflicts with existing payment effect"
    );
    const [[grantCount]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `credit_ledger` WHERE `wallet_id`=? AND `entry_kind`='purchase_grant'",
      [scope.walletId]
    );
    expect(Number(grantCount.count)).toBe(1);

    const holdArgs = (reservationId: string, label: string) => [
      scope.workspaceId,
      scope.channelConnectionId,
      USER_A,
      scope.walletId,
      scope.financialSubjectRef,
      reservationId,
      hash(`generation:${label}`),
      hash(`owner:${label}`),
      10,
      randomUUID(),
      hash(`evidence:${label}`),
    ];
    const holds = await runBehindControlBarrier(scope, [
      h1 =>
        h1.query(
          "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
          holdArgs(randomUUID(), "a")
        ),
      h2 =>
        h2.query(
          "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
          holdArgs(randomUUID(), "b")
        ),
    ]);
    expect(holds.filter(result => result.status === "fulfilled")).toHaveLength(
      1
    );
    expect(holds.filter(result => result.status === "rejected")).toHaveLength(
      1
    );
    const holdRejection = holds.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(
      (holdRejection?.reason as { code?: string; message?: string }).code
    ).toBe("ER_SIGNAL_EXCEPTION");
    expect((holdRejection?.reason as { message?: string }).message).toContain(
      "purchased credit balance is exhausted"
    );
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`balance_version` AS version FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({ balance: 10, reserved: 10, version: 3 });
  });

  it("scopes generation-request idempotency to one exact wallet", async () => {
    const firstScope = await createScope({ secondSubject: true });
    const secondScope = await reserveCheckoutForSubject(
      firstScope,
      USER_B,
      hash(`second-financial-subject:${randomUUID()}`)
    );
    const firstPayment = await makeIntentPaid(
      firstScope,
      firstScope.checkoutReservation,
      randomUUID(),
      { grossAmount: "5.00" }
    );
    const secondPayment = await makeIntentPaid(
      secondScope,
      secondScope.checkoutReservation,
      randomUUID(),
      { grossAmount: "5.00" }
    );
    await grant(
      firstScope,
      firstScope.checkoutReservation.intentId,
      firstPayment.paymentId,
      firstPayment.evidenceHash
    );
    await grant(
      secondScope,
      secondScope.checkoutReservation.intentId,
      secondPayment.paymentId,
      secondPayment.evidenceHash
    );

    const generationRequestKeyHash = hash(
      `shared-generation-request:${randomUUID()}`
    );
    const firstReservation = {
      evidenceHash: hash(`first-hold-evidence:${randomUUID()}`),
      entryId: randomUUID(),
      ownerTokenHash: hash(`first-hold-owner:${randomUUID()}`),
      reservationId: randomUUID(),
    };
    const secondReservation = {
      evidenceHash: hash(`second-hold-evidence:${randomUUID()}`),
      entryId: randomUUID(),
      ownerTokenHash: hash(`second-hold-owner:${randomUUID()}`),
      reservationId: randomUUID(),
    };
    const hold = async (
      targetScope: Scope,
      proof: typeof firstReservation
    ): Promise<string> => {
      const [rows] = await connection.query<RowDataPacket[][]>(
        "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
        [
          targetScope.workspaceId,
          targetScope.channelConnectionId,
          targetScope.userKey,
          targetScope.walletId,
          targetScope.financialSubjectRef,
          proof.reservationId,
          generationRequestKeyHash,
          proof.ownerTokenHash,
          1,
          proof.entryId,
          proof.evidenceHash,
        ]
      );
      return String(rows[0]?.[0]?.result);
    };

    await expect(hold(firstScope, firstReservation)).resolves.toBe("applied");
    await expect(hold(secondScope, secondReservation)).resolves.toBe("applied");
    await expect(hold(firstScope, firstReservation)).resolves.toBe(
      "already_applied"
    );

    const [[reservationCount]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count,COUNT(DISTINCT `wallet_id`) AS wallets FROM `credit_reservations` WHERE `generation_request_key_hash`=?",
      [generationRequestKeyHash]
    );
    expect(reservationCount).toMatchObject({ count: 2, wallets: 2 });
  });

  it("uses the production erasure epoch, drains a hold, and scrubs settled identity", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    const initialGrant = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const reservationId = randomUUID();
    const owner = hash("erase-owner");
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash("erase-generation"),
        owner,
        1,
        randomUUID(),
        hash("erase-hold"),
      ]
    );
    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `status`='erasing',`privacy_epoch`=2 WHERE `workspace_id`=? AND `channel_connection_id`=? AND `user_key`=?",
      [scope.workspaceId, scope.channelConnectionId, scope.userKey]
    );
    const eraseArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      2,
      scope.userKey,
      scope.walletId,
      scope.financialSubjectRef,
    ];
    const [pending] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,?,?,?,?)",
      eraseArgs
    );
    expect(pending[0]?.[0]?.result).toBe("pending_holds");
    const [[pendingWallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`refund_adjustment_entry_id` AS refundAdjustmentEntryId FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(pendingWallet).toMatchObject({
      status: "frozen",
      refundAdjustmentEntryId: null,
    });
    await connection.query(
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        owner,
        "pretransport",
        randomUUID(),
        hash("erase-release"),
      ]
    );
    const [erased] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,?,?,?,?)",
      eraseArgs
    );
    expect(erased[0]?.[0]?.result).toBe("erased");
    const [retry] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,?,?,?,?)",
      eraseArgs
    );
    expect(retry[0]?.[0]?.result).toBe("already_applied");
    const [grantReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        intent.intentId,
        payment.paymentId,
        initialGrant.entryId,
        payment.evidenceHash,
      ]
    );
    expect(grantReplay[0]?.[0]?.result).toBe("already_applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`current_user_key_hash` AS userKey,`financial_subject_ref` AS financialRef,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({
      financialRef: scope.financialSubjectRef,
      reserved: 0,
      status: "erased",
      userKey: null,
    });
    const [[scrubbedIntent]] = await connection.query<RowDataPacket[]>(
      "SELECT `messenger_sender_user_key` AS userKey,`checkout_capability_hash` AS capability,`credit_identity_erased_at` AS erasedAt FROM `billing_intents` WHERE `intent_id`=?",
      [intent.intentId]
    );
    expect(scrubbedIntent.userKey).toBeNull();
    expect(scrubbedIntent.capability).toBeNull();
    expect(scrubbedIntent.erasedAt).toBeTruthy();
  });

  it("records and replays an exact chargeback debit without reactivating an erased wallet", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(
      scope,
      `post-erasure-chargeback-${randomUUID()}`
    );
    const payment = await makeIntentPaid(
      scope,
      intent,
      `post-erasure-chargeback-${randomUUID()}`
    );
    const rootGrant = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );

    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `status`='erasing',`privacy_epoch`=2 WHERE `workspace_id`=? AND `channel_connection_id`=? AND BINARY `user_key`=BINARY ?",
      [scope.workspaceId, scope.channelConnectionId, scope.userKey]
    );
    const [erased] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,2,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
      ]
    );
    expect(erased[0]?.[0]?.result).toBe("erased");

    const chargebackId = `chb_${randomUUID()}`;
    const evidenceHash = hash(`post-erasure-chargeback:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [chargebackId, evidenceHash, payment.paymentLedgerId]
    );
    const debitEntryId = randomUUID();
    const debitArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.walletId,
      scope.financialSubjectRef,
      rootGrant.entryId,
      chargebackId,
      debitEntryId,
      evidenceHash,
    ];
    const [debited] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      debitArgs
    );
    expect(debited[0]?.[0]?.result).toBe("applied");
    const [replayed] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      debitArgs
    );
    expect(replayed[0]?.[0]?.result).toBe("already_applied");

    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT wallet.\`status\`,wallet.\`current_user_key_hash\` AS userKey,
        wallet.\`privacy_erased_at\` AS erasedAt,wallet.\`credit_balance\` AS balance,
        wallet.\`reserved_credits\` AS reserved,
        wallet.\`refund_adjustment_entry_id\` AS adjustmentFence,
        (SELECT COUNT(*) FROM \`credit_ledger\` entry
          WHERE BINARY entry.\`entry_id\`=BINARY ?
            AND BINARY entry.\`wallet_id\`=BINARY wallet.\`wallet_id\`
            AND entry.\`workspace_id\`=wallet.\`workspace_id\` AND entry.\`mode\`=wallet.\`mode\`
            AND BINARY entry.\`root_grant_entry_id\`=BINARY ?
            AND entry.\`entry_kind\`='chargeback_debit'
            AND BINARY entry.\`provider_effect_id\`=BINARY ?
            AND BINARY entry.\`evidence_hash\`=BINARY ?) AS exactDebits
       FROM \`credit_wallets\` wallet WHERE BINARY wallet.\`wallet_id\`=BINARY ?`,
      [
        debitEntryId,
        rootGrant.entryId,
        chargebackId,
        evidenceHash,
        scope.walletId,
      ]
    );
    expect({
      status: state.status,
      userKey: state.userKey,
      balance: Number(state.balance),
      reserved: Number(state.reserved),
      adjustmentFence: state.adjustmentFence,
      exactDebits: Number(state.exactDebits),
    }).toEqual({
      status: "erased",
      userKey: null,
      balance: 0,
      reserved: 0,
      adjustmentFence: null,
      exactDebits: 1,
    });
    expect(state.erasedAt).toBeTruthy();
    const [[scrubbedIntent]] = await connection.query<RowDataPacket[]>(
      "SELECT `messenger_sender_user_key` AS userKey FROM `billing_intents` WHERE BINARY `intent_id`=BINARY ?",
      [intent.intentId]
    );
    expect(scrubbedIntent.userKey).toBeNull();
  });

  it.each(["commit", "release", "output_not_delivered", "expire"] as const)(
    "replays an exact %s after terminal scrub and wallet erasure",
    async terminalKind => {
      const scope = await createScope();
      const payment = await makeIntentPaid(
        scope,
        scope.checkoutReservation,
        randomUUID(),
        { grossAmount: "5.00" }
      );
      await grant(
        scope,
        scope.checkoutReservation.intentId,
        payment.paymentId,
        payment.evidenceHash
      );
      const reservationId = randomUUID();
      const ownerTokenHash = hash(
        `${terminalKind}-scrub-owner:${randomUUID()}`
      );
      await connection.query(
        "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.userKey,
          scope.walletId,
          scope.financialSubjectRef,
          reservationId,
          hash(`${terminalKind}-scrub-generation:${randomUUID()}`),
          ownerTokenHash,
          1,
          randomUUID(),
          hash(`${terminalKind}-scrub-hold:${randomUUID()}`),
        ]
      );
      if (
        terminalKind === "commit" ||
        terminalKind === "output_not_delivered"
      ) {
        await markReservationProviderAccepted(
          scope,
          reservationId,
          ownerTokenHash
        );
      }

      const entryId = randomUUID();
      const evidenceHash = hash(
        `${terminalKind}-terminal-evidence:${randomUUID()}`
      );
      const procedure =
        terminalKind === "commit"
          ? "credit_commit_reservation"
          : terminalKind === "release" ||
              terminalKind === "output_not_delivered"
            ? "credit_release_reservation"
            : "credit_expire_reservation";
      const callTerminal = (candidateEvidence: string) => {
        const argumentsBeforeEvidence = [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.userKey,
          scope.walletId,
          scope.financialSubjectRef,
          reservationId,
          ownerTokenHash,
          ...(terminalKind === "release"
            ? ["pretransport"]
            : terminalKind === "output_not_delivered"
              ? ["output_not_delivered"]
              : []),
          entryId,
          candidateEvidence,
        ];
        return connection.query<RowDataPacket[][]>(
          terminalKind === "release" || terminalKind === "output_not_delivered"
            ? `CALL \`${procedure}\`(?,'test',?,1,1,?,?,?,?,?,?,?,?)`
            : `CALL \`${procedure}\`(?,'test',?,1,1,?,?,?,?,?,?,?)`,
          argumentsBeforeEvidence
        );
      };

      if (terminalKind === "expire") {
        const [[expiry]] = await connection.query<RowDataPacket[]>(
          "SELECT UNIX_TIMESTAMP(`expires_at`)+1 AS futureTimestamp FROM `credit_reservations` WHERE `reservation_id`=?",
          [reservationId]
        );
        await connection.query("SET SESSION timestamp=?", [
          Number(expiry.futureTimestamp),
        ]);
      }
      try {
        const [terminal] = await callTerminal(evidenceHash);
        expect(terminal[0]?.[0]?.result).toBe("applied");
      } finally {
        await connection.query("SET SESSION timestamp=0");
      }

      const [[resolution]] = await connection.query<RowDataPacket[]>(
        "SELECT UNIX_TIMESTAMP(`resolution_due_at`)+1 AS futureTimestamp FROM `credit_reservations` WHERE `reservation_id`=?",
        [reservationId]
      );
      await connection.query("SET SESSION timestamp=?", [
        Number(resolution.futureTimestamp),
      ]);
      try {
        const [scrubbed] = await connection.query<RowDataPacket[][]>(
          "CALL `credit_scrub_terminal_reservation`(?,'test',?,1,1,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            scope.walletId,
            scope.financialSubjectRef,
            reservationId,
          ]
        );
        expect(scrubbed[0]?.[0]?.result).toBe("applied");
      } finally {
        await connection.query("SET SESSION timestamp=0");
      }
      const [[ownerScrubbed]] = await connection.query<RowDataPacket[]>(
        "SELECT `owner_token_hash` AS ownerTokenHash,`generation_request_key_hash` AS generationRequestKeyHash FROM `credit_reservations` WHERE `reservation_id`=?",
        [reservationId]
      );
      expect(ownerScrubbed).toMatchObject({
        generationRequestKeyHash: null,
        ownerTokenHash: null,
      });

      await connection.query(
        "UPDATE `messenger_privacy_subjects` SET `status`='erasing',`privacy_epoch`=2 WHERE `workspace_id`=? AND `channel_connection_id`=? AND BINARY `user_key`=BINARY ?",
        [scope.workspaceId, scope.channelConnectionId, scope.userKey]
      );
      const [erased] = await connection.query<RowDataPacket[][]>(
        "CALL `credit_erase_wallet`(?,'test',?,1,1,2,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.userKey,
          scope.walletId,
          scope.financialSubjectRef,
        ]
      );
      expect(erased[0]?.[0]?.result).toBe("erased");

      const [replayed] = await callTerminal(evidenceHash);
      expect(replayed[0]?.[0]?.result).toBe("already_applied");
      await expect(
        callTerminal(
          hash(`${terminalKind}-conflicting-evidence:${randomUUID()}`)
        )
      ).rejects.toThrow(
        `credit ${
          terminalKind === "expire"
            ? "expiry"
            : terminalKind === "output_not_delivered"
              ? "release"
              : terminalKind
        } replay conflicts with terminal evidence`
      );
      await expect(
        connection.query(
          "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            scope.userKey,
            scope.walletId,
            scope.financialSubjectRef,
            randomUUID(),
            hash(`${terminalKind}-new-generation:${randomUUID()}`),
            hash(`${terminalKind}-new-owner:${randomUUID()}`),
            1,
            randomUUID(),
            hash(`${terminalKind}-new-hold:${randomUUID()}`),
          ]
        )
      ).rejects.toThrow();
    }
  );

  it("keeps an ambiguous provider wallet discoverable until exact containment", async () => {
    const scope = await createScope({ userKey: LEGACY_USER_A });
    const intent = await createCreditIntent(scope, randomUUID());
    await makeIntentPaid(scope, intent, randomUUID(), {
      operationState: "ambiguous",
    });
    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `status`='erasing',`privacy_epoch`=2 WHERE `workspace_id`=? AND `channel_connection_id`=? AND `user_key`=?",
      [scope.workspaceId, scope.channelConnectionId, scope.userKey]
    );
    const erasureScope = {
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      bindingEpoch: 1,
      dataPrivacyEpoch: 1,
      erasurePrivacyEpoch: 2,
      userKey: scope.userKey,
    };
    await expect(
      eraseCreditWalletsForPrivacySubject(erasureScope)
    ).resolves.toEqual({ result: "pending", walletCount: 1 });
    const [[retained]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`current_user_key_hash` AS userKey FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(retained).toMatchObject({
      status: "frozen",
      userKey: LEGACY_USER_A,
    });
    const [[scrubbedIntent]] = await connection.query<RowDataPacket[]>(
      "SELECT `messenger_sender_user_key` AS userKey,`checkout_capability_hash` AS capability,`credit_identity_erased_at` AS erasedAt FROM `billing_intents` WHERE `intent_id`=?",
      [intent.intentId]
    );
    expect(scrubbedIntent.userKey).toBeNull();
    expect(scrubbedIntent.capability).toBeNull();
    expect(scrubbedIntent.erasedAt).toBeTruthy();

    await expect(
      eraseCreditWalletsForPrivacySubject(erasureScope)
    ).resolves.toEqual({ result: "pending", walletCount: 1 });
    await connection.query(
      "UPDATE `billing_provider_operations` SET `state`='contained',`completed_at`=CURRENT_TIMESTAMP WHERE `workspace_id`=? AND `mode`='test' AND `intent_id`=? AND `operation_type`='create_payment'",
      [scope.workspaceId, intent.intentId]
    );
    await expect(
      eraseCreditWalletsForPrivacySubject(erasureScope)
    ).resolves.toEqual({ result: "erased", walletCount: 1 });
    const [[detached]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`current_user_key_hash` AS userKey FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(detached).toMatchObject({ status: "erased", userKey: null });
  });

  it("records only an exact full refund and waits for active holds", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    const grantEntry = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const refundEvidence = hash(`refund-snapshot:${randomUUID()}`);
    const refundId = `re_${randomUUID()}`;
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(),`observed_snapshot_hash`=? WHERE `id`=?",
      [refundEvidence, payment.paymentLedgerId]
    );
    await expect(
      connection.query(
        "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          randomUUID(),
          refundEvidence,
        ]
      )
    ).rejects.toThrow("incomplete or mismatched");
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [refundId, refundEvidence, payment.paymentLedgerId]
    );
    const reservationId = randomUUID();
    const owner = hash(`refund-owner:${randomUUID()}`);
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash(`refund-generation:${randomUUID()}`),
        owner,
        1,
        randomUUID(),
        hash(`refund-hold:${randomUUID()}`),
      ]
    );
    const adjustmentEntry = randomUUID();
    const [pending] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        adjustmentEntry,
        refundEvidence,
      ]
    );
    expect(pending[0]?.[0]?.result).toBe("pending_holds");
    await connection.query(
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        owner,
        "pretransport",
        randomUUID(),
        hash(`refund-release:${randomUUID()}`),
      ]
    );
    const [applied] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        adjustmentEntry,
        refundEvidence,
      ]
    );
    expect(applied[0]?.[0]?.result).toBe("applied");
    const [replay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        adjustmentEntry,
        refundEvidence,
      ]
    );
    expect(replay[0]?.[0]?.result).toBe("already_applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`status`,`refund_adjustment_entry_id` AS refundAdjustmentEntryId FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({
      balance: 0,
      reserved: 0,
      status: "active",
      refundAdjustmentEntryId: null,
    });
  });

  it("keeps erasure pending until an exact held refund settles, then scrubs the wallet", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(
      scope,
      `refund-erasure-${randomUUID()}`
    );
    const payment = await makeIntentPaid(
      scope,
      intent,
      `refund-erasure-${randomUUID()}`
    );
    const rootGrant = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const refundEvidence = hash(`refund-erasure:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [`re_${randomUUID()}`, refundEvidence, payment.paymentLedgerId]
    );

    const reservationId = randomUUID();
    const ownerTokenHash = hash(`refund-erasure-owner:${randomUUID()}`);
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash(`refund-erasure-generation:${randomUUID()}`),
        ownerTokenHash,
        1,
        randomUUID(),
        hash(`refund-erasure-hold:${randomUUID()}`),
      ]
    );
    const adjustmentEntryId = randomUUID();
    const adjustmentArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.walletId,
      scope.financialSubjectRef,
      rootGrant.entryId,
      adjustmentEntryId,
      refundEvidence,
    ];
    const callAdjustment = () =>
      connection.query<RowDataPacket[][]>(
        "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
        adjustmentArgs
      );
    const [pendingRefund] = await callAdjustment();
    expect(pendingRefund[0]?.[0]?.result).toBe("pending_holds");

    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `status`='erasing',`privacy_epoch`=2 WHERE `workspace_id`=? AND `channel_connection_id`=? AND BINARY `user_key`=BINARY ?",
      [scope.workspaceId, scope.channelConnectionId, scope.userKey]
    );
    const erasureScope = {
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      bindingEpoch: 1,
      dataPrivacyEpoch: 1,
      erasurePrivacyEpoch: 2,
      userKey: scope.userKey,
    };
    await expect(
      eraseCreditWalletsForPrivacySubject(erasureScope)
    ).resolves.toEqual({ result: "pending", walletCount: 1 });
    const [[held]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`current_user_key_hash` AS userKey,`refund_adjustment_entry_id` AS adjustmentFence FROM `credit_wallets` WHERE BINARY `wallet_id`=BINARY ?",
      [scope.walletId]
    );
    expect(held).toMatchObject({
      status: "frozen",
      userKey: scope.userKey,
      adjustmentFence: adjustmentEntryId,
    });

    await connection.query(
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        ownerTokenHash,
        "pretransport",
        randomUUID(),
        hash(`refund-erasure-release:${randomUUID()}`),
      ]
    );
    await expect(
      eraseCreditWalletsForPrivacySubject(erasureScope)
    ).resolves.toEqual({ result: "pending", walletCount: 1 });
    const [[adjustmentPending]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`refund_adjustment_entry_id` AS adjustmentFence FROM `credit_wallets` WHERE BINARY `wallet_id`=BINARY ?",
      [scope.walletId]
    );
    expect(adjustmentPending).toMatchObject({
      status: "frozen",
      adjustmentFence: adjustmentEntryId,
    });

    const [applied] = await callAdjustment();
    expect(applied[0]?.[0]?.result).toBe("applied");
    const [replayed] = await callAdjustment();
    expect(replayed[0]?.[0]?.result).toBe("already_applied");
    await expect(
      eraseCreditWalletsForPrivacySubject(erasureScope)
    ).resolves.toEqual({ result: "erased", walletCount: 1 });

    const [[erased]] = await connection.query<RowDataPacket[]>(
      `SELECT wallet.\`status\`,wallet.\`current_user_key_hash\` AS userKey,
        wallet.\`privacy_erased_at\` AS erasedAt,wallet.\`credit_balance\` AS balance,
        wallet.\`refund_adjustment_entry_id\` AS adjustmentFence,
        (SELECT COUNT(*) FROM \`credit_ledger\` entry
          WHERE BINARY entry.\`entry_id\`=BINARY ?
            AND BINARY entry.\`root_grant_entry_id\`=BINARY ?
            AND entry.\`entry_kind\`='refund_debit'
            AND BINARY entry.\`evidence_hash\`=BINARY ?) AS exactDebits
       FROM \`credit_wallets\` wallet WHERE BINARY wallet.\`wallet_id\`=BINARY ?`,
      [adjustmentEntryId, rootGrant.entryId, refundEvidence, scope.walletId]
    );
    expect({
      status: erased.status,
      userKey: erased.userKey,
      balance: Number(erased.balance),
      adjustmentFence: erased.adjustmentFence,
      exactDebits: Number(erased.exactDebits),
    }).toEqual({
      status: "erased",
      userKey: null,
      balance: 0,
      adjustmentFence: null,
      exactDebits: 1,
    });
    expect(erased.erasedAt).toBeTruthy();
    const [[scrubbedIntent]] = await connection.query<RowDataPacket[]>(
      "SELECT `messenger_sender_user_key` AS userKey,`checkout_capability_hash` AS capability,`credit_identity_erased_at` AS erasedAt FROM `billing_intents` WHERE BINARY `intent_id`=BINARY ?",
      [intent.intentId]
    );
    expect(scrubbedIntent.userKey).toBeNull();
    expect(scrubbedIntent.capability).toBeNull();
    expect(scrubbedIntent.erasedAt).toBeTruthy();
  });

  it("blocks new provider transport once an exact refund adjustment is pending", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const reservationId = randomUUID();
    const ownerTokenHash = hash(`refund-race-owner:${randomUUID()}`);
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash(`refund-race-generation:${randomUUID()}`),
        ownerTokenHash,
        1,
        randomUUID(),
        hash(`refund-race-hold:${randomUUID()}`),
      ]
    );
    const adjustmentEntryId = randomUUID();
    await connection.query(
      "UPDATE `credit_wallets` SET `refund_adjustment_entry_id`=? WHERE `wallet_id`=? AND `status`='active'",
      [adjustmentEntryId, scope.walletId]
    );

    await expect(
      connection.query(
        "CALL `credit_mark_reservation_transport_started`(?,'test',?,1,1,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.userKey,
          scope.walletId,
          scope.financialSubjectRef,
          reservationId,
          ownerTokenHash,
        ]
      )
    ).rejects.toMatchObject({
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "credit transport wallet scope is stale",
    });
    const [[reservation]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`transport_state` AS transportState FROM `credit_reservations` WHERE `reservation_id`=?",
      [reservationId]
    );
    expect(reservation).toMatchObject({
      status: "reserved",
      transportState: "pretransport",
    });
  });

  it("debits an unspent refunded grant without freezing another untouched package", async () => {
    const scope = await createScope();
    const firstIntent = await createCreditIntent(
      scope,
      `refund-a-${randomUUID()}`
    );
    const firstPayment = await makeIntentPaid(
      scope,
      firstIntent,
      `refund-a-${randomUUID()}`
    );
    const firstGrant = await grant(
      scope,
      firstIntent.intentId,
      firstPayment.paymentId,
      firstPayment.evidenceHash
    );
    const secondIntent = await createCreditIntent(
      scope,
      `refund-b-${randomUUID()}`
    );
    const secondPayment = await makeIntentPaid(
      scope,
      secondIntent,
      `refund-b-${randomUUID()}`
    );
    const secondGrant = await grant(
      scope,
      secondIntent.intentId,
      secondPayment.paymentId,
      secondPayment.evidenceHash
    );
    const refundEvidence = hash(`clean-pooled-refund:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [`re_${randomUUID()}`, refundEvidence, firstPayment.paymentLedgerId]
    );

    const [outcome] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        firstGrant.entryId,
        randomUUID(),
        refundEvidence,
      ]
    );
    expect(outcome[0]?.[0]?.result).toBe("applied");
    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT wallet.\`status\`,wallet.\`credit_balance\` AS balance,
        wallet.\`refund_adjustment_entry_id\` AS refundAdjustmentEntryId,
        (SELECT COUNT(*) FROM \`credit_ledger\` WHERE \`root_grant_entry_id\`=?) AS firstAdjustments,
        (SELECT COUNT(*) FROM \`credit_ledger\` WHERE \`root_grant_entry_id\`=?) AS secondAdjustments
       FROM \`credit_wallets\` wallet WHERE wallet.\`wallet_id\`=?`,
      [firstGrant.entryId, secondGrant.entryId, scope.walletId]
    );
    expect({
      status: state.status,
      balance: Number(state.balance),
      refundAdjustmentEntryId: state.refundAdjustmentEntryId,
      firstAdjustments: Number(state.firstAdjustments),
      secondAdjustments: Number(state.secondAdjustments),
    }).toEqual({
      status: "active",
      balance: 10,
      refundAdjustmentEntryId: null,
      firstAdjustments: 1,
      secondAdjustments: 0,
    });
  });

  it("never debits replacement credits when the refunded grant may have been spent", async () => {
    const scope = await createScope();
    const firstIntent = await createCreditIntent(
      scope,
      `spent-a-${randomUUID()}`
    );
    const firstPayment = await makeIntentPaid(
      scope,
      firstIntent,
      `spent-a-${randomUUID()}`
    );
    const firstGrant = await grant(
      scope,
      firstIntent.intentId,
      firstPayment.paymentId,
      firstPayment.evidenceHash
    );
    const reservationId = randomUUID();
    const ownerTokenHash = hash(`spent-a-owner:${reservationId}`);
    await connection.query(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        hash(`spent-a-generation:${reservationId}`),
        ownerTokenHash,
        1,
        randomUUID(),
        hash(`spent-a-hold:${reservationId}`),
      ]
    );
    await markReservationProviderAccepted(scope, reservationId, ownerTokenHash);
    await connection.query(
      "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        ownerTokenHash,
        randomUUID(),
        hash(`spent-a-commit:${reservationId}`),
      ]
    );
    const secondIntent = await createCreditIntent(
      scope,
      `spent-b-${randomUUID()}`
    );
    const secondPayment = await makeIntentPaid(
      scope,
      secondIntent,
      `spent-b-${randomUUID()}`
    );
    const secondGrant = await grant(
      scope,
      secondIntent.intentId,
      secondPayment.paymentId,
      secondPayment.evidenceHash
    );
    const refundEvidence = hash(`spent-a-refund:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [`re_${randomUUID()}`, refundEvidence, firstPayment.paymentLedgerId]
    );

    const [outcome] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        firstGrant.entryId,
        randomUUID(),
        refundEvidence,
      ]
    );
    expect(outcome[0]?.[0]?.result).toBe("manual_review");
    const [[state]] = await connection.query<RowDataPacket[]>(
      `SELECT wallet.\`status\`,wallet.\`credit_balance\` AS balance,
        wallet.\`refund_adjustment_entry_id\` AS refundAdjustmentEntryId,
        (SELECT COUNT(*) FROM \`credit_ledger\` WHERE \`root_grant_entry_id\`=? AND \`entry_kind\`='refund_debit') AS refundDebits,
        (SELECT COUNT(*) FROM \`credit_ledger\` WHERE \`entry_id\`=? AND \`entry_kind\`='purchase_grant') AS secondGrantRetained
       FROM \`credit_wallets\` wallet WHERE wallet.\`wallet_id\`=?`,
      [firstGrant.entryId, secondGrant.entryId, scope.walletId]
    );
    expect({
      status: state.status,
      balance: Number(state.balance),
      refundAdjustmentEntryId: state.refundAdjustmentEntryId,
      refundDebits: Number(state.refundDebits),
      secondGrantRetained: Number(state.secondGrantRetained),
    }).toEqual({
      status: "frozen",
      balance: 19,
      refundAdjustmentEntryId: null,
      refundDebits: 0,
      secondGrantRetained: 1,
    });
  });

  it("does not reactivate a wallet frozen for an unrelated reason", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, `unrelated-${randomUUID()}`);
    const payment = await makeIntentPaid(
      scope,
      intent,
      `unrelated-${randomUUID()}`
    );
    const rootGrant = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const refundEvidence = hash(`unrelated-refund:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [`re_${randomUUID()}`, refundEvidence, payment.paymentLedgerId]
    );
    const abandonedRefundFence = randomUUID();
    await connection.query(
      "UPDATE `credit_wallets` SET `refund_adjustment_entry_id`=? WHERE `wallet_id`=?",
      [abandonedRefundFence, scope.walletId]
    );
    await expect(
      connection.query(
        "UPDATE `credit_wallets` SET `refund_adjustment_entry_id`=NULL WHERE `wallet_id`=?",
        [scope.walletId]
      )
    ).rejects.toMatchObject({
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage:
        "credit refund adjustment fence requires exact debit evidence",
    });
    await connection.query(
      "UPDATE `credit_wallets` SET `status`='frozen',`refund_adjustment_entry_id`=NULL WHERE `wallet_id`=?",
      [scope.walletId]
    );

    const [outcome] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        rootGrant.entryId,
        randomUUID(),
        refundEvidence,
      ]
    );
    expect(outcome[0]?.[0]?.result).toBe("manual_review");
    const [[state]] = await connection.query<RowDataPacket[]>(
      "SELECT `status`,`credit_balance` AS balance,`refund_adjustment_entry_id` AS refundAdjustmentEntryId FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(state).toMatchObject({
      status: "frozen",
      balance: 10,
      refundAdjustmentEntryId: null,
    });
  });

  it("records two completed partial refunds as one immutable aggregate debit", async () => {
    const scope = await createScope();
    const payment = await makeIntentPaid(
      scope,
      scope.checkoutReservation,
      randomUUID(),
      { grossAmount: "5.00" }
    );
    const grantEntry = await grant(
      scope,
      scope.checkoutReservation.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const firstRefundId = `re_${randomUUID()}`;
    const secondRefundId = `re_${randomUUID()}`;
    const failedRefundId = `re_${randomUUID()}`;
    const malformedEvidence = hash(
      `aggregate-refund-malformed:${randomUUID()}`
    );
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','2.004','currency','EUR')),JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','2.996','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [
        firstRefundId,
        secondRefundId,
        malformedEvidence,
        payment.paymentLedgerId,
      ]
    );
    await expect(
      connection.query(
        "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          randomUUID(),
          malformedEvidence,
        ]
      )
    ).rejects.toThrow("refund set is incomplete or mismatched");
    const evidenceA = hash(`aggregate-refund-a:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','2.00','currency','EUR')),JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','3.00','currency','EUR')),JSON_OBJECT('id',?,'status','failed','amount',JSON_OBJECT('value','1.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [
        firstRefundId,
        secondRefundId,
        failedRefundId,
        evidenceA,
        payment.paymentLedgerId,
      ]
    );
    const adjustmentEntryId = randomUUID();
    const refundArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.walletId,
      scope.financialSubjectRef,
      grantEntry.entryId,
      adjustmentEntryId,
      evidenceA,
    ];
    const [applied] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      refundArgs
    );
    expect(applied[0]?.[0]?.result).toBe("applied");

    const [[adjustment]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count,MAX(`provider_effect_amount`) AS amount,MAX(CAST(`provider_effect_evidence` AS CHAR)) AS evidence FROM `credit_ledger` WHERE `root_grant_entry_id`=? AND `entry_kind`='refund_debit'",
      [grantEntry.entryId]
    );
    expect(Number(adjustment.count)).toBe(1);
    expect(String(adjustment.amount)).toBe("5.00");
    expect(JSON.parse(String(adjustment.evidence))).toEqual([
      {
        amount: { currency: "EUR", value: "2.00" },
        id: firstRefundId,
        status: "refunded",
      },
      {
        amount: { currency: "EUR", value: "3.00" },
        id: secondRefundId,
        status: "refunded",
      },
      {
        amount: { currency: "EUR", value: "1.00" },
        id: failedRefundId,
        status: "failed",
      },
    ]);
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({ balance: 0, reserved: 0 });

    const evidenceB = hash(`aggregate-refund-b:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','pending','amount',JSON_OBJECT('value','5.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [`re_${randomUUID()}`, evidenceB, payment.paymentLedgerId]
    );
    const [replayed] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      refundArgs
    );
    expect(replayed[0]?.[0]?.result).toBe("already_applied");
    await expect(
      connection.query(
        "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          randomUUID(),
          evidenceA,
        ]
      )
    ).rejects.toThrow("refund replay conflicts with existing adjustment");
  });

  it("contains refund and chargeback cross-kind ordering without a second debit", async () => {
    const refundedScope = await createScope();
    const refundedIntent = await createCreditIntent(
      refundedScope,
      randomUUID()
    );
    const refundedPayment = await makeIntentPaid(
      refundedScope,
      refundedIntent,
      randomUUID()
    );
    const refundedGrant = await grant(
      refundedScope,
      refundedIntent.intentId,
      refundedPayment.paymentId,
      refundedPayment.evidenceHash
    );
    const refundId = `re_${randomUUID()}`;
    const refundEvidence = hash(`ordered-refund:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [refundId, refundEvidence, refundedPayment.paymentLedgerId]
    );
    const refundEntry = randomUUID();
    const [refunded] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        refundedScope.workspaceId,
        refundedScope.channelConnectionId,
        refundedScope.walletId,
        refundedScope.financialSubjectRef,
        refundedGrant.entryId,
        refundEntry,
        refundEvidence,
      ]
    );
    expect(refunded[0]?.[0]?.result).toBe("applied");
    const [[afterRefund]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`status` FROM `credit_wallets` WHERE `wallet_id`=?",
      [refundedScope.walletId]
    );
    expect(afterRefund).toMatchObject({ balance: 0, status: "active" });

    const laterChargebackId = `chb_${randomUUID()}`;
    const laterChargebackEvidence = hash(`ordered-chargeback:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [
        laterChargebackId,
        laterChargebackEvidence,
        refundedPayment.paymentLedgerId,
      ]
    );
    const chargebackArgs = [
      refundedScope.workspaceId,
      refundedScope.channelConnectionId,
      refundedScope.walletId,
      refundedScope.financialSubjectRef,
      refundedGrant.entryId,
      laterChargebackId,
      randomUUID(),
      laterChargebackEvidence,
    ];
    const [contained] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      chargebackArgs
    );
    expect(contained[0]?.[0]?.result).toBe("manual_review");
    const [containedReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      chargebackArgs
    );
    expect(containedReplay[0]?.[0]?.result).toBe("manual_review");
    const [[containedWallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`status` FROM `credit_wallets` WHERE `wallet_id`=?",
      [refundedScope.walletId]
    );
    const [[containedEntries]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `credit_ledger` WHERE `root_grant_entry_id`=?",
      [refundedGrant.entryId]
    );
    expect(containedWallet).toMatchObject({ balance: 0, status: "frozen" });
    expect(Number(containedEntries.count)).toBe(1);

    const chargedScope = await createScope();
    const chargedIntent = await createCreditIntent(chargedScope, randomUUID());
    const chargedPayment = await makeIntentPaid(
      chargedScope,
      chargedIntent,
      randomUUID()
    );
    const chargedGrant = await grant(
      chargedScope,
      chargedIntent.intentId,
      chargedPayment.paymentId,
      chargedPayment.evidenceHash
    );
    const firstChargebackId = `chb_${randomUUID()}`;
    const firstChargebackEvidence = hash(`first-chargeback:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [
        firstChargebackId,
        firstChargebackEvidence,
        chargedPayment.paymentLedgerId,
      ]
    );
    await connection.query(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        chargedScope.workspaceId,
        chargedScope.channelConnectionId,
        chargedScope.walletId,
        chargedScope.financialSubjectRef,
        chargedGrant.entryId,
        firstChargebackId,
        randomUUID(),
        firstChargebackEvidence,
      ]
    );
    const laterRefundId = `re_${randomUUID()}`;
    const laterRefundEvidence = hash(`later-refund:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [laterRefundId, laterRefundEvidence, chargedPayment.paymentLedgerId]
    );
    const [inverseContained] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?)",
      [
        chargedScope.workspaceId,
        chargedScope.channelConnectionId,
        chargedScope.walletId,
        chargedScope.financialSubjectRef,
        chargedGrant.entryId,
        randomUUID(),
        laterRefundEvidence,
      ]
    );
    expect(inverseContained[0]?.[0]?.result).toBe("manual_review");
    const [[inverseWallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`status` FROM `credit_wallets` WHERE `wallet_id`=?",
      [chargedScope.walletId]
    );
    const [[inverseEntries]] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM `credit_ledger` WHERE `root_grant_entry_id`=?",
      [chargedGrant.entryId]
    );
    expect(inverseWallet).toMatchObject({ balance: 0, status: "frozen" });
    expect(Number(inverseEntries.count)).toBe(1);
  });

  it("freezes every exact chargeback and never auto-thaws its exact restore", async () => {
    const scope = await createScope();
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    const grantEntry = await grant(
      scope,
      intent.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const chargebackId = `chb_${randomUUID()}`;
    const malformedChargebackEvidence = hash(
      `chargeback-malformed:${randomUUID()}`
    );
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.000','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [chargebackId, malformedChargebackEvidence, payment.paymentLedgerId]
    );
    await expect(
      connection.query(
        "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          chargebackId,
          randomUUID(),
          malformedChargebackEvidence,
        ]
      )
    ).rejects.toThrow("chargeback provider effect is incomplete or mismatched");
    const debitEvidence = hash(`chargeback-debit:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [chargebackId, debitEvidence, payment.paymentLedgerId]
    );
    const debitEntry = randomUUID();
    const debitArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.walletId,
      scope.financialSubjectRef,
      grantEntry.entryId,
      chargebackId,
      debitEntry,
      debitEvidence,
    ];
    const [debited] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      debitArgs
    );
    expect(debited[0]?.[0]?.result).toBe("applied");
    const restoreEvidence = hash(`chargeback-restore:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'),'reversedAt','2026-08-28T00:00:00Z')),`observed_snapshot_hash`=? WHERE `id`=?",
      [chargebackId, restoreEvidence, payment.paymentLedgerId]
    );
    const [debitReplayAfterLaterSnapshot] = await connection.query<
      RowDataPacket[][]
    >(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      debitArgs
    );
    expect(debitReplayAfterLaterSnapshot[0]?.[0]?.result).toBe(
      "already_applied"
    );
    await expect(
      connection.query(
        "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          chargebackId,
          randomUUID(),
          debitEvidence,
        ]
      )
    ).rejects.toThrow("chargeback replay conflicts with existing adjustment");
    const restoreEntry = randomUUID();
    const restoreArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      scope.walletId,
      scope.financialSubjectRef,
      grantEntry.entryId,
      chargebackId,
      restoreEntry,
      restoreEvidence,
    ];
    const [restored] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_restore`(?,'test',?,1,1,?,?,?,?,?,?)",
      restoreArgs
    );
    expect(restored[0]?.[0]?.result).toBe("applied_review_required");
    const laterSnapshotEvidence = hash(
      `chargeback-later-snapshot:${randomUUID()}`
    );
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(),`observed_snapshot_hash`=? WHERE `id`=?",
      [laterSnapshotEvidence, payment.paymentLedgerId]
    );
    const [replay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_restore`(?,'test',?,1,1,?,?,?,?,?,?)",
      restoreArgs
    );
    expect(replay[0]?.[0]?.result).toBe("already_applied");
    await expect(
      connection.query(
        "CALL `credit_apply_chargeback_restore`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          chargebackId,
          randomUUID(),
          restoreEvidence,
        ]
      )
    ).rejects.toThrow(
      "chargeback restore replay conflicts with existing adjustment"
    );
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`status` FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({
      balance: 10,
      reserved: 0,
      status: "frozen",
    });
  });

  it.each(["refund", "chargeback"] as const)(
    "terminalizes one delivered hold when a %s arrives before commit",
    async adjustmentKind => {
      const scope = await createScope();
      const intent = await createCreditIntent(scope, randomUUID());
      const payment = await makeIntentPaid(scope, intent, randomUUID());
      const root = await grant(
        scope,
        intent.intentId,
        payment.paymentId,
        payment.evidenceHash
      );
      const reservationId = randomUUID();
      const owner = hash(`race-owner:${reservationId}`);
      await connection.query(
        "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.userKey,
          scope.walletId,
          scope.financialSubjectRef,
          reservationId,
          hash(`race-generation:${reservationId}`),
          owner,
          1,
          randomUUID(),
          hash(`race-hold:${reservationId}`),
        ]
      );
      await markReservationProviderAccepted(scope, reservationId, owner);
      const effectId = `${adjustmentKind === "refund" ? "re" : "chb"}_${randomUUID()}`;
      const evidence = hash(`race-adjustment:${effectId}`);
      await connection.query(
        adjustmentKind === "refund"
          ? "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?"
          : "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
        [effectId, evidence, payment.paymentLedgerId]
      );
      const adjustmentId = randomUUID();
      const procedure =
        adjustmentKind === "refund"
          ? "credit_apply_refund_debit"
          : "credit_apply_chargeback_debit";
      const args =
        adjustmentKind === "refund"
          ? [
              scope.workspaceId,
              scope.channelConnectionId,
              scope.walletId,
              scope.financialSubjectRef,
              root.entryId,
              adjustmentId,
              evidence,
            ]
          : [
              scope.workspaceId,
              scope.channelConnectionId,
              scope.walletId,
              scope.financialSubjectRef,
              root.entryId,
              effectId,
              adjustmentId,
              evidence,
            ];
      const suffix = adjustmentKind === "refund" ? "?,?,?,?,?" : "?,?,?,?,?,?";
      const callAdjustment = () =>
        connection.query<RowDataPacket[][]>(
          `CALL \`${procedure}\`(?,'test',?,1,1,${suffix})`,
          args
        );
      const [pending] = await callAdjustment();
      expect(pending[0]?.[0]?.result).toBe("pending_holds");
      await expect(
        connection.query(
          "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            scope.userKey,
            scope.walletId,
            scope.financialSubjectRef,
            randomUUID(),
            hash(`blocked:${randomUUID()}`),
            hash(`blocked-owner:${randomUUID()}`),
            1,
            randomUUID(),
            hash(`blocked-hold:${randomUUID()}`),
          ]
        )
      ).rejects.toThrow();
      const commitArgs = [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.userKey,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        owner,
        randomUUID(),
        hash(`race-commit:${reservationId}`),
      ];
      const [committed] = await connection.query<RowDataPacket[][]>(
        "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
        commitArgs
      );
      expect(committed[0]?.[0]?.result).toBe("applied");
      const [commitReplay] = await connection.query<RowDataPacket[][]>(
        "CALL `credit_commit_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
        commitArgs
      );
      expect(commitReplay[0]?.[0]?.result).toBe("already_applied");
      const [adjusted] = await callAdjustment();
      expect(adjusted[0]?.[0]?.result).toBe(
        adjustmentKind === "refund" ? "manual_review" : "applied"
      );
      const [adjustmentReplay] = await callAdjustment();
      expect(adjustmentReplay[0]?.[0]?.result).toBe(
        adjustmentKind === "refund" ? "manual_review" : "already_applied"
      );
      const [[counts]] = await connection.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM `credit_ledger` WHERE `reservation_id`=? AND `entry_kind`='generation_spend') AS spends,(SELECT COUNT(*) FROM `credit_ledger` WHERE `root_grant_entry_id`=? AND `entry_kind`=?) AS adjustments",
        [
          reservationId,
          root.entryId,
          adjustmentKind === "refund" ? "refund_debit" : "chargeback_debit",
        ]
      );
      expect(Number(counts.spends)).toBe(1);
      expect(Number(counts.adjustments)).toBe(
        adjustmentKind === "refund" ? 0 : 1
      );
    }
  );

  it("allows an exact freeze but denies direct wallet writes to the runtime principal", async () => {
    const scope = await createScope();
    const payment = await makeIntentPaid(
      scope,
      scope.checkoutReservation,
      randomUUID(),
      { grossAmount: "5.00" }
    );
    await grant(
      scope,
      scope.checkoutReservation.intentId,
      payment.paymentId,
      payment.evidenceHash
    );
    const adjustmentEvidence = hash(`freeze-adjustment:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `refunds`=JSON_ARRAY(JSON_OBJECT('id',?,'status','refunded','amount',JSON_OBJECT('value','5.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [`re_${randomUUID()}`, adjustmentEvidence, payment.paymentLedgerId]
    );
    const runtimeUser = `credit_rt_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const runtimePassword = randomUUID().replaceAll("-", "");
    let runtimePrincipalCreated = false;
    let runtimeConnection: Connection | undefined;
    try {
      const [[databaseRow]] = await connection.query<RowDataPacket[]>(
        "SELECT DATABASE() AS databaseName"
      );
      const databaseName = String(databaseRow.databaseName ?? "");
      expect(databaseName).not.toBe("");
      const databaseIdentifier = mysql.escapeId(databaseName);
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
      runtimeConnection = await mysql.createConnection(runtimeUrl.toString());

      await runtimeConnection.beginTransaction();
      const [frozen] = await runtimeConnection.query<RowDataPacket[][]>(
        "CALL `credit_freeze_wallet_for_review`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          scope.checkoutReservation.intentId,
          payment.paymentLedgerId,
          payment.paymentId,
          adjustmentEvidence,
        ]
      );
      expect(frozen[0]?.[0]?.result).toBe("applied");
      await runtimeConnection.commit();
      await expect(
        runtimeConnection.query(
          "UPDATE `credit_wallets` SET `status`='active' WHERE `wallet_id`=?",
          [scope.walletId]
        )
      ).rejects.toMatchObject({ code: "ER_TABLEACCESS_DENIED_ERROR" });

      const [[wallet]] = await connection.query<RowDataPacket[]>(
        "SELECT `status` FROM `credit_wallets` WHERE `wallet_id`=?",
        [scope.walletId]
      );
      expect(wallet.status).toBe("frozen");
    } finally {
      await runtimeConnection?.end();
      if (runtimePrincipalCreated) {
        await connection.query(`DROP USER \`${runtimeUser}\`@'%'`);
      }
    }
  });
});
