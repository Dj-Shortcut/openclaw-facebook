import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enable: vi.fn(), close: vi.fn() }));
vi.mock("../_core/billing/testPaymentOperator", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../_core/billing/testPaymentOperator")
  >()),
  enableTestPayments: mocks.enable,
}));
vi.mock("../db", () => ({
  closeDatabasePool: mocks.close,
  getDatabaseOrThrow: vi.fn(),
}));

import { TestPaymentOperatorError } from "../_core/billing/testPaymentOperator";
import { runEnableTestPaymentsCli } from "./enableTestPayments";

const exitCode = process.exitCode;
describe("Test payment operator CLI", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    mocks.enable.mockResolvedValue({
      event: "test_payment_operator_completed",
      committed: true,
    });
    mocks.close.mockResolvedValue(undefined);
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = exitCode;
  });

  it("does not activate on import, and closes after explicit success", async () => {
    expect(mocks.enable).not.toHaveBeenCalled();
    await runEnableTestPaymentsCli();
    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify({ event: "test_payment_operator_completed", committed: true })}\n`
    );
    expect(process.stderr.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("closes after a refusal without exposing error details", async () => {
    mocks.enable.mockRejectedValue(
      new TestPaymentOperatorError("owner", "not_started")
    );
    await runEnableTestPaymentsCli();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      `${JSON.stringify({ event: "test_payment_operator_failed", failedStage: "owner", outcome: "not_started", committed: false })}\n`
    );
    expect(process.exitCode).toBe(1);
  });

  it("does not claim an unknown exception proves rollback", async () => {
    mocks.enable.mockRejectedValue(new Error("private connection string"));
    await runEnableTestPaymentsCli();
    expect(process.stderr.write).toHaveBeenCalledWith(
      `${JSON.stringify({ event: "test_payment_operator_failed", failedStage: "activation", outcome: "unknown", committed: false })}\n`
    );
    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not hide a confirmed commit when pool cleanup fails", async () => {
    mocks.close.mockRejectedValue(new Error("private database host"));
    await runEnableTestPaymentsCli();
    expect(process.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining('"committed":true')
    );
    expect(process.stderr.write).toHaveBeenCalledWith(
      `${JSON.stringify({ event: "test_payment_operator_cleanup_failed", committed: true })}\n`
    );
    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("reports committed but unverified state when post-commit readback fails", async () => {
    mocks.enable.mockRejectedValue(
      new TestPaymentOperatorError("readback", "unknown", true)
    );
    await runEnableTestPaymentsCli();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      `${JSON.stringify({ event: "test_payment_operator_failed", failedStage: "readback", outcome: "unknown", committed: true })}\n`
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
