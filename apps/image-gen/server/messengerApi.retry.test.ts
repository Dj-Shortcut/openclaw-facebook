import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendImage, sendText } from "./_core/messengerApi";
import { resetStateStore, setLastUserMessageAt } from "./_core/messengerState";

describe("messengerApi retries", () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const originalMaxRetries = process.env.GRAPH_API_MAX_RETRIES;
  const originalRetryBase = process.env.GRAPH_API_RETRY_BASE_MS;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    process.env.FB_PAGE_ACCESS_TOKEN = "test-token";
    process.env.GRAPH_API_MAX_RETRIES = "2";
    process.env.GRAPH_API_RETRY_BASE_MS = "1";
    process.env.PRIVACY_PEPPER = "ci-test-pepper";
    resetStateStore();
    setLastUserMessageAt("psid-1", Date.now());
  });

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalToken === undefined) {
      delete process.env.FB_PAGE_ACCESS_TOKEN;
    } else {
      process.env.FB_PAGE_ACCESS_TOKEN = originalToken;
    }

    if (originalMaxRetries === undefined) {
      delete process.env.GRAPH_API_MAX_RETRIES;
    } else {
      process.env.GRAPH_API_MAX_RETRIES = originalMaxRetries;
    }

    if (originalRetryBase === undefined) {
      delete process.env.GRAPH_API_RETRY_BASE_MS;
    } else {
      process.env.GRAPH_API_RETRY_BASE_MS = originalRetryBase;
    }

    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("retries 429 responses and succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      )
      .mockResolvedValueOnce(
        new Response("still limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    global.fetch = fetchMock;

    await sendText("psid-1", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/me/messages");
    expect(JSON.parse(String(request.body))).toMatchObject({
      messaging_type: "RESPONSE",
      recipient: { id: "psid-1" },
      message: { text: "hello" },
    });
  });

  it("throws after max retries", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response("rate limited", { status: 429 })
      );

    global.fetch = fetchMock;

    await expect(sendText("psid-1", "hello")).rejects.toThrow(
      "Messenger API error 429"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries image sends with bounded attempts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("fail-1", { status: 500 }))
      .mockResolvedValueOnce(new Response("fail-2", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    global.fetch = fetchMock;

    await sendImage("psid-1", "https://img.example/generated.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries transient network failures for image sends", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    global.fetch = fetchMock;

    await sendImage("psid-1", "https://img.example/generated.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not stack image retries on top of configured global retries", async () => {
    process.env.GRAPH_API_MAX_RETRIES = "10";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("fail-1", { status: 500 }))
      .mockResolvedValueOnce(new Response("fail-2", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    global.fetch = fetchMock;

    await sendImage("psid-1", "https://img.example/generated.jpg");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips outbound messages when the 24h Messenger response window is closed", async () => {
    const now = Date.now();
    setLastUserMessageAt("psid-1", now - 24 * 60 * 60 * 1000 - 1);

    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;

    await expect(sendText("psid-1", "hello")).resolves.toEqual({
      sent: false,
      reason: "response_window_closed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
