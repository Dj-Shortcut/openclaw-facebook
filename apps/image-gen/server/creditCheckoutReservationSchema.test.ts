import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sqlPath = path.resolve(
  process.cwd(),
  "drizzle/0018_credit_checkout_reservation.sql"
);
const snapshotPath = path.resolve(
  process.cwd(),
  "drizzle/meta/0018_snapshot.json"
);
const journalPath = path.resolve(process.cwd(), "drizzle/meta/_journal.json");

describe("0018 credit checkout reservation migration", () => {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map(value => value.trim())
    .filter(Boolean);

  it("adds the narrow reservation and pristine-checkout cleanup boundary", () => {
    expect(statements).toHaveLength(5);
    expect(statements[0]).toBe(
      "DROP PROCEDURE IF EXISTS `credit_create_wallet`;"
    );
    expect(statements[1]).toContain(
      "CREATE PROCEDURE `credit_reserve_checkout_intent`"
    );
    expect(statements[1]).toContain("SQL SECURITY DEFINER");
    expect(statements[1]).toContain("START TRANSACTION");
    expect(statements[1]).toContain("ROLLBACK; RESIGNAL");
    expect(statements[1]).toContain("'credit_purchase'");
    expect(statements[1]).toContain("'EUR','oneoff',JSON_OBJECT()");
    expect(statements[2]).toBe(
      "DROP PROCEDURE IF EXISTS `credit_expire_pristine_checkout`;"
    );
    expect(statements[3]).toContain(
      "CREATE PROCEDURE `credit_expire_pristine_checkout`"
    );
    expect(statements[3]).toContain("SQL SECURITY DEFINER");
    expect(statements[3]).toContain("START TRANSACTION");
    expect(statements[3]).toContain("ROLLBACK; RESIGNAL");
    expect(statements[4]).toBe(
      "CREATE INDEX `billing_intents_credit_capability_expiry_idx` ON `billing_intents` (`kind`,`status`,`checkout_capability_expires_at`,`intent_id`);"
    );
    expect(sql).not.toContain("CREATE PROCEDURE `credit_create_wallet`");
  });

  it("locks authorization, binding, privacy, wallet and intent collisions in order", () => {
    const body = statements[1];
    const markers = [
      "FROM `billing_execution_controls`",
      "FROM `channelConnections`",
      "FROM `messenger_privacy_subjects`",
      "FROM `credit_wallets`",
      "FROM `billing_intents`",
    ];
    let cursor = -1;
    for (const marker of markers) {
      const next = body.indexOf(marker, cursor + 1);
      expect(next, marker).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(body).toContain("`commercial_enabled`=true");
    expect(body).toContain("`authorization_epoch`=p_authorization_epoch");
    expect(body).toContain("`status`='connected'");
    expect(body).toContain("`status`='active' FOR UPDATE");
    expect(body).toContain("'premium_images_8_medium_v1'");
    expect(body).toContain("p_expected_amount=4.99");
    expect(body).toContain("p_credit_count=8");
    expect(body).toContain("CONCAT('credit-payment:',p_intent_id)");
    expect(body).toContain("^credit-checkout:v1:[0-9a-f]{64}$");
    expect(body).toContain(
      "^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$"
    );
    expect(body).toContain("'already_applied'");
    expect(body).toContain(
      "credit checkout replay conflicts with immutable request"
    );
  });

  it("links the exact final schema snapshot and journal entry", () => {
    const previous = JSON.parse(
      fs.readFileSync(
        path.resolve(process.cwd(), "drizzle/meta/0017_snapshot.json"),
        "utf8"
      )
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.id).not.toBe(previous.id);
    const expectedTables = structuredClone(previous.tables);
    expectedTables.billing_intents.indexes.billing_intents_credit_capability_expiry_idx =
      {
        name: "billing_intents_credit_capability_expiry_idx",
        columns: [
          "kind",
          "status",
          "checkout_capability_expires_at",
          "intent_id",
        ],
        isUnique: false,
      };
    expect(snapshot.tables).toEqual(expectedTables);
    expect(snapshot.enums).toEqual(previous.enums);
    expect(snapshot.schemas).toEqual(previous.schemas);
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 18,
      tag: "0018_credit_checkout_reservation",
      breakpoints: true,
    });
  });
});
