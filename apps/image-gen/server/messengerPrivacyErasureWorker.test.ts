import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDue: vi.fn(),
  process: vi.fn(),
  ensureReadable: vi.fn(),
  assertEncryptionConfig: vi.fn(),
  assertRetryStored: vi.fn(),
  recordPollSuccess: vi.fn(),
  recordPollFailure: vi.fn(),
  reschedule: vi.fn(),
  runArtifactCleanup: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("./_core/redis", () => ({
  isRedisEnabled: () => true,
}));

vi.mock("./_core/messengerPrivacyErasureQueue", () => ({
  assertMessengerPrivacyErasureRetryStored: mocks.assertRetryStored,
  assertMessengerPrivacyErasureEncryptionConfig: mocks.assertEncryptionConfig,
  claimDueMessengerPrivacyErasureJobs: mocks.claimDue,
  ensureMessengerPrivacyErasureQueueReadable: mocks.ensureReadable,
  recordMessengerPrivacyErasureWorkerPollFailure: mocks.recordPollFailure,
  recordMessengerPrivacyErasureWorkerPollSuccess: mocks.recordPollSuccess,
  rescheduleMessengerPrivacyErasureJob: mocks.reschedule,
}));

vi.mock("./_core/dataDeletionService", () => ({
  processClaimedMessengerPrivacyErasureJob: mocks.process,
}));

vi.mock("./_core/messengerGenerationCompletion", () => ({
  runDueMessengerGenerationArtifactCleanup: mocks.runArtifactCleanup,
}));

vi.mock("./_core/logger", () => ({ safeLog: mocks.safeLog }));

import {
  runMessengerPrivacyErasureWorkerOnce,
  startMessengerPrivacyErasureWorker,
  stopMessengerPrivacyErasureWorkerForTests,
} from "./_core/messengerPrivacyErasureWorker";

describe("Messenger privacy erasure worker", () => {
  beforeEach(() => {
    stopMessengerPrivacyErasureWorkerForTests();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.runArtifactCleanup.mockResolvedValue(0);
  });

  it("reschedules an unexpected job failure and continues later work", async () => {
    const first = claim("a".repeat(64));
    const second = claim("b".repeat(64));
    mocks.claimDue.mockResolvedValue([first, second]);
    mocks.process
      .mockRejectedValueOnce(new TypeError("processor failed"))
      .mockResolvedValueOnce({ status: "completed" });
    mocks.reschedule.mockResolvedValue(undefined);

    await expect(runMessengerPrivacyErasureWorkerOnce()).resolves.toBe(2);

    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.reschedule).toHaveBeenCalledWith({
      claim: first,
      errorCode: "TypeError",
    });
    expect(mocks.process).toHaveBeenNthCalledWith(2, second);
    expect(mocks.recordPollSuccess).toHaveBeenCalledWith(2);
  });

  it("fails the poll and records a failure when claiming Redis work fails", async () => {
    const failure = new Error("claim store unavailable");
    mocks.claimDue.mockRejectedValue(failure);

    await expect(runMessengerPrivacyErasureWorkerOnce()).rejects.toBe(failure);

    expect(mocks.recordPollSuccess).not.toHaveBeenCalled();
    expect(mocks.recordPollFailure).toHaveBeenCalledWith(failure);
  });

  it("fails the poll when durable artifact cleanup cannot be drained", async () => {
    const failure = new Error("artifact cleanup store unavailable");
    mocks.runArtifactCleanup.mockRejectedValue(failure);

    await expect(runMessengerPrivacyErasureWorkerOnce()).rejects.toBe(failure);

    expect(mocks.claimDue).not.toHaveBeenCalled();
    expect(mocks.recordPollFailure).toHaveBeenCalledWith(failure);
  });

  it("does not report success when a pending retry was not durably stored", async () => {
    const pending = claim("c".repeat(64));
    mocks.claimDue.mockResolvedValue([pending]);
    mocks.process.mockResolvedValue({ status: "pending" });
    mocks.assertRetryStored.mockRejectedValue(
      new Error("retry was not durably stored")
    );

    await expect(runMessengerPrivacyErasureWorkerOnce()).rejects.toThrow(
      "retry was not durably stored"
    );

    expect(mocks.recordPollSuccess).not.toHaveBeenCalled();
    expect(mocks.recordPollFailure).toHaveBeenCalledOnce();
  });

  it("fails startup when the initial successful-poll heartbeat cannot be stored", async () => {
    mocks.ensureReadable.mockResolvedValue(undefined);
    mocks.claimDue.mockResolvedValue([]);
    mocks.recordPollSuccess.mockRejectedValue(
      new Error("heartbeat store unavailable")
    );
    mocks.recordPollFailure.mockResolvedValue(undefined);

    await expect(startMessengerPrivacyErasureWorker()).rejects.toThrow(
      "heartbeat store unavailable"
    );

    expect(mocks.claimDue).toHaveBeenCalledOnce();
  });

  it("fails startup before polling when a pending envelope cannot be decrypted", async () => {
    mocks.ensureReadable.mockRejectedValue(
      new Error("Messenger privacy erasure envelope key is unavailable")
    );

    await expect(startMessengerPrivacyErasureWorker()).rejects.toThrow(
      "envelope key is unavailable"
    );

    expect(mocks.assertEncryptionConfig).toHaveBeenCalledOnce();
    expect(mocks.claimDue).not.toHaveBeenCalled();
  });

  it("proves the durable envelope backlog readable before the first poll", async () => {
    mocks.ensureReadable.mockResolvedValue(undefined);
    mocks.claimDue.mockResolvedValue([]);

    await expect(startMessengerPrivacyErasureWorker()).resolves.toBeUndefined();
    expect(mocks.claimDue).toHaveBeenCalledOnce();
    expect(mocks.recordPollSuccess).toHaveBeenCalledWith(0);
    expect(mocks.ensureReadable.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimDue.mock.invocationCallOrder[0]!
    );
  });
});

function claim(jobId: string) {
  return {
    psid: "sealed-by-queue",
    leaseToken: `lease-${jobId.slice(0, 1)}`,
    job: {
      version: 1 as const,
      jobId,
      workspaceId: 41,
      channelConnectionId: 9,
      pageId: "page-worker",
      bindingEpoch: 3,
      userKey: "privacy_user_key_worker_123456",
      oldPrivacyEpoch: 7,
      sealedPsid: "sealed",
      erasureEpoch: null,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      nextAttemptAt: 1,
      lastErrorCode: null,
    },
  };
}
