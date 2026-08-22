import { afterEach, describe, expect, it } from "vitest";

import {
  getMollieAccountingImportConfig,
  isMollieAccountingImportEnabled,
} from "./accountingWorker";

describe("accounting worker configuration", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("is disabled unless explicitly enabled", () => {
    delete process.env.MOLLIE_ACCOUNTING_IMPORT_ENABLED;
    expect(isMollieAccountingImportEnabled()).toBe(false);
  });

  it("requires a distinct read-only accounting token contract", () => {
    process.env.MOLLIE_ACCOUNTING_PROVIDER_ACCOUNT_ID =
      "org:leaderbot-accounting";
    process.env.MOLLIE_ACCOUNTING_ACCESS_TOKEN =
      "access_readonlyaccountingtoken123";
    process.env.MOLLIE_ACCOUNTING_BALANCE_ID = "bal_accounting123";
    process.env.MOLLIE_MODE = "test";
    expect(getMollieAccountingImportConfig()).toMatchObject({
      providerAccountId: "org:leaderbot-accounting",
      balanceId: "bal_accounting123",
      mode: "test",
    });
    process.env.MOLLIE_ACCOUNTING_ACCESS_TOKEN = "test_payment_key";
    expect(() => getMollieAccountingImportConfig()).toThrow(
      "MOLLIE_ACCOUNTING_ACCESS_TOKEN is invalid"
    );
  });
});
