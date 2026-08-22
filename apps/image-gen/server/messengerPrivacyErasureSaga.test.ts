import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  beginSubject: vi.fn(),
  completeSubject: vi.fn(),
  isComplete: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  setEpoch: vi.fn(),
  reschedule: vi.fn(),
  completeJob: vi.fn(),
  getConnected: vi.fn(),
  eraseIngress: vi.fn(),
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  beginMessengerPrivacyErasure: mocks.beginSubject,
  completeMessengerPrivacyErasure: mocks.completeSubject,
  isMessengerPrivacyErasureComplete: mocks.isComplete,
}));

vi.mock("./_core/messengerPrivacyErasureQueue", () => ({
  enqueueMessengerPrivacyErasureJob: mocks.enqueue,
  claimMessengerPrivacyErasureJob: mocks.claim,
  setMessengerPrivacyErasureEpoch: mocks.setEpoch,
  rescheduleMessengerPrivacyErasureJob: mocks.reschedule,
  completeMessengerPrivacyErasureJob: mocks.completeJob,
}));

vi.mock("./_core/meta/webhookIngressQueue", () => ({
  eraseWebhookIngressDeliveriesForSubject: mocks.eraseIngress,
}));

vi.mock("./_core/messengerGenerationQueue", () => ({
  eraseMessengerGenerationJobsForSubject: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  containMessengerProviderAttemptsForPrivacy: vi.fn(async () => true),
}));

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getConnectedFacebookPageConnection: mocks.getConnected,
    eraseBillingHandoffIdentity: vi.fn(async () => 0),
  };
});

import {
  deleteUserData,
  processClaimedMessengerPrivacyErasureJob,
} from "./_core/dataDeletionService";
import {
  getOrCreateState,
  getState,
  resetStateStore,
  setLastGenerationContext,
} from "./_core/messengerState";
import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";
import {
  appendCostLedgerEntry,
  readCostLedgerPeriod,
  type CostLedgerScope,
} from "./_core/costLedger";

