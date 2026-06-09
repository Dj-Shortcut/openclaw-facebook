import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  safeLogMock,
  handleTextMessageMock,
  decodeMessengerActionInputMock,
  handlePayloadMock,
  tryHandleImageMessageMock,
} = vi.hoisted(() => ({
  safeLogMock: vi.fn(),
  handleTextMessageMock: vi.fn(async () => undefined),
  decodeMessengerActionInputMock: vi.fn(),
  handlePayloadMock: vi.fn(async () => undefined),
  tryHandleImageMessageMock: vi.fn(async () => false),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

vi.mock("./_core/webhookTextMessageRouter", () => ({
  handleTextMessage: handleTextMessageMock,
}));

vi.mock("./_core/messengerActionPayload", () => ({
  decodeMessengerActionInput: decodeMessengerActionInputMock,
}));

vi.mock("./_core/webhookPayloadBranch", () => ({
  handlePayload: handlePayloadMock,
}));

vi.mock("./_core/webhookImageMessageRouter", () => ({
  tryHandleImageMessage: tryHandleImageMessageMock,
}));

import type { HandlerContext } from "./_core/webhookHandlerTypes";
import { t } from "./_core/i18n";
import { handleMessageEvent } from "./_core/webhookMessageRouter";
import { type FacebookWebhookEvent } from "./_core/webhookHelpers";

type TestAttachment = Exclude<
  NonNullable<FacebookWebhookEvent["message"]>["attachments"],
  undefined
>[number];

function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    defaultLang: "nl",
    claimEventReplayOrLog: vi.fn(async () => true),
    createFeatureImageContext: vi.fn(),
    createFeaturePayloadContext: vi.fn(),
    createFeatureTextContext: vi.fn(),
    debugWebhookLog: vi.fn(),
    getAttachmentHostname: vi.fn(() => "example.com"),
    logImageFlowDecision: vi.fn(),
    logIncomingMessage: vi.fn(),
    logUserState: vi.fn(),
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    runImageGeneration: vi.fn(async () => ({ sent: true, messageId: "msg-image" })),
    sendFaceMemoryConsentPrompt: vi.fn(async () => ({ sent: true, messageId: "msg-face" })),
    sendFlowExplanation: vi.fn(async () => ({ sent: true, messageId: "msg-flow" })),
    sendLoggedImage: vi.fn(async () => ({ sent: true, messageId: "msg-image-output" })),
    sendLoggedActions: vi.fn(async () => ({ sent: true, messageId: "msg-actions" })),
    sendLoggedText: vi.fn(async () => ({ sent: true, messageId: "msg-text" })),
    sendPhotoReceivedPrompt: vi.fn(async () => ({ sent: true, messageId: "msg-photo-prompt" })),
    ...overrides,
  };
}

function findLogEvent(eventName: string): Record<string, unknown> | undefined {
  const entry = safeLogMock.mock.calls.find(([name]) => name === eventName)?.[1];
  return (entry as Record<string, unknown> | undefined) ?? undefined;
}

function messageWithTextAndAttachments(
  text: string,
  attachments: TestAttachment[]
): FacebookWebhookEvent["message"] {
  return {
    mid: "mid-test-message",
    text,
    attachments: attachments as FacebookWebhookEvent["message"]["attachments"],
  };
}

describe("webhook message router", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "test-pepper";
    safeLogMock.mockClear();
    handleTextMessageMock.mockClear();
    decodeMessengerActionInputMock.mockClear();
    handlePayloadMock.mockClear();
    tryHandleImageMessageMock.mockClear();
  });

  afterEach(() => {
    safeLogMock.mockReset();
    handleTextMessageMock.mockReset();
    decodeMessengerActionInputMock.mockReset();
    handlePayloadMock.mockReset();
    tryHandleImageMessageMock.mockReset();
  });

  it("routes mixed text + image to image handling and avoids text fallback", async () => {
    tryHandleImageMessageMock.mockResolvedValueOnce(true);
    const ctx = makeContext();

    await handleMessageEvent(ctx, {
      psid: "image-text-user",
      userId: "image-text-user-key",
      event: {
        message: messageWithTextAndAttachments("maak deze cyberpunk", [
          { type: "image", payload: { url: "https://img.example/photo.jpg" } },
        ]),
      },
      reqId: "req-image-text",
      lang: "nl",
    });

    expect(tryHandleImageMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            type: "image",
            payload: expect.objectContaining({ url: "https://img.example/photo.jpg" }),
          }),
        ],
        text: "maak deze cyberpunk",
      })
    );
    expect(handleTextMessageMock).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).not.toHaveBeenCalled();
    expect(findLogEvent("shared_text_executing")).toBeUndefined();
    expect(findLogEvent("messenger_attachment_routed")).toMatchObject({
      route: "image",
    });
    expect(findLogEvent("messenger_attachment_received")).toMatchObject({
      attachmentKinds: ["image"],
      attachmentCount: 1,
    });
  });

  it("falls back to unsupported media when an image attachment has no image-handler result", async () => {
    const ctx = makeContext();

    await handleMessageEvent(ctx, {
      psid: "image-no-handler-user",
      userId: "image-no-handler-user-key",
      event: {
        message: messageWithTextAndAttachments("maak deze cyberpunk", [
          { type: "image", payload: { url: "https://img.example/photo.jpg" } },
        ]),
      },
      reqId: "req-image-no-handler",
      lang: "nl",
    });

    expect(handleTextMessageMock).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      "image-no-handler-user",
      t("nl", "unsupportedMedia"),
      "req-image-no-handler"
    );
    expect(findLogEvent("messenger_attachment_unsupported")).toMatchObject({
      route: "unsupported_media",
      attachmentKinds: ["image"],
      attachmentCount: 1,
    });
  });

  it("routes screenshot/image attachments as image ingress flow", async () => {
    tryHandleImageMessageMock.mockResolvedValueOnce(true);
    const ctx = makeContext();

    await handleMessageEvent(ctx, {
      psid: "screenshot-user",
      userId: "screenshot-user-key",
      event: {
        message: messageWithTextAndAttachments("Screenshot van een bug", [
          { type: "image", payload: { url: "https://img.example/screenshot.jpg" } },
        ]),
      },
      reqId: "req-screenshot",
      lang: "nl",
    });

    expect(tryHandleImageMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        psid: "screenshot-user",
        text: "Screenshot van een bug",
      })
    );
    expect(handleTextMessageMock).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).not.toHaveBeenCalled();
  });

  it("routes text-only messages to text handling", async () => {
    const ctx = makeContext();

    await handleMessageEvent(ctx, {
      psid: "text-only-user",
      userId: "text-only-user-key",
      event: {
        message: {
          mid: "mid-text-only",
          text: "maak een huis",
        },
      },
      reqId: "req-text-only",
      lang: "nl",
    });

    expect(handleTextMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        psid: "text-only-user",
        text: "maak een huis",
      })
    );
    expect(findLogEvent("shared_text_executing")).toBeUndefined();
  });

  const unsupportedCases: Array<{
    type: string;
    expected: string;
    attachment: TestAttachment;
  }> = [
    {
      type: "audio",
      expected: t("nl", "unsupportedAudio"),
      attachment: {
        type: "audio",
        payload: { url: "https://media.example/audio.mp3" },
      },
    },
    {
      type: "video",
      expected: t("nl", "unsupportedMedia"),
      attachment: {
        type: "video",
        payload: { url: "https://media.example/video.mp4" },
      },
    },
    {
      type: "file",
      expected: t("nl", "unsupportedMedia"),
      attachment: {
        type: "file",
        payload: { url: "https://media.example/document.pdf" },
      },
    },
    {
      type: "unknown",
      expected: t("nl", "unsupportedMedia"),
      attachment: {
        type: "sticker",
        payload: { sticker_id: "123" },
      },
    },
    {
      type: "link",
      expected: t("nl", "unsupportedMedia"),
      attachment: {
        type: "fallback",
        payload: { url: "https://shared.example/story", title: "Shared link" },
      },
    },
  ];

  it.each(unsupportedCases)(
    "sends unsupported %s response for attachments and never falls back to shared text",
    async ({ type, expected, attachment }) => {
      const ctx = makeContext();
      await handleMessageEvent(ctx, {
        psid: `${type}-unsupported-user`,
        userId: `${type}-unsupported-user-key`,
        event: {
          message: messageWithTextAndAttachments("maak deze cyberpunk", [attachment]),
        },
        reqId: `req-${type}-unsupported`,
        lang: "nl",
      });

      expect(handleTextMessageMock).not.toHaveBeenCalled();
      expect(ctx.sendLoggedText).toHaveBeenCalledWith(
        `${type}-unsupported-user`,
        expected,
        `req-${type}-unsupported`
      );
    }
  );

  it("routes gif attachments through image handling when image flow handles them", async () => {
    tryHandleImageMessageMock.mockResolvedValueOnce(true);
    const ctx = makeContext();

    await handleMessageEvent(ctx, {
      psid: "gif-image-user",
      userId: "gif-image-user-key",
      event: {
        message: messageWithTextAndAttachments("maak deze cyberpunk", [
          {
            type: "image",
            payload: {
              url: "https://media.example/anim.gif",
              mime_type: "image/gif",
            },
          },
        ]),
      },
      reqId: "req-gif-image",
      lang: "nl",
    });

    expect(tryHandleImageMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            type: "image",
            payload: expect.objectContaining({
              url: "https://media.example/anim.gif",
            }),
          }),
        ],
        text: "maak deze cyberpunk",
      })
    );
    expect(handleTextMessageMock).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).not.toHaveBeenCalled();
    expect(findLogEvent("messenger_attachment_unsupported")).toBeUndefined();
    expect(findLogEvent("messenger_attachment_routed")).toMatchObject({
      route: "image",
    });
  });
}); 
