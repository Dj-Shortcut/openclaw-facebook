import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
  safeLogMock,
} = vi.hoisted(() => ({
  sendImageMock: vi.fn(async () => undefined),
  sendQuickRepliesMock: vi.fn(async () => undefined),
  sendTextMock: vi.fn(async () => undefined),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/messengerApi", () => ({
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
  safeLog: safeLogMock,
}));

import { t } from "./_core/i18n";
import {
  processFacebookWebhookPayload as processFacebookWebhookPayloadBase,
  resetMessengerEventDedupe,
} from "./_core/messengerWebhook";
import { anonymizePsid, getState, resetStateStore } from "./_core/messengerState";
import { processConsentedFacebookWebhookPayload } from "./testConsentHelpers";

const processFacebookWebhookPayload = processConsentedFacebookWebhookPayload(
  processFacebookWebhookPayloadBase
);

describe("bot features", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "ci-test-pepper";
    resetStateStore();
    resetMessengerEventDedupe();
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    delete process.env.BOT_TEXT_RATE_LIMIT_MAX;
    delete process.env.BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS;
  });

  it("rate limits inbound text spam after 10 messages", async () => {
    const psid = "rate-user";

    for (let index = 0; index < 11; index += 1) {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: { mid: `mid-${index}`, text: `msg-${index}` },
              },
            ],
          },
        ],
      });
    }

    expect(sendTextMock).toHaveBeenCalledWith(psid, "Slow down a bit.");
    const textExecutions = safeLogMock.mock.calls.filter(
      ([event]) => event === "shared_text_executing"
    );
    expect(textExecutions).toHaveLength(11);
  });

  it("lets remix text fall back to prompt-first quick actions", async () => {
    const psid = "remix-fallback-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-remix", text: "remix: neon rain" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "OPENCLAW_ACTION:new_image" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Pas%20foto%20aan" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Privacy" }),
      ])
    );
  });

  it("handles help command via bot feature without OpenAI text", async () => {
    const psid = "help-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-help", text: "help" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "OPENCLAW_ACTION:new_image" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Pas%20foto%20aan" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Privacy" }),
      ])
    );
  });

  it("keeps surprise-without-photo users in prompt-first quick actions", async () => {
    const psid = "surprise-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-surprise", text: "surprise me" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "OPENCLAW_ACTION:new_image" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Pas%20foto%20aan" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Privacy" }),
      ])
    );
    expect(getState(anonymizePsid(psid))?.stage).toBe("IDLE");
  });
});
