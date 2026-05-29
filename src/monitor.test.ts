import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyMessengerFastLaneIntent,
  downloadMessengerMediaAttachment,
  formatUnmatchedMessengerPageLog,
  hasMessengerImageGenerationIntent,
  redactMessengerIdentifier,
  resolveMessengerFastLaneReply,
  resolveMessengerEventTarget,
  resolveMessengerSourceImageGenerationPrompt,
  resolveMessengerVerificationTarget,
  sanitizeMessengerSourceImageUrl,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldProcessMessengerMessageOnce,
  type MessengerWebhookTarget,
} from "./monitor.js";

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
let temporaryStateDir: string | null = null;

beforeEach(async () => {
  temporaryStateDir = await mkdtemp(join(tmpdir(), "openclaw-facebook-test-"));
  process.env.OPENCLAW_STATE_DIR = temporaryStateDir;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (temporaryStateDir) {
    await rm(temporaryStateDir, { force: true, recursive: true });
    temporaryStateDir = null;
  }
});

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

  it("does not fall back to the only target when recipient page id is present and unmatched", () => {
    const target = messengerTarget("first", "page-1");

    expect(
      resolveMessengerEventTarget([target], {
        recipient: { id: "page-2" },
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
    expect(classifyMessengerFastLaneIntent("Wat zie je op deze foto?")).toBeNull();
    expect(classifyMessengerFastLaneIntent("Verbeter de stijl van deze tekst")).toBeNull();
    expect(classifyMessengerFastLaneIntent("Maak een prompt voor een afbeelding")).toBeNull();
  });
});

describe("hasMessengerImageGenerationIntent", () => {
  it("matches explicit generation and restyle prompts", () => {
    expect(hasMessengerImageGenerationIntent("Restyle deze foto")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak een afbeelding van een robot")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Kan je een afbeelding maken van een robot?")).toBe(
      true,
    );
    expect(hasMessengerImageGenerationIntent("Ik wil een afbeelding genereren")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak me een romeinse soldaat")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak mij een stripheld")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Doe maar")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Ja graag")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Ok")).toBe(true);
  });

  it("does not match image analysis or writing-style prompts", () => {
    expect(hasMessengerImageGenerationIntent("Wat zie je op deze foto?")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Verbeter de stijl van deze tekst")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Maak een prompt voor een afbeelding")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Write an image prompt for a robot")).toBe(false);
  });
});

describe("resolveMessengerSourceImageGenerationPrompt", () => {
  it("does not auto-restyle a photo-only upload", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "",
      }),
    ).toBeNull();
  });

  it("does not auto-restyle a whitespace-only upload", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "   ",
      }),
    ).toBeNull();
  });

  it("does not treat image analysis questions as generation prompts", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "What do you see in this photo?",
      }),
    ).toBeNull();
  });

  it("returns the trimmed prompt only for an explicit source-image edit", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "  Restyle deze foto als cinematic poster  ",
      }),
    ).toBe("Restyle deze foto als cinematic poster");
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: false,
        text: "Restyle deze foto",
      }),
    ).toBeNull();
  });
});

describe("shouldForwardMessengerImageOnlyEventToImageGen", () => {
  it("forwards photo-only uploads so image-gen can store the source image", () => {
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: true,
        text: "",
      }),
    ).toBe(true);
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: true,
        text: "   ",
      }),
    ).toBe(true);
  });

  it("keeps captioned images in the existing gateway routing unless explicitly generated", () => {
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: true,
        text: "What do you see in this photo?",
      }),
    ).toBe(false);
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: false,
        text: "",
      }),
    ).toBe(false);
  });
});

describe("sanitizeMessengerSourceImageUrl", () => {
  it("allows https Messenger media hosts", () => {
    expect(sanitizeMessengerSourceImageUrl("https://cdn.fbcdn.net/photo.jpg")).toBe(
      "https://cdn.fbcdn.net/photo.jpg",
    );
    expect(sanitizeMessengerSourceImageUrl("https://lookaside.fbsbx.com/photo.jpg")).toBe(
      "https://lookaside.fbsbx.com/photo.jpg",
    );
  });

  it("rejects non-https or non-Messenger media hosts", () => {
    expect(sanitizeMessengerSourceImageUrl("http://cdn.fbcdn.net/photo.jpg")).toBeNull();
    expect(sanitizeMessengerSourceImageUrl("https://example.test/photo.jpg")).toBeNull();
    expect(sanitizeMessengerSourceImageUrl("not a url")).toBeNull();
  });
});

describe("resolveMessengerFastLaneReply", () => {
  it("returns a direct reply for simple Messenger intents", () => {
    const result = resolveMessengerFastLaneReply("help");

    expect(result?.intent).toBe("help");
    expect(result?.reply).toContain("korte vragen");
  });

  it("returns the explicit image generator loading reply for image intents", () => {
    const result = resolveMessengerFastLaneReply("maak afbeelding van een robot");

    expect(result).toEqual({
      intent: "image",
      reply:
        "Ik heb je afbeeldingsvraag ontvangen. Ik start nu de image generator — dit kan even duren.",
    });
  });
});

describe("downloadMessengerMediaAttachment redirects", () => {
  function attachment(url = "https://lookaside.facebook.com/start"): Parameters<
    typeof downloadMessengerMediaAttachment
  >[0]["attachment"] {
    return { kind: "image", url };
  }

  function okImageResponse(): Response {
    return new Response(Buffer.from("fake-image"), {
      headers: {
        "content-length": "10",
        "content-type": "image/png",
      },
      status: 200,
    });
  }

  it("allows a manual redirect to https fbcdn.net media", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = url instanceof URL ? url.href : String(url);
      if (href === "https://lookaside.facebook.com/start") {
        return new Response(null, {
          headers: { location: "https://cdn.fbcdn.net/photo.png" },
          status: 302,
        });
      }
      if (href === "https://cdn.fbcdn.net/photo.png") {
        return okImageResponse();
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const media = await downloadMessengerMediaAttachment({
      attachment: attachment(),
      index: 0,
      reqId: "msg_redirect_allowed",
    });

    expect(media).toMatchObject({
      contentType: "image/png",
      kind: "image",
      url: "https://lookaside.facebook.com/start",
    });
    expect(media?.path).toMatch(/messenger-[a-f0-9]{32}\.png$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(new URL("https://cdn.fbcdn.net/photo.png"));
  });

  it("rejects a redirect to http media", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        headers: { location: "http://cdn.fbcdn.net/photo.png" },
        status: 302,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadMessengerMediaAttachment({
        attachment: attachment(),
        index: 0,
        reqId: "msg_redirect_http",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a non-Facebook media host", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        headers: { location: "https://example.test/photo.png" },
        status: 302,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadMessengerMediaAttachment({
        attachment: attachment(),
        index: 0,
        reqId: "msg_redirect_host",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect loops once the redirect limit is reached", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        headers: { location: "https://lookaside.facebook.com/start" },
        status: 302,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadMessengerMediaAttachment({
        attachment: attachment(),
        index: 0,
        reqId: "msg_redirect_loop",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
