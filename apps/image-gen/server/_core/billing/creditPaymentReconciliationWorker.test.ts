import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordPoll: vi.fn(),
  claimTenant: vi.fn(),
  assertLease: vi.fn(),
  releaseLease: vi.fn(),
  renewLease: vi.fn(),
  enqueueRecoveries: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("../logger", () => ({ safeLog: mocks.safeLog }));
vi.mock("./billingSchedulerStore", () => ({
  recordBillingSchedulerPoll: mocks.recordPoll,
  claimNextBillingTenant: mocks.claimTenant,
  assertBillingTenantLeaseOwned: mocks.assertLease,
  releaseBillingTenantLease: mocks.releaseLease,
  renewBillingTenantLease: mocks.renewLease,
}));
vi.mock("./creditPaymentRecovery", () => ({
  enqueueDueCustomerlessCreditPaymentRecoveries: mocks.enqueueRecoveries,
}));

import {
  runCreditPaymentReconciliationSchedulerOnce,
  runCreditPaymentReconciliationSchedulerSafely,
} from "./creditPaymentReconciliationWorker";

const LEASE = {
  workspaceId: 42,
  mode: "test",
  kind: "reconciliation",
  leaseToken: "lease-token",
  executionEpoch: 7,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOLLIE_MODE = "test";
  mocks.recordPoll.mockResolvedValue(1);
  mocks.claimTenant.mockResolvedValueOnce(LEASE).mockResolvedValueOnce(null);
  mocks.assertLease.mockResolvedValue(undefined);
  mocks.releaseLease.mockResolvedValue(true);
  mocks.renewLease.mockResolvedValue(true);
  mocks.enqueueRecoveries.mockResolvedValue(2);
});

describe("credit payment reconciliation worker", () => {
  it("records the required heartbeat and enqueues due one-off credit recovery", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");

    await expect(
      runCreditPaymentReconciliationSchedulerOnce(25, now)
    ).resolves.toBe(2);

    expect(mocks.recordPoll).toHaveBeenCalledExactlyOnceWith(
      "test",
      "reconciliation",
      now
    );
    expect(mocks.claimTenant).toHaveBeenNthCalledWith(
      1,
      "test",
      now,
      "reconciliation"
    );
    expect(mocks.enqueueRecoveries).toHaveBeenCalledExactlyOnceWith(
      42,
      "test",
      now,
      LEASE
    );
    expect(mocks.assertLease).toHaveBeenCalledTimes(2);
    expect(mocks.releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        ...LEASE,
        failed: false,
        now: expect.any(Date),
        nextAt: expect.any(Date),
      })
    );
  });

  it("backs off a failed tenant lease and logs no private error detail", async () => {
    mocks.enqueueRecoveries.mockRejectedValueOnce(
      new Error("private database host must stay redacted")
    );

    await expect(runCreditPaymentReconciliationSchedulerOnce()).resolves.toBe(
      0
    );

    expect(mocks.releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({ ...LEASE, failed: true })
    );
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "credit_payment_reconciliation_tenant_failed",
      { level: "error", errorCode: "Error" }
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "private database host"
    );
  });

  it("keeps dispatcher failures redacted so the timer cannot reject globally", async () => {
    mocks.recordPoll.mockRejectedValueOnce(
      new Error("private scheduler detail must stay redacted")
    );

    await expect(
      runCreditPaymentReconciliationSchedulerSafely()
    ).resolves.toBeUndefined();

    expect(mocks.safeLog).toHaveBeenCalledWith(
      "credit_payment_reconciliation_dispatch_failed",
      { level: "error", errorCode: "Error" }
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "private scheduler detail"
    );
  });
});
