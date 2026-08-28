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

const USER_A = `u2.k1.${"a".repeat(64)}`;
const USER_B = `u2.k1.${"b".repeat(64)}`;
const FINANCIAL_REF = "c".repeat(64);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Scope = {
  channelConnectionId: number;
  financialSubjectRef: string;
  walletId: string;
  workspaceId: number;
};

suite("0017 credit wallet MySQL 8.4 procedure boundary", () => {
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

  async function createScope(options: { secondSubject?: boolean } = {}) {
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
      [workspaceId, channelConnectionId, USER_A]
    );
    if (options.secondSubject) {
      await connection.query(
        "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
        [workspaceId, channelConnectionId, USER_B]
      );
    }
    const walletId = randomUUID();
    const [rows] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_create_wallet`(?,?,'test',?,1,1,?,?)",
      [
        walletId,
        workspaceId,
        channelConnectionId,
        USER_A,
        FINANCIAL_REF,
      ]
    );
    expect(rows[0]?.[0]?.result).toBe("applied");
    return {
      channelConnectionId,
      financialSubjectRef: FINANCIAL_REF,
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
        USER_A,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        metadataHash,
        capabilityHash,
      ]
    );
    return { capabilityHash, intentId, metadataHash };
  }

  async function makeIntentPaid(
    scope: Scope,
    intent: Awaited<ReturnType<typeof createCreditIntent>>,
    label: string,
    options: {
      consume?: boolean;
      exposed?: boolean;
      operationState?: "contained" | "succeeded";
    } = {}
  ) {
    const paymentId = `tr_credit_${label}`;
    const evidenceHash = hash(`snapshot:${label}`);
    const exposed = options.exposed ?? true;
    const operationState = options.operationState ?? "succeeded";
    if (options.consume ?? true) {
      await connection.query(
        "CALL `credit_consume_checkout_capability`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_A,
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
      "INSERT INTO `payment_ledger` (`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`payment_method`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`paid_effect_applied`,`occurred_at`) VALUES (?,?,'test','19.00','EUR','paid','bancontact',JSON_ARRAY(),JSON_ARRAY(),?,0,CURRENT_TIMESTAMP)",
      [paymentId, scope.workspaceId, evidenceHash]
    );
    return { evidenceHash, paymentId, paymentLedgerId: payment.insertId };
  }

  async function grant(scope: Scope, intentId: string, paymentId: string, evidenceHash: string) {
    const entryId = randomUUID();
    const [rows] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_grant_purchase`(?, 'test', ?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
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

  async function openPeer() {
    const peer = await mysql.createConnection(process.env.DATABASE_URL!);
    await peer.query("SET SESSION sql_require_primary_key=ON");
    await peer.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    return peer;
  }

  async function runBehindControlBarrier<T>(
    scope: Scope,
    actions: [(peer: Connection) => Promise<T>, (peer: Connection) => Promise<T>]
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
      "CALL `credit_create_wallet`(?,?,'test',?,1,1,?,?)",
      [
        scope.walletId,
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.financialSubjectRef,
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

  it("rejects another Messenger subject at the reservation terminal boundary", async () => {
    const scope = await createScope({ secondSubject: true });
    const intent = await createCreditIntent(scope, randomUUID());
    const payment = await makeIntentPaid(scope, intent, randomUUID());
    await grant(scope, intent.intentId, payment.paymentId, payment.evidenceHash);
    const reservationId = randomUUID();
    const ownerHash = hash("reservation-owner");
    const holdEntryId = randomUUID();
    const holdEvidence = hash("hold-evidence");
    const [hold] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_create_reservation_hold`(?,'test',?,1,1,?,?,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
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
        USER_A,
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
    expect(afterWrongUser).toMatchObject({ stateVersion: 2, status: "reserved" });
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
    ).rejects.toThrow("credit commit wallet scope is stale");
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
        "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_A,
          scope.walletId,
          scope.financialSubjectRef,
          releaseReservationId,
          null,
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
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        releaseReservationId,
        releaseOwnerHash,
        releaseEntryId,
        releaseEvidence,
      ]
    );
    expect(released[0]?.[0]?.result).toBe("applied");
    await expect(
      connection.query(
        "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          USER_B,
          scope.walletId,
          scope.financialSubjectRef,
          releaseReservationId,
          releaseOwnerHash,
          releaseEntryId,
          releaseEvidence,
        ]
      )
    ).rejects.toThrow("credit release wallet scope is stale");
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
        a.query(
          "CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            USER_A,
            scope.walletId,
            scope.financialSubjectRef,
            intent.intentId,
            payment.paymentId,
            firstEntry,
            payment.evidenceHash,
          ]
        ),
      b =>
        b.query(
          "CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)",
          [
            scope.workspaceId,
            scope.channelConnectionId,
            USER_A,
            scope.walletId,
            scope.financialSubjectRef,
            intent.intentId,
            payment.paymentId,
            secondEntry,
            payment.evidenceHash,
          ]
        ),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const grantRejection = outcomes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(
      (grantRejection?.reason as { code?: string; message?: string }).code
    ).toBe("ER_SIGNAL_EXCEPTION");
    expect(
      (grantRejection?.reason as { message?: string }).message
    ).toContain("credit grant replay conflicts with existing payment effect");
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
    expect(holds.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(holds.filter(result => result.status === "rejected")).toHaveLength(1);
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

  it("freezes erasure around a hold, then scrubs identity with retryable provider status", async () => {
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
      "UPDATE `messenger_privacy_subjects` SET `status`='erasing' WHERE `workspace_id`=? AND `channel_connection_id`=? AND `user_key`=?",
      [scope.workspaceId, scope.channelConnectionId, USER_A]
    );
    const eraseArgs = [
      scope.workspaceId,
      scope.channelConnectionId,
      USER_A,
      scope.walletId,
      scope.financialSubjectRef,
    ];
    const [pending] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,?,?,?)",
      eraseArgs
    );
    expect(pending[0]?.[0]?.result).toBe("pending_holds");
    await connection.query(
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        owner,
        randomUUID(),
        hash("erase-release"),
      ]
    );
    const [erased] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,?,?,?)",
      eraseArgs
    );
    expect(erased[0]?.[0]?.result).toBe("erased_pending_provider");
    const [retry] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_erase_wallet`(?,'test',?,1,1,?,?,?)",
      eraseArgs
    );
    expect(retry[0]?.[0]?.result).toBe("erased_pending_provider");
    const [grantReplay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_grant_purchase`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
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
        "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          scope.workspaceId,
          scope.channelConnectionId,
          scope.walletId,
          scope.financialSubjectRef,
          grantEntry.entryId,
          refundId,
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
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        refundId,
        adjustmentEntry,
        refundEvidence,
      ]
    );
    expect(pending[0]?.[0]?.result).toBe("pending_holds");
    await connection.query(
      "CALL `credit_release_reservation`(?,'test',?,1,1,?,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        USER_A,
        scope.walletId,
        scope.financialSubjectRef,
        reservationId,
        owner,
        randomUUID(),
        hash(`refund-release:${randomUUID()}`),
      ]
    );
    const [applied] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        refundId,
        adjustmentEntry,
        refundEvidence,
      ]
    );
    expect(applied[0]?.[0]?.result).toBe("applied");
    const [replay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        refundId,
        adjustmentEntry,
        refundEvidence,
      ]
    );
    expect(replay[0]?.[0]?.result).toBe("already_applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`status` FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({ balance: 0, reserved: 0, status: "frozen" });
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
      "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        refundedScope.workspaceId,
        refundedScope.channelConnectionId,
        refundedScope.walletId,
        refundedScope.financialSubjectRef,
        refundedGrant.entryId,
        refundId,
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
    const laterChargebackEvidence = hash(
      `ordered-chargeback:${randomUUID()}`
    );
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
    const firstChargebackEvidence = hash(
      `first-chargeback:${randomUUID()}`
    );
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
    await expect(
      connection.query(
        "CALL `credit_apply_refund_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
        [
          chargedScope.workspaceId,
          chargedScope.channelConnectionId,
          chargedScope.walletId,
          chargedScope.financialSubjectRef,
          chargedGrant.entryId,
          laterRefundId,
          randomUUID(),
          laterRefundEvidence,
        ]
      )
    ).rejects.toThrow("refund replay conflicts with existing adjustment");
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
    const debitEvidence = hash(`chargeback-debit:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'))),`observed_snapshot_hash`=? WHERE `id`=?",
      [chargebackId, debitEvidence, payment.paymentLedgerId]
    );
    const debitEntry = randomUUID();
    const [debited] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_debit`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        chargebackId,
        debitEntry,
        debitEvidence,
      ]
    );
    expect(debited[0]?.[0]?.result).toBe("applied");
    const restoreEvidence = hash(`chargeback-restore:${randomUUID()}`);
    await connection.query(
      "UPDATE `payment_ledger` SET `chargebacks`=JSON_ARRAY(JSON_OBJECT('id',?,'amount',JSON_OBJECT('value','19.00','currency','EUR'),'reversedAt','2026-08-28T00:00:00Z')),`observed_snapshot_hash`=? WHERE `id`=?",
      [chargebackId, restoreEvidence, payment.paymentLedgerId]
    );
    const restoreEntry = randomUUID();
    const [restored] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_restore`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        chargebackId,
        restoreEntry,
        restoreEvidence,
      ]
    );
    expect(restored[0]?.[0]?.result).toBe("applied_review_required");
    const [replay] = await connection.query<RowDataPacket[][]>(
      "CALL `credit_apply_chargeback_restore`(?,'test',?,1,1,?,?,?,?,?,?)",
      [
        scope.workspaceId,
        scope.channelConnectionId,
        scope.walletId,
        scope.financialSubjectRef,
        grantEntry.entryId,
        chargebackId,
        restoreEntry,
        restoreEvidence,
      ]
    );
    expect(replay[0]?.[0]?.result).toBe("already_applied");
    const [[wallet]] = await connection.query<RowDataPacket[]>(
      "SELECT `credit_balance` AS balance,`reserved_credits` AS reserved,`status` FROM `credit_wallets` WHERE `wallet_id`=?",
      [scope.walletId]
    );
    expect(wallet).toMatchObject({ balance: 10, reserved: 0, status: "frozen" });
  });
});
