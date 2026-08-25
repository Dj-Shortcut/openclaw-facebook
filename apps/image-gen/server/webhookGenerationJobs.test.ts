import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeGenerationFlowMock,
  finalizeMessengerProviderAttemptFenceMock,
  markMessengerProviderAttemptStartedMock,
  reserveMessengerProviderAttemptFenceMock,
  reserveStartpilotImageUsageMock,
  assertMessengerGenerationOwnershipMock,
  resolveWorkspaceRuntimePolicyMock,
  safeLogMock,
  sendButtonTemplateMock,
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
  faultInjection,
} = vi.hoisted(() => ({
  executeGenerationFlowMock: vi.fn(),
  finalizeMessengerProviderAttemptFenceMock: vi.fn(),
  markMessengerProviderAttemptStartedMock: vi.fn(),
  reserveMessengerProviderAttemptFenceMock: vi.fn(),
  reserveStartpilotImageUsageMock: vi.fn(),
  assertMessengerGenerationOwnershipMock: vi.fn(),
  resolveWorkspaceRuntimePolicyMock: vi.fn(),
  safeLogMock: vi.fn(),
  sendButtonTemplateMock: vi.fn(async () => ({ sent: true })),
  sendImageMock: vi.fn(async () => ({ sent: true })),
  sendQuickRepliesMock: vi.fn(async () => ({ sent: true })),
  sendTextMock: vi.fn(async () => ({ sent: true })),
  faultInjection: {
    quotaMarkerError: null as Error | null,
    setLastGeneratedError: null as Error | null,
  },
}));

vi.mock("./_core/generationFlow", () => ({
  executeGenerationFlow: executeGenerationFlowMock,
}));

vi.mock("./_core/billing/entitlementUsageStore", () => ({
  reserveStartpilotImageUsage: reserveStartpilotImageUsageMock,
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  finalizeMessengerProviderAttemptFence:
    finalizeMessengerProviderAttemptFenceMock,
  markMessengerProviderAttemptStarted: markMessengerProviderAttemptStartedMock,
  reserveMessengerProviderAttemptFence:
    reserveMessengerProviderAttemptFenceMock,
}));

vi.mock("./_core/messengerGenerationCompletion", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/messengerGenerationCompletion")
    >();
  return {
    ...actual,
    markMessengerGenerationQuotaCommitted: async (
      ...args: Parameters<typeof actual.markMessengerGenerationQuotaCommitted>
    ) => {
      const error = faultInjection.quotaMarkerError;
      if (error) {
        faultInjection.quotaMarkerError = null;
        throw error;
      }
      return await actual.markMessengerGenerationQuotaCommitted(...args);
    },
  };
});

vi.mock("./_core/messengerState", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerState")>();
  return {
    ...actual,
    setLastGenerated: (...args: Parameters<typeof actual.setLastGenerated>) => {
      const error = faultInjection.setLastGeneratedError;
      if (error) {
        faultInjection.setLastGeneratedError = null;
        throw error;
      }
      return actual.setLastGenerated(...args);
    },
  };
});

vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: assertMessengerGenerationOwnershipMock,
  resolveWorkspaceRuntimePolicy: resolveWorkspaceRuntimePolicyMock,
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
  sendButtonTemplate: sendButtonTemplateMock,
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
}));

vi.mock("./_core/logger", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/logger")>();
  return { ...actual, safeLog: safeLogMock };
});

import { createHandlerContext } from "./_core/webhookHandlerContext";
import { createMessengerGenerationJobRunner } from "./_core/webhookGenerationJobs";
import * as messengerGenerationQueue from "./_core/messengerGenerationQueue";
import {
  getState,
  resetStateStore,
  setFlowState,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import {
  deleteEphemeralKey,
  setEphemeralKey,
  writeScopedState,
} from "./_core/stateStore";
import { t } from "./_core/i18n";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDeliveryStarted,
  markMessengerGenerationQuotaCommitted,
} from "./_core/messengerGenerationCompletion";
import {
  commitMessengerImageQuotaSuccess,
  getMessengerImageQuotaStatus,
  reserveMessengerImageQuota,
  type MessengerImageQuotaIdentity,
} from "./_core/messengerImageQuotaStore";
import { getUserKey } from "./_core/messengerStateNormalization";
import {
  getTodayRuntimeStats,
  resetRuntimeStatsForTests,
} from "./_core/botRuntimeStats";
import type { MessengerSendOutcome } from "./_core/messengerApi";
import type { HandlerContext } from "./_core/webhookHandlerTypes";

const IN_FLIGHT_NOTICE = "Even geduld, ik ben nog bezig met je afbeelding.";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const originalFreeDailyLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;
const originalFreeMonthlyLimit = process.env.MESSENGER_FREE_MONTHLY_LIMIT;
const originalQuotaTimeZone = process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE;
const originalQuotaBypassIds = process.env.MESSENGER_QUOTA_BYPASS_IDS;
const originalMessengerAdminIds = process.env.MESSENGER_ADMIN_IDS;

afterAll(() => {
  if (originalPrivacyPepper === undefined) {
    delete process.env.PRIVACY_PEPPER;
  } else {
    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  }
  if (originalFreeDailyLimit === undefined) {
    delete process.env.MESSENGER_FREE_DAILY_LIMIT;
  } else {
    process.env.MESSENGER_FREE_DAILY_LIMIT = originalFreeDailyLimit;
  }
  if (originalFreeMonthlyLimit === undefined) {
    delete process.env.MESSENGER_FREE_MONTHLY_LIMIT;
  } else {
    process.env.MESSENGER_FREE_MONTHLY_LIMIT = originalFreeMonthlyLimit;
  }
  if (originalQuotaTimeZone === undefined) {
    delete process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE;
  } else {
    process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = originalQuotaTimeZone;
  }
  if (originalQuotaBypassIds === undefined) {
    delete process.env.MESSENGER_QUOTA_BYPASS_IDS;
  } else {
    process.env.MESSENGER_QUOTA_BYPASS_IDS = originalQuotaBypassIds;
  }
  if (originalMessengerAdminIds === undefined) {
    delete process.env.MESSENGER_ADMIN_IDS;
  } else {
    process.env.MESSENGER_ADMIN_IDS = originalMessengerAdminIds;
  }
});

