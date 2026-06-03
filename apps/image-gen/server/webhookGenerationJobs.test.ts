import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeGenerationFlowMock,
  safeLogMock,
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
} = vi.hoisted(() => ({
  executeGenerationFlowMock: vi.fn(),
  safeLogMock: vi.fn(),
  sendImageMock: vi.fn(async () => ({ sent: true })),
  sendQuickRepliesMock: vi.fn(async () => ({ sent: true })),
  sendTextMock: vi.fn(async () => ({ sent: true })),
}));

vi.mock("./_core/generationFlow", () => ({
  executeGenerationFlow: executeGenerationFlowMock,
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
}));

import { createHandlerContext } from "./_core/webhookHandlerContext";
import { createMessengerGenerationJobRunner } from "./_core/webhookGenerationJobs";
import { getState, resetStateStore } from "./_core/messengerState";
import { deleteEphemeralKey, setEphemeralKey } from "./_core/stateStore";
import { t } from "./_core/i18n";
import type { MessengerSendOutcome } from "./_core/messengerApi";
import type { HandlerContext } from "./_core/webhookHandlerTypes";

const IN_FLIGHT_NOTICE = "Even geduld, ik ben nog bezig met je afbeelding.";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

afterAll(() => {
  if (originalPrivacyPepper === undefined) {
    delete process.env.PRIVACY_PEPPER;
    return;
  }

  process.env.PRIVACY_PEPPER = originalPrivacyPepper;
});

beforeEach(() => {
  process.env.PRIVACY_PEPPER = "webhook-generation-jobs-test-pepper";
  executeGenerationFlowMock.mockReset();
  safeLogMock.mockReset();
  sendImageMock.mockReset();
  sendImageMock.mockResolvedValue({ sent: true });
  sendQuickRepliesMock.mockReset();
  sendQuickRepliesMock.mockResolvedValue({ sent: true });
  sendTextMock.mockReset();
  sendTextMock.mockResolvedValue({ sent: true });
  resetStateStore();
});

describe("messenger generation job safety", () => {
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

  it("clears the in-flight notice when handleGenerationSuccess throws", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_771_001_000_000);
    const psid = "success-throw-clears-notice-user";
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
        reqId: "req-success-throw-clears-notice",
        lang: "nl",
      });

      sendTextMock.mockClear();
      await setEphemeralKey(`messenger:inflight:${psid}`, "active-again", 60);
      await ctx.maybeSendInFlightMessage(psid, "req-after-success-throw", "nl");

      expect(sendTextMock).toHaveBeenCalledWith(psid, IN_FLIGHT_NOTICE);
    } finally {
      nowSpy.mockRestore();
      await deleteEphemeralKey(`messenger:inflight:${psid}`);
    }
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
  });

  it("logs quota bypass with exact id matching", async () => {
    const originalBypassIds = process.env.MESSENGER_QUOTA_BYPASS_IDS;
    process.env.MESSENGER_QUOTA_BYPASS_IDS = "quota-user-1234";
    const runner = createTestRunner();
    executeGenerationFlowMock.mockResolvedValueOnce(successGenerationResult());

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
        bypassApplied: false,
        allowed: true,
      })
    );
  });

  it("uses the out-of-free-credits translation when quota is exhausted", async () => {
    const originalLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;
    process.env.MESSENGER_FREE_DAILY_LIMIT = "0";
    const runner = createTestRunner();

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
    }

    expect(sendTextMock).toHaveBeenCalledWith(
      "quota-exhausted-user",
      t("en", "outOfFreeCredits")
    );
    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(getState("quota-exhausted-user")?.stage).toBe(
      "AWAITING_EDIT_PROMPT"
    );
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
      "sendLoggedImage" | "sendLoggedQuickReplies" | "sendLoggedText"
    >
  > = {}
) {
  return createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    sendLoggedImage:
      overrides.sendLoggedImage ??
      (async (psid, imageUrl) =>
        (await sendImageMock(psid, imageUrl)) satisfies MessengerSendOutcome),
    sendLoggedQuickReplies:
      overrides.sendLoggedQuickReplies ??
      (async (psid, text, replies) =>
        (await sendQuickRepliesMock(
          psid,
          text,
          replies
        )) satisfies MessengerSendOutcome),
    sendLoggedText:
      overrides.sendLoggedText ??
      (async (psid, text) =>
        (await sendTextMock(psid, text)) satisfies MessengerSendOutcome),
  });
}

function createContextBackedRunner() {
  let ctx!: HandlerContext;
  const runner = createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: (psid, reqId) =>
      ctx.maybeSendInFlightMessage(psid, reqId, "nl"),
    sendLoggedImage: (psid, imageUrl, reqId) =>
      ctx.sendLoggedImage(psid, imageUrl, reqId),
    sendLoggedQuickReplies: (psid, text, replies, reqId) =>
      ctx.sendLoggedQuickReplies(psid, text, replies, reqId),
    sendLoggedText: (psid, text, reqId) =>
      ctx.sendLoggedText(psid, text, reqId),
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

function failureGenerationResult() {
  return {
    kind: "error",
    errorKind: "generation_failed",
    error: new Error("provider failed"),
    metrics: { totalMs: 10 },
    trustedSourceImageUrl: false,
  };
}
