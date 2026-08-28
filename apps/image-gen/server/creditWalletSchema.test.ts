import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../drizzle/0017_credit_wallet_expand.sql", import.meta.url),
  "utf8"
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8"
);
const snapshot = JSON.parse(
  readFileSync(
    new URL("../drizzle/meta/0017_snapshot.json", import.meta.url),
    "utf8"
  )
) as {
  tables: {
    credit_ledger: {
      checkConstraint: Record<string, { value: string }>;
    };
  };
};
const statements = migration
  .split("--> statement-breakpoint")
  .map(statement => statement.trim())
  .filter(Boolean);
const procedureNames = Array.from(
  migration.matchAll(/CREATE PROCEDURE `([^`]+)`/g),
  match => match[1]
).sort();
const triggerNames = Array.from(
  migration.matchAll(/CREATE TRIGGER `([^`]+)`/g),
  match => match[1]
).sort();

describe("0017 direct Messenger purchased-credit schema", () => {
  it("locks the compact payment prerequisite before any credit DDL", () => {
    expect(statements).toHaveLength(54);
    expect(statements[0]).toMatch(
      /^CREATE TEMPORARY TABLE `credit_0017_legacy_effect_preflight`/
    );
    expect(statements[1]).toBe(
      "DROP TEMPORARY TABLE `credit_0017_legacy_effect_preflight`;"
    );
    expect(statements[2]).toBe(
      "ALTER TABLE `billing_outbox` MODIFY COLUMN `event_type` enum('ensure_subscription','cancel_subscription','cancel_payment','credit_adjustment_retry','payment_warning','manual_review','send_portal_handoff') NOT NULL;"
    );
    expect(statements[3]).toBe(
      "ALTER TABLE `payment_ledger`\n\tADD CONSTRAINT `payment_ledger_exact_payment_scope_unique` UNIQUE(`id`,`workspace_id`,`mode`,`mollie_payment_id`);"
    );
    expect(
      statements.findIndex(statement =>
        statement.includes("CREATE TABLE `credit_")
      )
    ).toBeGreaterThan(0);
  });

  it("keeps the NULL-closed reservation terminal constraint in schema parity", () => {
    const sqlConstraint = migration.match(
      /CONSTRAINT `credit_ledger_reservation_terminal_shape` CHECK\((.*?)\),\n\tCONSTRAINT `credit_ledger_chain_shape`/s
    )?.[1];
    expect(sqlConstraint).toMatch(/\) IS TRUE$/);
    expect(schema).toContain(
      '"credit_ledger_reservation_terminal_shape",\n      sql`(('
    );
    expect(schema).toContain(")) IS TRUE`");
    expect(
      snapshot.tables.credit_ledger.checkConstraint
        .credit_ledger_reservation_terminal_shape.value
    ).toMatch(/\) IS TRUE$/);
  });

  it("adds only wallet, reservation, and immutable ledger storage", () => {
    expect(
      Array.from(
        migration.matchAll(/CREATE TABLE `([^`]+)`/g),
        match => match[1]
      )
    ).toEqual(["credit_ledger", "credit_reservations", "credit_wallets"]);
    expect(migration).not.toMatch(
      /credit_(?:checkout_intents|execution_controls|provider_operations|funding_lots|subscriptions|entitlements)/
    );
    expect(migration).not.toContain("credit_claim_legacy_billing_effect");
    expect(migration).toContain(
      "`kind` enum('subscription_start','payment_method_change','startpilot_purchase','credit_purchase')"
    );
    expect(migration).toContain("billing_provider_operations");
    expect(migration).toContain("billing_execution_controls");
  });

  it("stores a short-lived nonce-bound capability only on credit intents", () => {
    expect(migration).toContain("`checkout_capability_hash` varchar(64)");
    expect(migration).toContain("`checkout_capability_expires_at` timestamp");
    expect(migration).toContain("`checkout_capability_consumed_at` timestamp");
    expect(migration).toContain(
      "`checkout_capability_session_nonce_hash` varchar(64)"
    );
    expect(migration).toContain("`credit_identity_erased_at` timestamp");
    expect(migration).toContain(
      "`checkout_capability_expires_at`<=TIMESTAMPADD(MINUTE,15,`created_at`)"
    );
    expect(migration).toContain(
      "`checkout_capability_consumed_at` IS NULL AND `checkout_capability_session_nonce_hash` IS NULL"
    );
    expect(migration).toContain(
      "`messenger_sender_user_key` IS NULL AND `checkout_capability_hash` IS NULL"
    );
    expect(migration).not.toMatch(/checkout_capability_generation/);
  });

  it("uses exact scope bindings without epoch-pinning mutable parents", () => {
    expect(migration).toContain(
      "FOREIGN KEY (`channel_connection_id`,`workspace_id`) REFERENCES `channelConnections`(`id`,`workspaceId`)"
    );
    expect(migration).toContain(
      "FOREIGN KEY (`workspace_id`,`channel_connection_id`,`current_user_key_hash`) REFERENCES `messenger_privacy_subjects`(`workspace_id`,`channel_connection_id`,`user_key`)"
    );
    expect(migration).not.toContain(
      "FOREIGN KEY (`channel_connection_id`,`workspace_id`,`binding_epoch`) REFERENCES `channelConnections`"
    );
    expect(migration).toContain(
      "FOREIGN KEY (`payment_ledger_id`,`workspace_id`,`mode`,`provider_payment_id`) REFERENCES `payment_ledger`(`id`,`workspace_id`,`mode`,`mollie_payment_id`)"
    );
    expect(migration).toContain(
      "FOREIGN KEY (`credit_intent_id`,`credit_wallet_id`,`workspace_id`,`mode`,`credit_metadata_hash`) REFERENCES `billing_intents`(`intent_id`,`credit_wallet_id`,`workspace_id`,`mode`,`credit_metadata_hash`)"
    );
    expect(migration).toContain(
      "^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$"
    );
  });

  it("installs only operation-specific definer procedures", () => {
    expect(procedureNames).toEqual([
      "credit_apply_chargeback_debit",
      "credit_apply_chargeback_restore",
      "credit_apply_refund_debit",
      "credit_commit_reservation",
      "credit_consume_checkout_capability",
      "credit_create_reservation_hold",
      "credit_create_wallet",
      "credit_erase_wallet",
      "credit_expire_reservation",
      "credit_freeze_wallet_for_review",
      "credit_grant_purchase",
      "credit_mark_reservation_provider_accepted",
      "credit_mark_reservation_transport_started",
      "credit_release_rejected_reservation",
      "credit_release_reservation",
      "credit_scrub_terminal_reservation",
    ]);
    expect(triggerNames).toHaveLength(14);
    expect(migration.match(/SQL SECURITY DEFINER/g)).toHaveLength(16);
    expect(
      migration.match(
        /DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END/g
      )
    ).toHaveLength(15);
    expect(migration.match(/START TRANSACTION;/g)).toHaveLength(15);
    expect(migration).not.toMatch(
      /CREATE PROCEDURE `credit_(?:configure|set_execution|start_checkout|resolve_checkout)/
    );
  });

  it("keeps wallet erasure discoverable across the production privacy epoch", () => {
    expect(migration).toContain("IN p_erasure_privacy_epoch int");
    expect(migration).toContain("p_erasure_privacy_epoch<>p_privacy_epoch+1");
    expect(migration).toContain("`privacy_epoch`=p_erasure_privacy_epoch");
    expect(migration).toContain(
      "SELECT 'pending_provider' AS `result`,p_wallet_id AS `wallet_id`"
    );
    expect(migration.indexOf("'pending_provider' AS `result`")).toBeLessThan(
      migration.indexOf("`current_user_key_hash`=NULL")
    );
    expect(migration).toContain(
      "`privacy_epoch`=p_privacy_epoch+1 AND `status` IN ('erasing','erased')"
    );
  });

  it("chains every wallet mutation to an immutable ledger row", () => {
    expect(migration).toContain(
      "wallet projection requires the exact inserted ledger entry"
    );
    expect(migration).toContain(
      "credit wallet projector compare-and-swap failed"
    );
    expect(migration).toContain("credit ledger is append only");
    expect(migration).toContain(
      "credit reservation state transition is invalid"
    );
    for (const column of [
      "previous_entry_id",
      "wallet_version_before",
      "wallet_version_after",
      "balance_before",
      "balance_after",
      "reserved_before",
      "reserved_after",
    ]) {
      expect(migration).toContain(`\`${column}\``);
    }
  });

  it("releases a started reservation only after a proven non-retryable 4xx", () => {
    expect(migration).toContain(
      "`transport_state` enum('pretransport','transport_started','known_accepted','known_rejected') NOT NULL DEFAULT 'pretransport'"
    );
    expect(migration).toContain(
      "v_status<>'reserved' OR v_transport<>'pretransport'"
    );
    expect(migration).toContain(
      "v_status<>'reserved' OR v_transport<>'known_accepted'"
    );
    expect(migration).toContain(
      "CREATE PROCEDURE `credit_mark_reservation_transport_started`"
    );
    expect(migration).toContain(
      "CREATE PROCEDURE `credit_mark_reservation_provider_accepted`"
    );
    expect(migration).toContain(
      "CREATE PROCEDURE `credit_release_rejected_reservation`"
    );
    expect(migration).toContain("p_rejection_status NOT BETWEEN 400 AND 499");
  });

  it("keeps legacy payment ownership compatible and credit ownership exact", () => {
    expect(migration).toContain("enum('legacy_billing','credit_grant')");
    expect(migration).toContain(
      "`payment_effect_owner_kind` IS NULL AND `payment_effect_owner_ref` IS NULL"
    );
    expect(migration).toContain(
      "BINARY `credit_purpose`=BINARY 'premium_image_credits'"
    );
    expect(migration).toContain(
      "NEW.`payment_effect_owner_kind`='credit_grant'"
    );
    expect(migration).toContain(
      "NEW.`paid_effect_applied`<OLD.`paid_effect_applied`"
    );
  });

  it("normalizes provider effects and keeps chargebacks frozen", () => {
    expect(migration).toContain(
      "JSON_TABLE(NEW.`provider_effect_evidence`,'$[*]'"
    );
    expect(migration).toContain(
      "BINARY CAST(payment.`refunds` AS CHAR)=BINARY CAST(NEW.`provider_effect_evidence` AS CHAR)"
    );
    expect(migration).toContain("JSON_TABLE(payment.`chargebacks`,'$[*]'");
    expect(migration).toContain(
      "CONSTRAINT `credit_ledger_provider_effect_unique` UNIQUE(`mode`,`provider_event_hash`)"
    );
    expect(migration).toContain(
      "IF v_wallet_status='active' THEN\n\t\tUPDATE `credit_wallets` SET `status`='frozen'"
    );
    expect(migration).toContain("'applied_review_required' AS `result`");
    expect(migration).not.toContain("SET `status`='active'");
  });
});
