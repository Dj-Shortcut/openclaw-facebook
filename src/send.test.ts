import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessengerDeliveryError,
  sendMessengerSenderAction,
  sendMessengerText,
} from "./send.js";

describe("sendMessengerText", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends RESPONSE messages to the Page messages endpoint", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ message_id: "mid-1", recipient_id: "psid-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await sendMessengerText("psid-1", "hello", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v20.0/page-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(typeof init.body).toBe("string");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      recipient: { id: "psid-1" },
      messaging_type: "RESPONSE",
      message: { text: "hello" },
    });
    expect(result.messageId).toBe("mid-1");
    expect(result.receipt.platformMessageIds).toEqual(["mid-1"]);
  });

  it("sends conversational pills as Messenger quick replies", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ message_id: "mid-1", recipient_id: "psid-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendMessengerText("psid-1", "Hoe wil je verder?", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
      quickReplies: [
        { content_type: "text", title: "Scope bepalen", payload: "scope" },
        { content_type: "text", title: "Regels maken", payload: "rules" },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.message).toEqual({
      text: "Hoe wil je verder?",
      quick_replies: [
        { content_type: "text", title: "Scope bepalen", payload: "scope" },
        { content_type: "text", title: "Regels maken", payload: "rules" },
      ],
    });
  });

  it("normalizes public Facebook target prefixes before sending to Messenger", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ message_id: "mid-1", recipient_id: "psid-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendMessengerText("facebook:psid-1", "hello", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.recipient).toEqual({ id: "psid-1" });
  });

  it.each(["facebook:psid-1", "fb:psid-1", "messenger:psid-1", "fbm:psid-1"])(
    "normalizes target prefix %s before sending",
    async (target) => {
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response(JSON.stringify({ message_id: "mid-1", recipient_id: "psid-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      await sendMessengerText(target, "hello", {
        cfg: {
          channels: {
            facebook: {
              pageId: "page-1",
              pageAccessToken: "token-1",
              appSecret: "secret-1",
              verifyToken: "verify-1",
            },
          },
        } as never,
        fetch: fetchMock as never,
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.recipient).toEqual({ id: "psid-1" });
    },
  );

  it("maps 24-hour window errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "outside allowed window",
              code: 10,
              error_subcode: 2534022,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );

    const error = await sendMessengerText("psid-1", "hello", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MessengerDeliveryError);
    expect(error).toMatchObject({ outcome: "known_rejected" });
    expect(String(error)).toContain("24-hour response window");
  });

  it.each([
    { status: 429, expectedOutcome: "known_rejected" },
    { status: 500, expectedOutcome: "ambiguous" },
  ] as const)(
    "classifies Graph HTTP $status as $expectedOutcome",
    async ({ status, expectedOutcome }) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "provider response", code: status === 429 ? 4 : 2 },
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
      );

      const error = await sendMessengerText("psid-1", "hello", {
        cfg: {
          channels: {
            facebook: {
              pageId: "page-1",
              pageAccessToken: "token-1",
              appSecret: "secret-1",
              verifyToken: "verify-1",
            },
          },
        } as never,
        fetch: fetchMock as never,
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MessengerDeliveryError);
      expect(error).toMatchObject({ outcome: expectedOutcome });
    },
  );

  it("fails on malformed successful responses", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ recipient_id: "psid-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const error = await sendMessengerText("psid-1", "hello", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MessengerDeliveryError);
    expect(error).toMatchObject({ outcome: "ambiguous" });
    expect(String(error)).toContain(
      "response did not include message_id and recipient_id",
    );
  });

  it("classifies a socket reset after POST as ambiguous", async () => {
    const socketError = new Error("socket reset");
    const error = await sendMessengerText("psid-1", "hello", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: vi.fn(async () => {
        throw socketError;
      }) as never,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MessengerDeliveryError);
    expect(error).toMatchObject({ outcome: "ambiguous", cause: socketError });
  });


  it("truncates outgoing text to Messenger's 2000 character limit", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ message_id: "mid-1", recipient_id: "psid-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendMessengerText("psid-1", "x".repeat(2500), {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.message.text).toHaveLength(2000);
  });

  it("aborts stalled Graph API sends", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const result = sendMessengerText("psid-1", "hello", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    });

    const expectedFailure = result.catch((thrown: unknown) => thrown);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await expectedFailure;
    expect(error).toBeInstanceOf(MessengerDeliveryError);
    expect(error).toMatchObject({ outcome: "ambiguous" });
    expect(String(error)).toContain("Messenger send failed");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });
});

describe("sendMessengerSenderAction", () => {
  it("sends Messenger sender actions to the Page messages endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ recipient_id: "psid-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await sendMessengerSenderAction("psid-1", "typing_on", {
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
        },
      } as never,
      fetch: fetchMock as never,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.facebook.com/v20.0/page-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer token-1",
          "Content-Type": "application/json",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      recipient: { id: "psid-1" },
      sender_action: "typing_on",
    });
  });
});
