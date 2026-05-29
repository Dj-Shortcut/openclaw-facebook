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

    expect(sendTextMock).toHaveBeenCalledWith(psid, "⏳ Slow down a bit.");
    const textExecutions = safeLogMock.mock.calls.filter(
      ([event]) => event === "shared_text_executing"
    );
    expect(textExecutions).toHaveLength(11);
  });

  it("lets remix text fall back to deterministic text handling", async () => {
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

    expect(sendTextMock).toHaveBeenCalledWith(psid, t("nl", "textWithoutPhoto"));
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

    expect(sendTextMock).toHaveBeenCalledWith(
      psid,
      [t("nl", "textWithoutPhoto"), t("nl", "assistantPhotoTip")].join("\n\n")
    );
  });

  it("keeps surprise-without-photo users in awaiting-photo state", async () => {
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

    expect(sendTextMock).toHaveBeenCalledWith(psid, t("nl", "textWithoutPhoto"));
    expect(getState(anonymizePsid(psid))?.stage).toBe("AWAITING_PHOTO");
  });
});