beforeEach(() => {
  process.env.PRIVACY_PEPPER = "webhook-generation-jobs-test-pepper";
  executeGenerationFlowMock.mockReset();
  finalizeMessengerProviderAttemptFenceMock.mockReset();
  finalizeMessengerProviderAttemptFenceMock.mockResolvedValue(undefined);
  markMessengerProviderAttemptStartedMock.mockReset();
  markMessengerProviderAttemptStartedMock.mockResolvedValue(undefined);
  reserveMessengerProviderAttemptFenceMock.mockReset();
  reserveMessengerProviderAttemptFenceMock.mockResolvedValue({
    leaseToken: "provider-fence-lease",
    attemptKeyHash: "provider-fence-attempt",
  });
  reserveStartpilotImageUsageMock.mockReset();
  reserveStartpilotImageUsageMock.mockResolvedValue({
    allowed: true,
    imagesUsed: 1,
    imagesUsedToday: 1,
    alreadyReserved: false,
  });
  assertMessengerGenerationOwnershipMock.mockReset();
  assertMessengerGenerationOwnershipMock.mockResolvedValue(undefined);
  resolveWorkspaceRuntimePolicyMock.mockReset();
  resolveWorkspaceRuntimePolicyMock.mockResolvedValue({ kind: "free" });
  safeLogMock.mockReset();
  sendButtonTemplateMock.mockReset();
  sendButtonTemplateMock.mockResolvedValue({ sent: true });
  sendImageMock.mockReset();
  sendImageMock.mockResolvedValue({ sent: true });
  sendQuickRepliesMock.mockReset();
  sendQuickRepliesMock.mockResolvedValue({ sent: true });
  sendTextMock.mockReset();
  sendTextMock.mockResolvedValue({ sent: true });
  faultInjection.quotaMarkerError = null;
  faultInjection.setLastGeneratedError = null;
  resetStateStore();
  resetRuntimeStatsForTests();
  process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = "Europe/Brussels";
  delete process.env.MESSENGER_FREE_DAILY_LIMIT;
  delete process.env.MESSENGER_FREE_MONTHLY_LIMIT;
  delete process.env.MESSENGER_QUOTA_BYPASS_IDS;
  delete process.env.MESSENGER_ADMIN_IDS;
});

