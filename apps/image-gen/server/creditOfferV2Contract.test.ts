import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = process.cwd();
const migrationPath = path.resolve(appRoot, "drizzle/0019_credit_offer_v2.sql");
const snapshotPath = path.resolve(appRoot, "drizzle/meta/0019_snapshot.json");
const journalPath = path.resolve(appRoot, "drizzle/meta/_journal.json");
const manifestPath = path.resolve(appRoot, "drizzle/migration-manifest.json");

const currentCopyPaths = [
  "client/index.html",
  "client/src/pages/CreditCheckout.tsx",
  "client/src/pages/LandingPage.tsx",
  "client/src/pages/Legal.tsx",
  "server/_core/runtime/legalRoutes.ts",
  "server/_core/webhookGenerationJobs.ts",
  "../../docs/operations/meta-app-review.md",
].map(file => path.resolve(appRoot, file));

describe("0019 credit offer v2 contract", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map(value => value.trim())
    .filter(Boolean);

  it("replaces only the two offer-sensitive procedures", () => {
    expect(statements).toHaveLength(4);
    expect(statements[0]).toBe(
      "DROP PROCEDURE IF EXISTS `credit_reserve_checkout_intent`;"
    );
    expect(statements[1]).toContain(
      "CREATE PROCEDURE `credit_reserve_checkout_intent`"
    );
    expect(statements[2]).toBe(
      "DROP PROCEDURE IF EXISTS `credit_freeze_wallet_for_review`;"
    );
    expect(statements[3]).toContain(
      "CREATE PROCEDURE `credit_freeze_wallet_for_review`"
    );
    expect(sql).not.toMatch(/\b(?:ALTER|DROP)\s+TABLE\b/i);
  });

  it("keeps exact v1 replay and accepts only the exact v2 tuple", () => {
    const reserve = statements[1]!;
    expect(reserve).toContain("'premium_images_8_medium_v1'");
    expect(reserve).toContain("p_expected_amount=4.99");
    expect(reserve).toContain("p_credit_count=8");
    expect(reserve).toContain("'Leaderbot - 8 premium beeldcredits'");
    expect(reserve).toContain("'premium_images_9_medium_v2'");
    expect(reserve).toContain("p_expected_amount=5.00");
    expect(reserve).toContain("p_credit_count=9");
    expect(reserve).toContain("'Leaderbot - 9 premium beeldcredits'");
    expect(reserve).toContain("legacy credit offer is replay-only");
    expect(reserve).toContain(
      "credit checkout replay conflicts with immutable request"
    );
  });

  it("uses immutable intent evidence for refund review amounts", () => {
    const review = statements[3]!;
    expect(review).toContain("payment.`gross_amount`=intent.`expected_amount`");
    expect(review).toContain(
      "BINARY payment.`currency`=BINARY intent.`currency`"
    );
    expect(review).not.toContain("payment.`gross_amount`=4.99");
    expect(review).not.toContain("payment.`gross_amount`=5.00");
  });

  it("links the schema-identical snapshot, journal and manifest append-only", () => {
    const previous = JSON.parse(
      fs.readFileSync(
        path.resolve(appRoot, "drizzle/meta/0018_snapshot.json"),
        "utf8"
      )
    );
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.id).not.toBe(previous.id);
    expect(snapshot.tables).toEqual(previous.tables);
    expect(snapshot.enums).toEqual(previous.enums);
    expect(snapshot.schemas).toEqual(previous.schemas);
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 19,
      tag: "0019_credit_offer_v2",
      breakpoints: true,
    });
    expect(manifest.schemaSnapshot).toBe("meta/0019_snapshot.json");
    expect(manifest.migrations.at(-1)).toMatchObject({
      idx: 19,
      tag: "0019_credit_offer_v2",
    });
  });

  it.each(currentCopyPaths)(
    "keeps current user-facing copy on €5/9 while v1 remains historical in code: %s",
    file => {
      const body = fs.readFileSync(file, "utf8");
      expect(body).not.toMatch(/€\s?4[,.]99/);
      expect(body).not.toMatch(/\b8\s+premium(?:credits|\s+beeldcredits)/i);
      expect(body).not.toContain("+8");
    }
  );
});
