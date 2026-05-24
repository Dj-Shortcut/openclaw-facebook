import { describe, expect, it } from "vitest";
import {
  classifyMessengerFastLaneIntent,
  formatUnmatchedMessengerPageLog,
  redactMessengerIdentifier,
  resolveMessengerFastLaneReply,
  resolveMessengerEventTarget,
  resolveMessengerVerificationTarget,
  shouldProcessMessengerMessageOnce,
  type MessengerWebhookTarget,
} from "./monitor.js";

function messengerTarget(
  accountId: string,
  pageId: string,
  verifyToken = "verify",
): MessengerWebhookTarget {
  return {
    account: {
      accountId,
      enabled: true,
      pageId,
      pageAccessToken: "token",
      appSecret: "secret",
      verifyToken,
      tokenSource: "config",
      config: {},
    },
    path: "/facebook/webhook",
    runtime: {
      log: () => {},
      error: () => {},
      exit: () => {},
    },
  };
}

describe("resolveMessengerEventTarget", () => {
  it("uses recipient page id to choose between same-path accounts", () => {
    const first = messengerTarget("first", "page-1");
    const second = messengerTarget("second", "page-2");

    expect(
      resolveMessengerEventTarget([first, second], {
        recipient: { id: "page-2" },
      }),
    ).toBe(second);
    expect(
      resolveMessengerEventTarget([first, second], {
        recipient: { id: "page-3" },
      }),
    ).toBeNull();
  });
});

describe("resolveMessengerVerificationTarget", () => {
  it("matches GET verification tokens across same-path accounts", () => {
    const first = messengerTarget("first", "page-1", "first-token");
    const second = messengerTarget("second", "page-2", "second-token");
    const url = new URL(
      "https://example.test/facebook/webhook?hub.mode=subscribe&hub.verify_token=second-token&hub.challenge=ok",
    );

    expect(resolveMessengerVerificationTarget([first, second], url)).toBe(second);
  });
});

describe("redactMessengerIdentifier", () => {
  it("redacts stable ids without exposing the raw value", () => {
    const redacted = redactMessengerIdentifier("1234567890");

    expect(redacted).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(redacted).not.toContain("1234567890");
    expect(redactMessengerIdentifier("1234567890")).toBe(redacted);
  });
});

describe("formatUnmatchedMessengerPageLog", () => {
  it("does not include raw sender, page, or message text", () => {
    const logLine = formatUnmatchedMessengerPageLog({
      recipient: { id: "page-123456" },
      sender: { id: "sender-987654" },
      message: {
        mid: "mid-sensitive",
        text: "my card number is 4111 1111 1111 1111",
      },
    });

    expect(logLine).toContain("messenger: skipped event for unmatched page");
    expect(logLine).not.toContain("page-123456");
    expect(logLine).not.toContain("sender-987654");
    expect(logLine).not.toContain("card number");
    expect(logLine).not.toContain("4111");
    expect(logLine).not.toContain("mid-sensitive");
  });
});

describe("shouldProcessMessengerMessageOnce", () => {
  it("allows a Messenger message id only once inside the dedupe window", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-1",
        messageId: "mid-1",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-1",
        messageId: "mid-1",
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("dedupes the same message id independently per account", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "account-a",
        senderId: "sender-1",
        messageId: "mid-account",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "account-b",
        senderId: "sender-1",
        messageId: "mid-account",
        now: 1_000,
      }),
    ).toBe(true);
  });

  it("falls back to sender and timestamp when Meta omits the message id", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-2",
        timestamp: 123_456,
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-2",
        timestamp: 123_456,
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("allows the same message again after the dedupe window expires", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-3",
        messageId: "mid-expiring",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-3",
        messageId: "mid-expiring",
        now: 1_000 + 10 * 60 * 1000 + 1,
      }),
    ).toBe(true);
  });
});

describe("classifyMessengerFastLaneIntent", () => {
  it.each([
    ["hey", "greeting"],
    ["wat kan je?", "help"],
    ["ben je online", "status"],
    ["maak afbeelding van een robot", "image"],
  ] as const)("classifies %s as %s", (text, intent) => {
    expect(classifyMessengerFastLaneIntent(text)).toBe(intent);
  });

  it("leaves real assistant prompts for the OpenClaw turn", () => {
    expect(classifyMessengerFastLaneIntent("Schrijf een korte planning voor morgen")).toBeNull();
  });
});

describe("resolveMessengerFastLaneReply", () => {
  it("returns a direct reply for simple Messenger intents", () => {
    const result = resolveMessengerFastLaneReply("help");

    expect(result?.intent).toBe("help");
    expect(result?.reply).toContain("korte vragen");
  });
});