describe("messenger generation job safety", () => {
  it("fails closed before provider start when a queued Page is rebound", async () => {
    const runner = createTestRunner();
    assertMessengerGenerationOwnershipMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ownership changed"));
    const providerTransport = vi.fn();
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      await input.onProviderAttempt();
      providerTransport();
      return successGenerationResult();
    });

    await runner.processMessengerGenerationJob({
      psid: "rebound-user",
      userId: "rebound-user-key",
      pageId: "rebound-page",
      workspaceId: 42,
      channelConnectionId: 7,
      reqId: "req-rebound",
      lang: "nl",
    });

    expect(assertMessengerGenerationOwnershipMock).toHaveBeenCalledTimes(2);
    expect(executeGenerationFlowMock).toHaveBeenCalledOnce();
    expect(providerTransport).not.toHaveBeenCalled();
    expect(getState("rebound-user")?.stage).not.toBe("PROCESSING");
  });

  it("does not commit or deliver when the binding changes after reservation", async () => {
    const psid = "stale-binding-after-reservation-user";
    const userId = "stale-binding-after-reservation-user-key";
    const reqId = "req-stale-binding-after-reservation";
    assertMessengerGenerationOwnershipMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("binding changed before quota commit"));
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      await input.onProviderAttempt();
      return successGenerationResult();
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      pageId: "stale-binding-page",
      reqId,
      lang: "nl",
    });

    expect(assertMessengerGenerationOwnershipMock).toHaveBeenCalledTimes(4);
    expect(sendImageMock).not.toHaveBeenCalled();
    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "pending",
      successNoticeStatus: "pending",
    });
  });

  it("dead-letters only the owning Page state and sends the localized failure", async () => {
    const psid = "shared-dead-letter-user";
    const owningPageId = "dead-letter-owning-page";
    const otherPageId = "dead-letter-other-page";
    const reqId = "req-dead-letter-page-scope";
    const sendLoggedText = vi.fn(
      async (_psid: string, _text: string, _reqId: string) =>
        ({ sent: true }) satisfies MessengerSendOutcome
    );
    const runner = createTestRunner({ sendLoggedText });

    await runWithMessengerRequestContext(otherPageId, async () => {
      await setFlowState(psid, "PROCESSING");
    });

    await runner.processMessengerGenerationJobDeadLetter({
      psid,
      userId: "shared-dead-letter-user-key",
      pageId: owningPageId,
      reqId,
      lang: "en",
    });

    const owningPageState = await runWithMessengerRequestContext(
      owningPageId,
      async () => await Promise.resolve(getState(psid))
    );
    const otherPageState = await runWithMessengerRequestContext(
      otherPageId,
      async () => await Promise.resolve(getState(psid))
    );

    expect(owningPageState?.stage).toBe("FAILURE");
    expect(otherPageState?.stage).toBe("PROCESSING");
    expect(sendLoggedText).toHaveBeenCalledWith(
      psid,
      t("en", "generationGenericFailure"),
      reqId
    );
  });

  it("recovers when executeGenerationFlow throws without leaving PROCESSING", async () => {
    const runner = createTestRunner();
    executeGenerationFlowMock.mockRejectedValueOnce(
      new Error("provider blew up")
    );

    await runner.processMessengerGenerationJob({
      psid: "throwing-flow-user",
      userId: "throwing-flow-user-key",
      reqId: "req-throwing-flow",
      lang: "nl",
    });

    expect(getState("throwing-flow-user")?.stage).toBe("FAILURE");
    expect(getState("throwing-flow-user")?.quota.count).toBe(0);
    expect(getState("throwing-flow-user")?.stage).not.toBe("PROCESSING");
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_unexpected_error",
      expect.objectContaining({
        reqId: "req-throwing-flow",
        generationKind: "text_to_image",
      })
    );
    expect(sendQuickRepliesMock).toHaveBeenCalled();
  });

  it("recovers inline state when image delivery fails after generation completed", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_771_001_000_000);
    const psid = "success-throw-clears-notice-user";
    const reqId = "req-success-throw-clears-notice";
    const { ctx, runner } = createContextBackedRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    sendImageMock.mockRejectedValueOnce(
      new Error("messenger image send failed")
    );

    try {
      await seedInFlightNotice(ctx, psid);
      await runner.processMessengerGenerationJob({
        psid,
        userId: `${psid}-key`,
        reqId,
        lang: "nl",
      });

      await expect(
        Promise.resolve(getMessengerGenerationCompletion(reqId))
      ).resolves.toEqual(
        expect.objectContaining({
          reqId,
          imageUrl: "https://img.example/generated.png",
          deliveryStatus: "pending",
          quotaStatus: {
            daily: { used: 1, limit: 5, remaining: 4 },
            monthly: { used: 1, limit: 20, remaining: 19 },
          },
          successNoticeStatus: "pending",
          userKey: `${psid}-key`,
        })
      );
      await expect(
        Promise.resolve(getMessengerGenerationCompletion(reqId))
      ).resolves.not.toHaveProperty("deliveredAt");
      expect(getState(psid)?.stage).toBe("IDLE");
      expect(getState(psid)?.quota.count).toBe(0);
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(`${psid}-key`))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      expect(safeLogMock).toHaveBeenCalledWith(
        "messenger_generation_image_delivery_failed",
        expect.objectContaining({
          reqId,
          generationKind: "text_to_image",
          queueEnabled: false,
        })
      );
      expect(getTodayRuntimeStats().deliveryFailureCountToday).toBe(1);
      expect(getTodayRuntimeStats().duplicateSkipCountToday).toBe(0);

      await runner.processMessengerGenerationJob({
        psid,
        userId: `${psid}-key`,
        reqId,
        lang: "nl",
      });
      expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
      expect(sendImageMock).toHaveBeenCalledTimes(2);
      expect(getTodayRuntimeStats().deliveryFailureCountToday).toBe(1);
      expect(getTodayRuntimeStats().duplicateSkipCountToday).toBe(1);
      expect(getState(psid)?.quota.count).toBe(0);
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(`${psid}-key`))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      await expect(
        Promise.resolve(getMessengerGenerationCompletion(reqId))
      ).resolves.toEqual(
        expect.objectContaining({
          reqId,
          imageUrl: "https://img.example/generated.png",
          deliveryStatus: "delivered",
          successNoticeStatus: "sent",
          userKey: `${psid}-key`,
          deliveredAt: 1_771_001_000_000,
        })
      );

      sendTextMock.mockClear();
      await setEphemeralKey(`messenger:inflight:${psid}`, "active-again", 60);
      await ctx.maybeSendInFlightMessage(psid, "req-after-success-throw", "nl");

      expect(sendTextMock).toHaveBeenCalledWith(psid, IN_FLIGHT_NOTICE);
    } finally {
      nowSpy.mockRestore();
      await deleteEphemeralKey(`messenger:inflight:${psid}`);
    }
  });

  it("retries only the balance notice after the image was already delivered", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_771_001_050_000);
    const psid = "balance-notice-retry-user";
    const userId = "balance-notice-retry-user-key";
    const reqId = "req-balance-notice-retry";
    const providerAttemptKeys: Array<string | undefined> = [];
    const runner = createTestRunner({
      sendLoggedActions: async (
        recipient,
        text,
        actions,
        _requestId,
        deliveryControl
      ) => {
        providerAttemptKeys.push(deliveryControl?.providerAttemptKey);
        return await sendQuickRepliesMock(recipient, text, actions);
      },
    });
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    sendQuickRepliesMock.mockRejectedValueOnce(
      new Error("messenger balance notice failed")
    );

    try {
      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });

      const pendingNotice = await getMessengerGenerationCompletion(reqId);
      expect(pendingNotice).toEqual(
        expect.objectContaining({
          deliveryStatus: "delivered",
          successNoticeStatus: "pending",
          quotaStatus: {
            daily: { used: 1, limit: 5, remaining: 4 },
            monthly: { used: 1, limit: 20, remaining: 19 },
          },
        })
      );
      expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      expect(getState(psid)?.quota.count).toBe(0);

      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });

      expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      expect(sendQuickRepliesMock).toHaveBeenCalledTimes(2);
      expect(providerAttemptKeys).toEqual([
        "generation-success-notice-v1",
        "generation-success-notice-v1",
      ]);
      expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
        psid,
        "Klaar.\nVandaag nog 4 van 5 foto's. Deze maand nog 19 van 20.",
        expect.any(Array)
      );
      expect(getState(psid)?.quota.count).toBe(0);
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      await expect(getMessengerGenerationCompletion(reqId)).resolves.toEqual(
        expect.objectContaining({
          deliveryStatus: "delivered",
          successNoticeStatus: "sent",
          successNoticeSentAt: 1_771_001_050_000,
          quotaCommittedAt: pendingNotice?.quotaCommittedAt,
        })
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("refreshes a pending balance at Brussels midnight before retrying it", async () => {
    const beforeMidnight = new Date("2026-08-17T21:59:00.000Z").getTime();
    const afterMidnight = new Date("2026-08-17T22:01:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(beforeMidnight);
    const psid = "balance-midnight-user";
    const userId = "balance-midnight-user-key";
    const reqId = "req-balance-midnight";
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    sendQuickRepliesMock.mockRejectedValueOnce(
      new Error("messenger balance notice failed before midnight")
    );

    try {
      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });
      const pendingNotice = await getMessengerGenerationCompletion(reqId);
      expect(pendingNotice).toMatchObject({
        successNoticeStatus: "pending",
        quotaStatus: {
          daily: { used: 1, remaining: 4 },
          monthly: { used: 1, remaining: 19 },
        },
      });

      nowSpy.mockReturnValue(afterMidnight);
      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });

      expect(sendImageMock).toHaveBeenCalledOnce();
      expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
        psid,
        "Klaar.\nVandaag nog 5 van 5 foto's. Deze maand nog 19 van 20.",
        expect.any(Array)
      );
      await expect(
        getMessengerGenerationCompletion(reqId)
      ).resolves.toMatchObject({
        successNoticeStatus: "sent",
        quotaCommittedAt: pendingNotice?.quotaCommittedAt,
        quotaStatus: {
          daily: { used: 0, remaining: 5 },
          monthly: { used: 1, remaining: 19 },
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("refreshes a pending balance after another successful photo", async () => {
    const psid = "balance-intervening-success-user";
    const userId = "balance-intervening-success-user-key";
    const firstReqId = "req-balance-before-intervening-success";
    const secondReqId = "req-balance-intervening-success";
    const runner = createTestRunner();
    executeGenerationFlowMock
      .mockResolvedValueOnce(
        successGenerationResult("https://img.example/balance-first.png")
      )
      .mockResolvedValueOnce(
        successGenerationResult("https://img.example/balance-second.png")
      );
    sendQuickRepliesMock.mockRejectedValueOnce(
      new Error("first Messenger balance notice failed")
    );

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId: firstReqId,
      lang: "nl",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId: secondReqId,
      lang: "nl",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId: firstReqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(2);
    expect(sendImageMock).toHaveBeenCalledTimes(2);
    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(3);
    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      psid,
      "Klaar.\nVandaag nog 3 van 5 foto's. Deze maand nog 18 van 20.",
      expect.any(Array)
    );
    await expect(
      getMessengerGenerationCompletion(firstReqId)
    ).resolves.toMatchObject({
      successNoticeStatus: "sent",
      quotaStatus: {
        daily: { used: 2, remaining: 3 },
        monthly: { used: 2, remaining: 18 },
      },
    });
  });

  it("treats sent:false as a failed balance notice and retries only that notice", async () => {
    const psid = "balance-notice-skipped-user";
    const userId = "balance-notice-skipped-user-key";
    const reqId = "req-balance-notice-skipped";
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    sendQuickRepliesMock
      .mockResolvedValueOnce({
        sent: false,
        reason: "response_window_closed",
      })
      .mockResolvedValueOnce({ sent: true });

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      successNoticeStatus: "pending",
    });
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_balance_notice_delivery_failed",
      expect.objectContaining({ reqId })
    );

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
    expect(sendImageMock).toHaveBeenCalledTimes(1);
    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(2);
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      successNoticeStatus: "sent",
    });
  });

  it("requeues after quota commit when the completion quota marker fails", async () => {
    const psid = "quota-marker-fault-user";
    const userId = "quota-marker-fault-user-key";
    const reqId = "req-quota-marker-fault";
    const queueEnabled = vi
      .spyOn(messengerGenerationQueue, "isMessengerGenerationQueueEnabled")
      .mockReturnValue(true);
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    faultInjection.quotaMarkerError = new Error(
      "completion quota marker unavailable"
    );

    try {
      await expect(
        runner.processMessengerGenerationJob({
          psid,
          userId,
          reqId,
          lang: "nl",
        })
      ).rejects.toThrow("completion quota marker unavailable");

      expect(sendImageMock).not.toHaveBeenCalled();
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      const pendingCompletion = await getMessengerGenerationCompletion(reqId);
      expect(pendingCompletion).toMatchObject({ deliveryStatus: "pending" });
      expect(pendingCompletion?.quotaStatus).toBeUndefined();

      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });

      expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      await expect(
        getMessengerGenerationCompletion(reqId)
      ).resolves.toMatchObject({
        deliveryStatus: "delivered",
        successNoticeStatus: "sent",
        quotaStatus: {
          daily: { used: 1, remaining: 4 },
          monthly: { used: 1, remaining: 19 },
        },
      });
    } finally {
      queueEnabled.mockRestore();
    }
  });

  it("requeues after the quota marker when state persistence fails", async () => {
    const psid = "post-marker-state-fault-user";
    const userId = "post-marker-state-fault-user-key";
    const reqId = "req-post-marker-state-fault";
    const queueEnabled = vi
      .spyOn(messengerGenerationQueue, "isMessengerGenerationQueueEnabled")
      .mockReturnValue(true);
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    faultInjection.setLastGeneratedError = new Error(
      "last generated state unavailable"
    );

    try {
      await expect(
        runner.processMessengerGenerationJob({
          psid,
          userId,
          reqId,
          lang: "nl",
        })
      ).rejects.toThrow("last generated state unavailable");

      expect(sendImageMock).not.toHaveBeenCalled();
      await expect(
        getMessengerGenerationCompletion(reqId)
      ).resolves.toMatchObject({
        deliveryStatus: "pending",
        quotaStatus: {
          daily: { used: 1, remaining: 4 },
          monthly: { used: 1, remaining: 19 },
        },
      });

      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });

      expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      await expect(
        getMessengerGenerationCompletion(reqId)
      ).resolves.toMatchObject({
        deliveryStatus: "delivered",
        successNoticeStatus: "sent",
      });
    } finally {
      queueEnabled.mockRestore();
    }
  });

  it("accounts a delivered legacy completion once without resending its old notice", async () => {
    const psid = "legacy-delivered-user";
    const userId = "legacy-delivered-user-key";
    const reqId = "req-legacy-delivered";
    await seedLegacyCompletion({
      reqId,
      userId,
      imageUrl: "https://img.example/legacy-delivered.png",
      deliveryStatus: "delivered",
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
    ).resolves.toEqual({
      daily: { used: 1, limit: 5, remaining: 4 },
      monthly: { used: 1, limit: 20, remaining: 19 },
    });
    await expect(getMessengerGenerationCompletion(reqId)).resolves.toEqual(
      expect.objectContaining({
        deliveryStatus: "delivered",
        successNoticeStatus: "sent",
        quotaStatus: {
          daily: { used: 1, limit: 5, remaining: 4 },
          monthly: { used: 1, limit: 20, remaining: 19 },
        },
      })
    );
  });

  it("reconciles an already-accounted request receipt into a legacy completion", async () => {
    const psid = "legacy-receipt-user";
    const userId = "legacy-receipt-user-key";
    const reqId = "req-legacy-existing-receipt";
    const identity = quotaIdentityForUser(userId);
    const decision = await reserveMessengerImageQuota(identity, reqId);
    expect(decision.status).toBe("reserved");
    if (decision.status !== "reserved") throw new Error("expected reservation");
    await commitMessengerImageQuotaSuccess(identity, decision.reservation);
    await seedLegacyCompletion({
      reqId,
      userId,
      imageUrl: "https://img.example/legacy-receipt.png",
      deliveryStatus: "delivered",
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    await expect(getMessengerImageQuotaStatus(identity)).resolves.toEqual({
      daily: { used: 1, limit: 5, remaining: 4 },
      monthly: { used: 1, limit: 20, remaining: 19 },
    });
    await expect(getMessengerGenerationCompletion(reqId)).resolves.toEqual(
      expect.objectContaining({
        successNoticeStatus: "sent",
        quotaStatus: {
          daily: { used: 1, limit: 5, remaining: 4 },
          monthly: { used: 1, limit: 20, remaining: 19 },
        },
      })
    );
    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "daily",
      dailyLimit: 1,
      monthlyLimit: 20,
      reason: "daily_exhausted",
      expectedText:
        "Klaar.\nVandaag nog 0 van 1 foto's. Deze maand nog 19 van 20.",
      expectedStatus: {
        daily: { used: 1, limit: 1, remaining: 0 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      },
    },
    {
      label: "monthly",
      dailyLimit: 5,
      monthlyLimit: 1,
      reason: "monthly_exhausted",
      expectedText:
        "Klaar.\nVandaag nog 4 van 5 foto's. Deze maand nog 0 van 1.",
      expectedStatus: {
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 1, remaining: 0 },
      },
    },
  ])(
    "grandfathers a pending legacy completion at the $label limit without exceeding it",
    async ({
      dailyLimit,
      monthlyLimit,
      reason,
      expectedText,
      expectedStatus,
    }) => {
      process.env.MESSENGER_FREE_DAILY_LIMIT = String(dailyLimit);
      process.env.MESSENGER_FREE_MONTHLY_LIMIT = String(monthlyLimit);
      const psid = `legacy-${reason}-user`;
      const userId = `legacy-${reason}-user-key`;
      const reqId = `req-legacy-${reason}`;
      const identity = quotaIdentityForUser(userId);
      const prior = await reserveMessengerImageQuota(identity, "prior-success");
      expect(prior.status).toBe("reserved");
      if (prior.status !== "reserved") throw new Error("expected reservation");
      await commitMessengerImageQuotaSuccess(identity, prior.reservation);
      await seedLegacyCompletion({
        reqId,
        userId,
        imageUrl: `https://img.example/${reason}.png`,
        deliveryStatus: "pending",
      });
      const runner = createTestRunner();

      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });

      expect(executeGenerationFlowMock).not.toHaveBeenCalled();
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
      expect(sendQuickRepliesMock).toHaveBeenCalledWith(
        psid,
        expectedText,
        expect.any(Array)
      );
      await expect(getMessengerImageQuotaStatus(identity)).resolves.toEqual(
        expectedStatus
      );
      expect(safeLogMock).toHaveBeenCalledWith(
        "messenger_generation_legacy_quota_grandfathered",
        expect.objectContaining({ reqId, reason })
      );
      await expect(getMessengerGenerationCompletion(reqId)).resolves.toEqual(
        expect.objectContaining({
          deliveryStatus: "delivered",
          successNoticeStatus: "sent",
          quotaStatus: expectedStatus,
        })
      );

      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });
      expect(sendImageMock).toHaveBeenCalledTimes(1);
      expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
      await expect(getMessengerImageQuotaStatus(identity)).resolves.toEqual(
        expectedStatus
      );
    }
  );

  it("never grandfathers a new crash-recovery completion past the hard limit", async () => {
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";
    const psid = "new-completion-limit-user";
    const userId = "new-completion-limit-user-key";
    const reqId = "req-new-completion-limit";
    const identity = quotaIdentityForUser(userId);
    const prior = await reserveMessengerImageQuota(identity, "prior-success");
    expect(prior.status).toBe("reserved");
    if (prior.status !== "reserved") throw new Error("expected reservation");
    await commitMessengerImageQuotaSuccess(identity, prior.reservation);
    await markMessengerGenerationCompleted(
      reqId,
      "https://img.example/new-completion-at-limit.png",
      userId
    );
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_quota_recovery_blocked",
      expect.objectContaining({
        reqId,
        reason: "daily_exhausted",
        accountingMode: "success_only_v1",
      })
    );
    await expect(getMessengerImageQuotaStatus(identity)).resolves.toMatchObject(
      {
        daily: { used: 1, limit: 1, remaining: 0 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      }
    );
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "pending",
      quotaAccountingMode: "success_only_v1",
    });
  });

  it("recovers a completion marker written before the provider fence existed", async () => {
    const psid = "delivery-marker-gap-user";
    const userId = "delivery-marker-gap-user-key";
    const reqId = "req-delivery-marker-gap";
    const imageUrl = "https://img.example/delivery-marker-gap.png";
    const identity = quotaIdentityForUser(userId);
    const reservation = await reserveMessengerImageQuota(identity, reqId);
    expect(reservation.status).toBe("reserved");
    if (reservation.status !== "reserved") {
      throw new Error("expected reservation");
    }
    const committed = await commitMessengerImageQuotaSuccess(
      identity,
      reservation.reservation
    );
    expect(committed.committed).toBe(true);
    await markMessengerGenerationCompleted(reqId, imageUrl, userId);
    await markMessengerGenerationQuotaCommitted(
      reqId,
      imageUrl,
      userId,
      committed.quotaStatus
    );
    await markMessengerGenerationDeliveryStarted(reqId, imageUrl, userId);
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(sendImageMock).toHaveBeenCalledTimes(1);
    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      successNoticeStatus: "sent",
    });
  });

  it("reopens a known failed image transport and delivers it on replay", async () => {
    const psid = "known-failed-delivery-user";
    const userId = "known-failed-delivery-user-key";
    const reqId = "req-known-failed-delivery";
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    sendImageMock
      .mockRejectedValueOnce(new Error("request rejected before transport"))
      .mockResolvedValueOnce({ sent: true });

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "pending",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
    expect(sendImageMock).toHaveBeenCalledTimes(2);
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      successNoticeStatus: "sent",
    });
  });

  it("contains an ambiguous image transport and never resends it", async () => {
    const psid = "ambiguous-delivery-user";
    const userId = "ambiguous-delivery-user-key";
    const reqId = "req-ambiguous-delivery";
    const ambiguousError = Object.assign(new Error("response lost"), {
      messengerDeliveryAmbiguous: true,
    });
    const balanceAttemptKeys: Array<string | undefined> = [];
    let firstProviderCall = true;
    const runner = createTestRunner({
      sendLoggedImage: async (recipient, imageUrl) => {
        if (firstProviderCall) {
          firstProviderCall = false;
          return await sendImageMock(recipient, imageUrl);
        }
        // A replay reaches the durable provider fence, which reports that the
        // prior Graph attempt is unsafe; it does not issue another fetch.
        throw ambiguousError;
      },
      sendLoggedText: async (recipient, text, _requestId, deliveryControl) => {
        balanceAttemptKeys.push(deliveryControl?.providerAttemptKey);
        return await sendTextMock(recipient, text);
      },
    });
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());
    sendImageMock.mockRejectedValueOnce(ambiguousError);

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
    expect(sendImageMock).toHaveBeenCalledTimes(1);
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(2);
    expect(sendTextMock.mock.calls[1]?.[1]).toMatch(
      /^Vandaag nog \d+ van 5 foto's\. Deze maand nog \d+ van 20\.$/
    );
    expect(sendTextMock.mock.calls[1]?.[1]).not.toContain("Klaar");
    expect(balanceAttemptKeys.filter(Boolean)).toEqual([
      "generation-ambiguous-balance-notice-v1",
    ]);
    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
    ).resolves.toEqual({
      daily: { used: 1, limit: 5, remaining: 4 },
      monthly: { used: 1, limit: 20, remaining: 19 },
    });
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "transport_started",
      successNoticeStatus: "sent",
    });
  });

  it("clears the in-flight notice when handleGenerationFailure throws", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_771_001_100_000);
    const psid = "failure-throw-clears-notice-user";
    const { ctx, runner } = createContextBackedRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(failureGenerationResult());
    sendQuickRepliesMock.mockRejectedValueOnce(
      new Error("messenger retry prompt failed")
    );

    try {
      await seedInFlightNotice(ctx, psid);
      await runner.processMessengerGenerationJob({
        psid,
        userId: `${psid}-key`,
        reqId: "req-failure-throw-clears-notice",
        lang: "nl",
      });

      sendTextMock.mockClear();
      await setEphemeralKey(`messenger:inflight:${psid}`, "active-again", 60);
      await ctx.maybeSendInFlightMessage(psid, "req-after-failure-throw", "nl");

      expect(sendTextMock).toHaveBeenCalledWith(psid, IN_FLIGHT_NOTICE);
    } finally {
      nowSpy.mockRestore();
      await deleteEphemeralKey(`messenger:inflight:${psid}`);
    }
  });

  it("localizes in-flight notices through the handler context", async () => {
    const psid = "english-inflight-user";
    const { ctx } = createContextBackedRunner();

    try {
      await setEphemeralKey(`messenger:inflight:${psid}`, "active", 60);
      await ctx.maybeSendInFlightMessage(psid, "req-english-inflight", "en");

      expect(sendTextMock).toHaveBeenCalledWith(
        psid,
        t("en", "inFlightMessage")
      );
    } finally {
      await deleteEphemeralKey(`messenger:inflight:${psid}`);
    }
  });

  it("logs and continues when the inline generation-start text send fails", async () => {
    const runner = createTestRunner({
      sendLoggedText: vi.fn(async (_psid, text) => {
        if (text === t("nl", "generatingImagePrompt")) {
          throw new Error("response window closed");
        }
        return { sent: true };
      }),
    });
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());

    await runner.processMessengerGenerationJob({
      psid: "inline-ack-fails-user",
      userId: "inline-ack-fails-user-key",
      reqId: "req-inline-ack-fails",
      lang: "nl",
    });

    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_started_ack_failed",
      expect.objectContaining({
        reqId: "req-inline-ack-fails",
        generationKind: "text_to_image",
      })
    );
    expect(getState("inline-ack-fails-user")?.stage).toBe("IDLE");
    expect(getState("inline-ack-fails-user")?.quota.count).toBe(0);
    await expect(
      getMessengerImageQuotaStatus(
        quotaIdentityForUser("inline-ack-fails-user-key")
      )
    ).resolves.toMatchObject({
      daily: { used: 1, limit: 5, remaining: 4 },
      monthly: { used: 1, limit: 20, remaining: 19 },
    });
  });

  it("counts one durable success and reports the exact daily and monthly balance", async () => {
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());

    await runner.processMessengerGenerationJob({
      psid: "quota-success-user",
      userId: "quota-success-user-key",
      reqId: "req-quota-success",
      lang: "nl",
    });

    expect(getState("quota-success-user")?.quota.count).toBe(0);
    await expect(
      getMessengerImageQuotaStatus(
        quotaIdentityForUser("quota-success-user-key")
      )
    ).resolves.toEqual({
      daily: { used: 1, limit: 5, remaining: 4 },
      monthly: { used: 1, limit: 20, remaining: 19 },
    });
    await expect(
      getMessengerGenerationCompletion("req-quota-success")
    ).resolves.toEqual(
      expect.objectContaining({
        quotaStatus: {
          daily: { used: 1, limit: 5, remaining: 4 },
          monthly: { used: 1, limit: 20, remaining: 19 },
        },
        successNoticeStatus: "sent",
      })
    );
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "quota-success-user",
      "Klaar.\nVandaag nog 4 van 5 foto's. Deze maand nog 19 van 20.",
      expect.any(Array)
    );
    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
  });

  it("commits quota exactly once when generation runs beyond the original reservation lease", async () => {
    const originalOpenAiTimeout = process.env.OPENAI_IMAGE_TIMEOUT_MS;
    const originalOpenAiRetries = process.env.OPENAI_IMAGE_MAX_RETRIES;
    vi.useFakeTimers({ now: new Date("2026-08-23T10:00:00.000Z") });
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "1";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    const psid = "long-quota-lease-user";
    const userId = "long-quota-lease-user-key";
    const reqId = "req-long-quota-lease";
    let releaseGeneration!: () => void;
    let enteredGeneration!: () => void;
    const entered = new Promise<void>(resolve => {
      enteredGeneration = resolve;
    });
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      await input.onProviderAttempt();
      enteredGeneration();
      await new Promise<void>(resolve => {
        releaseGeneration = resolve;
      });
      return successGenerationResult();
    });
    const runner = createTestRunner();

    try {
      const processing = runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });
      await entered;

      // Effective reservation lease: 61 seconds. The quota heartbeat renews
      // while the provider remains active, so a 70-second success still owns
      // its token at the final commit.
      await vi.advanceTimersByTimeAsync(70_000);
      releaseGeneration();
      await processing;

      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      await runner.processMessengerGenerationJob({
        psid,
        userId,
        reqId,
        lang: "nl",
      });
      await expect(
        getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
      ).resolves.toEqual({
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      });
      expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      if (originalOpenAiTimeout === undefined) {
        delete process.env.OPENAI_IMAGE_TIMEOUT_MS;
      } else {
        process.env.OPENAI_IMAGE_TIMEOUT_MS = originalOpenAiTimeout;
      }
      if (originalOpenAiRetries === undefined) {
        delete process.env.OPENAI_IMAGE_MAX_RETRIES;
      } else {
        process.env.OPENAI_IMAGE_MAX_RETRIES = originalOpenAiRetries;
      }
    }
  });

  it("keeps image quota uncommitted when generation fails before provider attempt", async () => {
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(failureGenerationResult());

    await runner.processMessengerGenerationJob({
      psid: "quota-provider-failure-user",
      userId: "quota-provider-failure-user-key",
      reqId: "req-quota-provider-failure",
      lang: "nl",
    });

    expect(getState("quota-provider-failure-user")?.quota.count).toBe(0);
    await expect(
      getMessengerImageQuotaStatus(
        quotaIdentityForUser("quota-provider-failure-user-key")
      )
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
  });

  it("does not count a provider failure, even after the attempt started", async () => {
    const runner = createTestRunner();
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      await input.onProviderAttempt();
      return failureGenerationResult();
    });

    await runner.processMessengerGenerationJob({
      psid: "quota-provider-attempt-failure-user",
      userId: "quota-provider-attempt-failure-user-key",
      reqId: "req-quota-provider-attempt-failure",
      lang: "nl",
    });

    expect(getState("quota-provider-attempt-failure-user")?.quota.count).toBe(
      0
    );
    await expect(
      getMessengerImageQuotaStatus(
        quotaIdentityForUser("quota-provider-attempt-failure-user-key")
      )
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    await expect(
      getMessengerGenerationCompletion("req-quota-provider-attempt-failure")
    ).resolves.toBeNull();
    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
  });

  it("reserves paid quota before marking the provider fence started", async () => {
    const order: string[] = [];
    resolveWorkspaceRuntimePolicyMock.mockResolvedValueOnce({
      kind: "startpilot",
      workspaceId: 42,
      entitlementId: 9,
      mode: "test",
      imageTotalLimit: 20,
      imageDailyLimit: 5,
      imageModel: "gpt-image-2",
      imageQuality: "high",
    });
    reserveMessengerProviderAttemptFenceMock.mockImplementationOnce(
      async () => {
        order.push("fence_reserved");
        return {
          leaseToken: "provider-fence-lease",
          attemptKeyHash: "provider-fence-attempt",
        };
      }
    );
    reserveStartpilotImageUsageMock.mockImplementationOnce(async () => {
      order.push("quota_reserved");
      return {
        allowed: true,
        imagesUsed: 1,
        imagesUsedToday: 1,
        alreadyReserved: false,
      };
    });
    markMessengerProviderAttemptStartedMock.mockImplementationOnce(async () => {
      order.push("fence_started");
    });
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      await input.onProviderAttempt();
      return failureGenerationResult();
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid: "startpilot-admission-order-user",
      userId: "startpilot-admission-order-user-key",
      pageId: "startpilot-page",
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      reqId: "req-startpilot-admission-order",
      lang: "nl",
    });

    expect(order).toEqual([
      "fence_reserved",
      "quota_reserved",
      "fence_started",
    ]);
  });

  it("keeps a paid provider fence safely reserved when start marking fails", async () => {
    resolveWorkspaceRuntimePolicyMock.mockResolvedValueOnce({
      kind: "startpilot",
      workspaceId: 42,
      entitlementId: 9,
      mode: "test",
      imageTotalLimit: 20,
      imageDailyLimit: 5,
      imageModel: "gpt-image-2",
      imageQuality: "high",
    });
    markMessengerProviderAttemptStartedMock.mockRejectedValueOnce(
      new Error("provider fence start unavailable")
    );
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      try {
        await input.onProviderAttempt();
        return successGenerationResult();
      } catch (error) {
        return failureGenerationResult(error);
      }
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid: "startpilot-fence-start-failure-user",
      userId: "startpilot-fence-start-failure-user-key",
      pageId: "startpilot-page",
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      reqId: "req-startpilot-fence-start-failure",
      lang: "nl",
    });

    expect(reserveStartpilotImageUsageMock).toHaveBeenCalledOnce();
    expect(markMessengerProviderAttemptStartedMock).toHaveBeenCalledOnce();
    expect(finalizeMessengerProviderAttemptFenceMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();
  });

  it("records one paid Startpilot usage receipt per generation request", async () => {
    resolveWorkspaceRuntimePolicyMock.mockResolvedValue({
      kind: "startpilot",
      workspaceId: 42,
      entitlementId: 9,
      mode: "test",
      imageTotalLimit: 20,
      imageDailyLimit: 5,
      imageModel: "gpt-image-2",
      imageQuality: "high",
    });
    executeGenerationFlowMock
      .mockImplementationOnce(async input => {
        await input.onProviderAttempt();
        await input.onProviderAttempt();
        return failureGenerationResult();
      })
      .mockResolvedValueOnce(
        successGenerationResult("https://img.example/startpilot-success.png")
      );
    const runner = createTestRunner();
    const userId = "startpilot-provider-retry-user-key";

    await runner.processMessengerGenerationJob({
      psid: "startpilot-provider-retry-user",
      userId,
      pageId: "startpilot-page",
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      reqId: "req-startpilot-provider-failure",
      lang: "nl",
    });

    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    await expect(
      getMessengerGenerationCompletion("req-startpilot-provider-failure")
    ).resolves.toBeNull();

    await runner.processMessengerGenerationJob({
      psid: "startpilot-provider-retry-user",
      userId,
      pageId: "startpilot-page",
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      reqId: "req-startpilot-provider-success",
      lang: "nl",
    });

    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser(userId))
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    await expect(
      getMessengerGenerationCompletion("req-startpilot-provider-success")
    ).resolves.toMatchObject({
      imageUrl: "https://img.example/startpilot-success.png",
    });
    expect(reserveStartpilotImageUsageMock).toHaveBeenCalledTimes(2);
    expect(reserveStartpilotImageUsageMock).toHaveBeenNthCalledWith(1, {
      workspaceId: 42,
      entitlementId: 9,
      channelConnectionId: 8,
      bindingEpoch: 3,
      mode: "test",
      idempotencyKey: "startpilot-image:req-startpilot-provider-failure",
    });
    expect(reserveStartpilotImageUsageMock).toHaveBeenNthCalledWith(2, {
      workspaceId: 42,
      entitlementId: 9,
      channelConnectionId: 8,
      bindingEpoch: 3,
      mode: "test",
      idempotencyKey: "startpilot-image:req-startpilot-provider-success",
    });
    expect(sendImageMock).toHaveBeenCalledOnce();
  });

  it("stops before provider transport when the paid image quota is exhausted", async () => {
    resolveWorkspaceRuntimePolicyMock.mockResolvedValueOnce({
      kind: "startpilot",
      workspaceId: 42,
      entitlementId: 9,
      mode: "test",
      imageTotalLimit: 20,
      imageDailyLimit: 5,
      imageModel: "gpt-image-2",
      imageQuality: "high",
    });
    reserveStartpilotImageUsageMock.mockResolvedValueOnce({
      allowed: false,
      reason: "daily_exhausted",
    });
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      try {
        await input.onProviderAttempt();
        return successGenerationResult();
      } catch (error) {
        return failureGenerationResult(error);
      }
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid: "startpilot-exhausted-user",
      userId: "startpilot-exhausted-user-key",
      pageId: "startpilot-page",
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      reqId: "req-startpilot-daily-exhausted",
      lang: "nl",
    });

    expect(reserveStartpilotImageUsageMock).toHaveBeenCalledOnce();
    expect(markMessengerProviderAttemptStartedMock).not.toHaveBeenCalled();
    expect(finalizeMessengerProviderAttemptFenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptKeyHash: "provider-fence-attempt",
      }),
      "known_failed"
    );
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledOnce();
    expect(
      await runWithMessengerRequestContext("startpilot-page", async () =>
        getState("startpilot-exhausted-user")
      )
    ).toMatchObject({ stage: "AWAITING_EDIT_PROMPT" });
  });

  it("keeps the paid workspace quota even for an explicit owner", async () => {
    process.env.MESSENGER_ADMIN_IDS = "owner-psid";
    resolveWorkspaceRuntimePolicyMock.mockResolvedValueOnce({
      kind: "startpilot",
      workspaceId: 42,
      entitlementId: 9,
      mode: "live",
      imageTotalLimit: 20,
      imageDailyLimit: 5,
      imageModel: "gpt-image-2",
      imageQuality: "high",
    });
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      expect(input.bypassBudgetLimits).toBe(true);
      await input.onProviderAttempt();
      return successGenerationResult();
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid: "owner-psid",
      userId: "owner-user-key",
      pageId: "owner-page",
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      reqId: "req-owner-unlimited",
      lang: "nl",
    });

    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser("owner-user-key"))
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    expect(
      await runWithMessengerRequestContext(
        "owner-page",
        async () => getState("owner-psid")?.quota.count
      )
    ).toBe(0);
    expect(reserveStartpilotImageUsageMock).toHaveBeenCalledWith({
      workspaceId: 42,
      entitlementId: 9,
      channelConnectionId: 8,
      bindingEpoch: 3,
      mode: "live",
      idempotencyKey: "startpilot-image:req-owner-unlimited",
    });
  });

  it("does not count provider retries when generation ultimately fails", async () => {
    const runner = createTestRunner();
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      await input.onProviderAttempt();
      await input.onProviderAttempt();
      return failureGenerationResult();
    });

    await runner.processMessengerGenerationJob({
      psid: "quota-provider-retry-failure-user",
      userId: "quota-provider-retry-failure-user-key",
      reqId: "req-quota-provider-retry-failure",
      lang: "en",
    });

    expect(getState("quota-provider-retry-failure-user")?.quota.count).toBe(0);
    await expect(
      getMessengerImageQuotaStatus(
        quotaIdentityForUser("quota-provider-retry-failure-user-key")
      )
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
    expect(executeGenerationFlowMock).toHaveBeenCalledTimes(1);
  });

  it("does not bypass free quota when only part of an id matches", async () => {
    const originalBypassIds = process.env.MESSENGER_QUOTA_BYPASS_IDS;
    process.env.MESSENGER_QUOTA_BYPASS_IDS = "quota-user-1234";
    const runner = createTestRunner();
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      expect(input.bypassBudgetLimits).toBe(false);
      return successGenerationResult();
    });

    try {
      await runner.processMessengerGenerationJob({
        psid: "quota-user-123",
        userId: "quota-user-123-key",
        reqId: "req-quota-exact-bypass-log",
        lang: "nl",
      });
    } finally {
      if (originalBypassIds === undefined) {
        delete process.env.MESSENGER_QUOTA_BYPASS_IDS;
      } else {
        process.env.MESSENGER_QUOTA_BYPASS_IDS = originalBypassIds;
      }
    }

    expect(safeLogMock).toHaveBeenCalledWith(
      "quota_decision",
      expect.objectContaining({
        action: "reserve",
        result: "reserved",
        allowed: true,
      })
    );
    await expect(
      getMessengerImageQuotaStatus(quotaIdentityForUser("quota-user-123-key"))
    ).resolves.toMatchObject({
      daily: { used: 1, remaining: 4 },
      monthly: { used: 1, remaining: 19 },
    });
  });

  it("does not grant customer budget bypass to test quota IDs", async () => {
    process.env.MESSENGER_QUOTA_BYPASS_IDS = "test-bypass-user";
    executeGenerationFlowMock.mockImplementationOnce(async input => {
      expect(input.bypassBudgetLimits).toBe(false);
      return successGenerationResult();
    });
    const runner = createTestRunner();

    await runner.processMessengerGenerationJob({
      psid: "test-bypass-user",
      userId: "test-bypass-user-key",
      reqId: "req-test-bypass-budget-bound",
      lang: "nl",
    });

    expect(executeGenerationFlowMock).toHaveBeenCalledOnce();
  });

  it("uses the out-of-free-credits translation when quota is exhausted", async () => {
    const originalLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;
    const originalPortalBaseUrl = process.env.PORTAL_BASE_URL;
    process.env.MESSENGER_FREE_DAILY_LIMIT = "0";
    process.env.PORTAL_BASE_URL = "https://leaderbot.live";
    const { runner } = createContextBackedRunner();

    try {
      await runner.processMessengerGenerationJob({
        psid: "quota-exhausted-user",
        userId: "quota-exhausted-user-key",
        reqId: "req-quota-exhausted",
        lang: "en",
      });
    } finally {
      if (originalLimit === undefined) {
        delete process.env.MESSENGER_FREE_DAILY_LIMIT;
      } else {
        process.env.MESSENGER_FREE_DAILY_LIMIT = originalLimit;
      }
      if (originalPortalBaseUrl === undefined) {
        delete process.env.PORTAL_BASE_URL;
      } else {
        process.env.PORTAL_BASE_URL = originalPortalBaseUrl;
      }
    }

    expect(sendButtonTemplateMock).toHaveBeenCalledWith(
      "quota-exhausted-user",
      `${t("en", "outOfDailyImageCredits")}\nToday you have 0 of 0 photos left. This month you have 20 of 20 left.`,
      [
        {
          type: "web_url",
          title: "Open Leaderbot",
          url: "https://leaderbot.live/?upgrade=startpilot#pricing",
          webview_height_ratio: "full",
        },
      ]
    );
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(getState("quota-exhausted-user")?.stage).toBe(
      "AWAITING_EDIT_PROMPT"
    );
  });

  it("treats sent:false as a retryable exhausted-quota notice", async () => {
    process.env.MESSENGER_FREE_DAILY_LIMIT = "0";
    const psid = "quota-notice-skipped-user";
    const userId = "quota-notice-skipped-user-key";
    const reqId = "req-quota-notice-skipped";
    const runner = createTestRunner();
    sendQuickRepliesMock
      .mockResolvedValueOnce({
        sent: false,
        reason: "response_window_closed",
      })
      .mockResolvedValueOnce({ sent: true });

    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_balance_notice_delivery_failed",
      expect.objectContaining({ reqId })
    );
    await runner.processMessengerGenerationJob({
      psid,
      userId,
      reqId,
      lang: "nl",
    });

    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(2);
    expect(getState(psid)?.stage).toBe("AWAITING_EDIT_PROMPT");
  });

  it("throws a sent:false quota notice back to the durable queue", async () => {
    process.env.MESSENGER_FREE_DAILY_LIMIT = "0";
    const queueEnabled = vi
      .spyOn(messengerGenerationQueue, "isMessengerGenerationQueueEnabled")
      .mockReturnValue(true);
    const runner = createTestRunner({
      sendLoggedActions: vi.fn(async () => ({
        sent: false as const,
        reason: "response_window_closed" as const,
      })),
    });

    try {
      await expect(
        runner.processMessengerGenerationJob({
          psid: "queued-quota-notice-user",
          userId: "queued-quota-notice-user-key",
          reqId: "req-queued-quota-notice",
          lang: "nl",
        })
      ).rejects.toThrow("balance notice delivery failed");
    } finally {
      queueEnabled.mockRestore();
    }

    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
  });

  it("allows a later generation to recover after an unexpected generation error", async () => {
    const runner = createTestRunner();
    executeGenerationFlowMock
      .mockRejectedValueOnce(new Error("transient provider crash"))
      .mockResolvedValueOnce(
        successGenerationResult("https://img.example/recovered.png")
      );

    await runner.processMessengerGenerationJob({
      psid: "recoverable-user",
      userId: "recoverable-user-key",
      reqId: "req-recoverable-fail",
      lang: "nl",
    });
    expect(getState("recoverable-user")?.stage).toBe("FAILURE");

    await runner.processMessengerGenerationJob({
      psid: "recoverable-user",
      userId: "recoverable-user-key",
      reqId: "req-recoverable-success",
      lang: "nl",
    });

    expect(getState("recoverable-user")?.stage).toBe("IDLE");
    expect(sendImageMock).toHaveBeenCalledWith(
      "recoverable-user",
      "https://img.example/recovered.png"
    );
  });
});