describe("Messenger privacy erasure durable saga", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "privacy-erasure-saga-test-pepper";
    resetStateStore();
    mocks.events.length = 0;
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    mocks.beginSubject.mockImplementation(async () => {
      mocks.events.push("begin-subject");
      return 7;
    });
    mocks.isComplete.mockResolvedValue(false);
    mocks.enqueue.mockImplementation(async () => {
      mocks.events.push("enqueue-job");
      return "a".repeat(64);
    });
    mocks.setEpoch.mockImplementation(async ({ claim, erasureEpoch }) => {
      mocks.events.push("persist-erasure-epoch");
      claim.job.erasureEpoch = erasureEpoch;
      return claim.job;
    });
    mocks.reschedule.mockImplementation(async () => {
      mocks.events.push("reschedule-job");
    });
    mocks.completeJob.mockImplementation(async () => {
      mocks.events.push("complete-job");
    });
    mocks.getConnected.mockResolvedValue(null);
    mocks.eraseIngress.mockResolvedValue(undefined);
  });

  it("enqueues before erasing and completes DB before state and job removal", async () => {
    const psid = "privacy-erasure-saga-user";
    const userKey = toUserKey(psid);
    const claim = makeClaim(psid, userKey);
    mocks.claim.mockResolvedValue(claim);
    mocks.completeSubject.mockImplementation(async () => {
      mocks.events.push("complete-subject");
      expect(await Promise.resolve(getState(psid))).not.toBeNull();
    });

    const outcome = await withFence(psid, async () => {
      await Promise.resolve(getOrCreateState(psid));
      return await deleteUserData(psid, {
        onDurablyAccepted: async () => {
          mocks.events.push("accepted-reply");
        },
      });
    });

    expect(outcome).toEqual({ status: "completed" });
    expect(mocks.events).toEqual([
      "enqueue-job",
      "accepted-reply",
      "begin-subject",
      "persist-erasure-epoch",
      "complete-subject",
      "complete-job",
    ]);
    await expect(
      withFence(psid, () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();
  });

  it("bootstraps an absent-state durable job from its immutable scope", async () => {
    const psid = "privacy-erasure-missing-state";
    const userKey = toUserKey(psid);
    const claim = makeClaim(psid, userKey);
    mocks.claim.mockResolvedValue(claim);

    await expect(withFence(psid, () => deleteUserData(psid))).resolves.toEqual({
      status: "completed",
    });
    expect(mocks.beginSubject).toHaveBeenCalledWith({
      workspaceId: claim.job.workspaceId,
      channelConnectionId: claim.job.channelConnectionId,
      userKey,
    });
    expect(mocks.setEpoch).toHaveBeenCalledWith({
      claim,
      erasureEpoch: 7,
    });
    expect(mocks.completeSubject).toHaveBeenCalledWith({
      workspaceId: claim.job.workspaceId,
      channelConnectionId: claim.job.channelConnectionId,
      userKey,
      privacyEpoch: 7,
    });
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("restarts an absent-state erasure after a crash-safe failed step", async () => {
    const psid = "privacy-erasure-missing-state-restart";
    const userKey = toUserKey(psid);
    const claim = makeClaim(psid, userKey);
    mocks.eraseIngress.mockRejectedValueOnce(new Error("worker interrupted"));

    await expect(
      processClaimedMessengerPrivacyErasureJob(claim)
    ).resolves.toEqual({ status: "pending" });
    expect(claim.job.erasureEpoch).toBe(7);
    expect(mocks.reschedule).toHaveBeenCalledTimes(1);
    expect(mocks.completeJob).not.toHaveBeenCalled();

    const restartedClaim = makeClaim(psid, userKey, claim.job.erasureEpoch);
    await expect(
      processClaimedMessengerPrivacyErasureJob(restartedClaim)
    ).resolves.toEqual({
      status: "completed",
    });
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched privacy subject before durable work is enqueued", async () => {
    const psid = "privacy-erasure-mismatched-subject";
    await runWithMessengerRequestContext(
      "page-erasure-saga",
      async () => {
        setMessengerRequestPrivacySubject({
          userKey: toUserKey("different-sender"),
          privacyEpoch: 7,
        });
        await expect(deleteUserData(psid)).resolves.toEqual({
          status: "failed",
        });
      },
      { workspaceId: 41, channelConnectionId: 9, bindingEpoch: 3 }
    );

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.beginSubject).not.toHaveBeenCalled();
  });

  it("finishes an exact queued erasure after the Page was disconnected", async () => {
    const psid = "privacy-erasure-disconnected-page";
    const userKey = toUserKey(psid);
    await withFence(psid, async () => {
      await Promise.resolve(getOrCreateState(psid));
    });

    const outcome = await processClaimedMessengerPrivacyErasureJob(
      makeClaim(psid, userKey)
    );

    expect(outcome).toEqual({ status: "completed" });
    expect(mocks.getConnected).not.toHaveBeenCalled();
    expect(mocks.completeJob).toHaveBeenCalledTimes(1);
  });

  it("deletes only the exact WhatsApp tenant state and ledger subject", async () => {
    const senderId = "32470000123";
    const userKey = toUserKey(senderId);
    const scopeA = {
      pageId: "404040404040404",
      workspaceId: 41,
      channelConnectionId: 9,
      bindingEpoch: 3,
      privacyEpoch: 7,
    };
    const scopeB = {
      pageId: "505050505050505",
      workspaceId: 52,
      channelConnectionId: 11,
      bindingEpoch: 4,
      privacyEpoch: 7,
    };
    const ledgerScopeA: CostLedgerScope = {
      workspaceId: scopeA.workspaceId,
      channelConnectionId: scopeA.channelConnectionId,
      bindingEpoch: scopeA.bindingEpoch,
      privacyEpoch: scopeA.privacyEpoch,
    };
    const ledgerScopeB: CostLedgerScope = {
      workspaceId: scopeB.workspaceId,
      channelConnectionId: scopeB.channelConnectionId,
      bindingEpoch: scopeB.bindingEpoch,
      privacyEpoch: scopeB.privacyEpoch,
    };
    const recordedAt = new Date();
    const period = recordedAt.toISOString().slice(0, 10);

    await withExactFence(senderId, scopeA, async () => {
      await Promise.resolve(getOrCreateState(senderId));
      await Promise.resolve(
        setLastGenerationContext(senderId, { prompt: "tenant A prompt" })
      );
    });
    await withExactFence(senderId, scopeB, async () => {
      await Promise.resolve(getOrCreateState(senderId));
      await Promise.resolve(
        setLastGenerationContext(senderId, { prompt: "tenant B prompt" })
      );
    });
    await appendCostLedgerEntry(
      costEntry(ledgerScopeA, userKey, "wa-a-attempt"),
      recordedAt
    );
    await appendCostLedgerEntry(
      costEntry(ledgerScopeB, userKey, "wa-b-attempt"),
      recordedAt
    );

    const claim = makeClaim(senderId, userKey, null, scopeA);
    mocks.claim.mockResolvedValue(claim);
    await expect(
      withExactFence(senderId, scopeA, () => deleteUserData(senderId))
    ).resolves.toEqual({ status: "completed" });

    await expect(
      withExactFence(senderId, scopeA, () =>
        Promise.resolve(getState(senderId))
      )
    ).resolves.toBeNull();
    await expect(
      withExactFence(senderId, scopeB, () =>
        Promise.resolve(getState(senderId))
      )
    ).resolves.toMatchObject({ lastPrompt: "tenant B prompt" });
    await expect(readCostLedgerPeriod(ledgerScopeA, period)).resolves.toEqual(
      []
    );
    await expect(readCostLedgerPeriod(ledgerScopeB, period)).resolves.toEqual([
      expect.objectContaining({ id: "wa-b-attempt", userKey }),
    ]);
    expect(mocks.beginSubject).toHaveBeenCalledWith({
      workspaceId: scopeA.workspaceId,
      channelConnectionId: scopeA.channelConnectionId,
      userKey,
    });
    expect(mocks.beginSubject).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: scopeB.workspaceId })
    );
  });
});

