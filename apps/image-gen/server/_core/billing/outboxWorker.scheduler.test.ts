import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordPoll: vi.fn(),
  claimTenant: vi.fn(),
  assertLease: vi.fn(),
  releaseLease: vi.fn(),
  renewLease: vi.fn(),
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

import { runBillingOutboxSchedulerSafely } from "./outboxWorker";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOLLIE_MODE = "test";
  mocks.recordPoll.mockResolvedValue(1);
  mocks.claimTenant.mockResolvedValue(null);
  mocks.assertLease.mockResolvedValue(undefined);
  mocks.releaseLease.mockResolvedValue(true);
  mocks.renewLease.mockResolvedValue(true);
});

describe("billing outbox scheduler diagnostics", () => {
  it.each([
    ["record_poll", "record", mocks.recordPoll],
    ["claim_tenant", "claim", mocks.claimTenant],
  ] as const)(
    "logs the finite %s stage without error details when %s fails",
    async (stageCode, _label, failingOperation) => {
      failingOperation.mockRejectedValueOnce(
        new Error("private database detail must not be logged")
      );

      await expect(runBillingOutboxSchedulerSafely()).resolves.toBeUndefined();

      expect(mocks.safeLog).toHaveBeenCalledWith(
        "billing_outbox_dispatch_failed",
        {
          level: "error",
          stageCode,
          errorCode: "Error",
        }
      );
      expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
        "private database detail"
      );
    }
  );

  it("logs a tenant-work stage and continues releasing the failed lease", async () => {
    const lease = {
      workspaceId: 17,
      mode: "test",
      kind: "outbox",
      leaseToken: "lease-token",
      executionEpoch: 3,
    } as const;
    mocks.claimTenant.mockResolvedValueOnce(lease).mockResolvedValue(null);
    mocks.assertLease.mockRejectedValueOnce(
      new Error("private tenant failure must not be logged")
    );

    await expect(runBillingOutboxSchedulerSafely()).resolves.toBeUndefined();

    expect(mocks.safeLog).toHaveBeenCalledWith(
      "billing_outbox_tenant_dispatch_failed",
      {
        level: "error",
        stageCode: "assert_lease_before",
        errorCode: "Error",
      }
    );
    expect(mocks.releaseLease).toHaveBeenCalledWith(
      expect.objectContaining({
        ...lease,
        failed: true,
      })
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "private tenant failure"
    );
  });
});