function createTestRunner(
  overrides: Partial<
    Pick<
      HandlerContext,
      "sendLoggedImage" | "sendLoggedActions" | "sendLoggedText"
    >
  > = {}
) {
  return createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    sendLoggedImage: async (psid, imageUrl, reqId) => {
      return overrides.sendLoggedImage
        ? await overrides.sendLoggedImage(psid, imageUrl, reqId)
        : ((await sendImageMock(
            psid,
            imageUrl
          )) satisfies MessengerSendOutcome);
    },
    sendLoggedActions:
      overrides.sendLoggedActions ??
      (async (psid, text, actions) =>
        (await sendQuickRepliesMock(
          psid,
          text,
          actions
        )) satisfies MessengerSendOutcome),
    sendLoggedText:
      overrides.sendLoggedText ??
      (async (psid, text) =>
        (await sendTextMock(psid, text)) satisfies MessengerSendOutcome),
  });
}

function createContextBackedRunner() {
  // ctx is assigned after runner creation; safe because callbacks are only
  // invoked at test runtime, after ctx is assigned.
  let ctx!: HandlerContext;
  const runner = createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: (psid, reqId) =>
      ctx.maybeSendInFlightMessage(psid, reqId, "nl"),
    sendLoggedImage: (psid, imageUrl, reqId) =>
      ctx.sendLoggedImage(psid, imageUrl, reqId),
    sendLoggedActions: (psid, text, actions, reqId, deliveryControl) =>
      ctx.sendLoggedActions(psid, text, actions, reqId, deliveryControl),
    sendLoggedText: (psid, text, reqId, deliveryControl) =>
      ctx.sendLoggedText(psid, text, reqId, deliveryControl),
  });
  ctx = createHandlerContext({
    defaultLang: "nl",
    runImageGeneration: runner.runImageGeneration,
  });
  return { ctx, runner };
}