function makeClaim(
  psid: string,
  userKey: string,
  erasureEpoch: number | null = null,
  scope: {
    pageId: string;
    workspaceId: number;
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
  } = {
    pageId: "page-erasure-saga",
    workspaceId: 41,
    channelConnectionId: 9,
    bindingEpoch: 3,
    privacyEpoch: 7,
  }
) {
  return {
    psid,
    leaseToken: "lease-token",
    job: {
      version: 1 as const,
      jobId: "a".repeat(64),
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      pageId: scope.pageId,
      bindingEpoch: scope.bindingEpoch,
      userKey,
      oldPrivacyEpoch: scope.privacyEpoch,
      sealedPsid: "sealed",
      erasureEpoch,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      nextAttemptAt: 1,
      lastErrorCode: null,
    },
  };
}

function costEntry(scope: CostLedgerScope, userKey: string, id: string) {
  return {
    scope,
    id,
    channel: "whatsapp",
    operation: "image_generation",
    provider: "openai-images",
    model: "gpt-image-2",
    userKey,
    reqId: id,
    status: "provider_attempt_started" as const,
    estimatedCostUsd: 0.025,
    estimatedOutputCostUsd: null,
    finalCostUsd: null,
    costEstimateComplete: true,
    estimateSource: "test",
    unpricedCostComponents: [],
  };
}

async function withExactFence<T>(
  psid: string,
  scope: {
    pageId: string;
    workspaceId: number;
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
  },
  action: () => Promise<T>
): Promise<T> {
  return await runWithMessengerRequestContext(
    scope.pageId,
    async () => {
      setMessengerRequestPrivacySubject({
        userKey: toUserKey(psid),
        privacyEpoch: scope.privacyEpoch,
      });
      return await action();
    },
    {
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      bindingEpoch: scope.bindingEpoch,
    }
  );
}

async function withFence<T>(
  psid: string,
  action: () => Promise<T>
): Promise<T> {
  return await runWithMessengerRequestContext(
    "page-erasure-saga",
    async () => {
      setMessengerRequestPrivacySubject({
        userKey: toUserKey(psid),
        privacyEpoch: 7,
      });
      return await action();
    },
    { workspaceId: 41, channelConnectionId: 9, bindingEpoch: 3 }
  );
}