async function seedInFlightNotice(
  ctx: HandlerContext,
  psid: string
): Promise<void> {
  await setEphemeralKey(`messenger:inflight:${psid}`, "active", 60);
  await ctx.maybeSendInFlightMessage(psid, "req-seed-notice", "nl");
  await deleteEphemeralKey(`messenger:inflight:${psid}`);
  expect(sendTextMock).toHaveBeenCalledWith(psid, IN_FLIGHT_NOTICE);
}

async function seedLegacyCompletion(input: {
  reqId: string;
  userId: string;
  imageUrl: string;
  deliveryStatus: "pending" | "delivered";
  quotaAccountingMode?: "legacy_pre_success_v1";
}): Promise<void> {
  await writeScopedState(
    "messenger-generation-completion",
    input.reqId,
    {
      reqId: input.reqId,
      imageUrl: input.imageUrl,
      completedAt: Date.now(),
      deliveryStatus: input.deliveryStatus,
      quotaAccountingMode: input.quotaAccountingMode ?? "legacy_pre_success_v1",
      userKey: input.userId,
    },
    7 * 24 * 60 * 60
  );
}

function successGenerationResult(
  imageUrl = "https://img.example/generated.png"
) {
  return {
    kind: "success",
    imageUrl,
    mode: "mock",
    metrics: { totalMs: 10 },
    proof: {
      incomingLen: 1,
      incomingSha256: "incoming-sha",
      openaiInputLen: 1,
      openaiInputSha256: "input-sha",
    },
    resolvedSourceImageUrl: imageUrl,
    trustedSourceImageUrl: true,
  };
}

function failureGenerationResult(
  error: unknown = new Error("provider failed")
) {
  return {
    kind: "error",
    errorKind: "generation_failed",
    error,
    metrics: { totalMs: 10 },
    trustedSourceImageUrl: false,
  };
}

function quotaIdentityForUser(userId: string): MessengerImageQuotaIdentity {
  return {
    workspaceId: 1,
    channelConnectionId: 1,
    bindingEpoch: 1,
    privacyEpoch: 1,
    userKey: getUserKey(userId),
  };
}
