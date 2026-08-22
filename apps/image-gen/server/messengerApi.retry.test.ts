import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getConnectedFacebookPageConnectionMock } = vi.hoisted(() => ({
  getConnectedFacebookPageConnectionMock: vi.fn(),
}));

vi.mock("./db", () => ({
  getConnectedFacebookPageConnection: getConnectedFacebookPageConnectionMock,
}));

import {
  sendButtonTemplate,
  sendImage,
  sendText,
  sendVideo,
} from "./_core/messengerApi";
import { sealFacebookPageToken } from "./_core/facebookConnectStore";
import {
  getOrCreateState,
  resetStateStore,
  setLastUserMessageAt,
  setMessengerPageId,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";

describe("messengerApi retries", () => {
  const originalFetch = global.fetch;
  const originalToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const originalMaxRetries = process.env.GRAPH_API_MAX_RETRIES;
  const originalRetryBase = process.env.GRAPH_API_RETRY_BASE_MS;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.FB_PAGE_ACCESS_TOKEN = "test-token";
    process.env.GRAPH_API_MAX_RETRIES = "2";
    process.env.GRAPH_API_RETRY_BASE_MS = "1";
    process.env.PRIVACY_PEPPER = "ci-test-pepper";
    process.env.JWT_SECRET = "messenger-api-tenant-token-test-secret";
    getConnectedFacebookPageConnectionMock.mockReset();
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

    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
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

  it("uses explicit Page state for an out-of-context response-window check", async () => {
    const psid = "page-scoped-psid";
    const now = Date.now();
    await runWithMessengerRequestContext("page-a", async () => {
      await getOrCreateState(psid);
      await setMessengerPageId(psid, "page-a", now);
      await setLastUserMessageAt(psid, now);
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    global.fetch = fetchMock;
    getConnectedFacebookPageConnectionMock.mockResolvedValue({
      workspaceId: 7,
      encryptedAccessToken: sealFacebookPageToken("tenant-page-token"),
    });

    await expect(
      sendText(psid, "hello", { pageId: "page-a" })
    ).resolves.toEqual({ sent: true });
    await expect(
      sendText(psid, "hello", { pageId: "page-b" })
    ).resolves.toEqual({
      sent: false,
      reason: "response_window_closed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("selects the exact tenant Page credential at the transport boundary", async () => {
    const psid = "tenant-token-psid";
    const now = Date.now();
    await runWithMessengerRequestContext("page-tenant", async () => {
      await getOrCreateState(psid);
      await setMessengerPageId(psid, "page-tenant", now);
      await setLastUserMessageAt(psid, now);
    });
    getConnectedFacebookPageConnectionMock.mockResolvedValue({
      id: 19,
      workspaceId: 71,
      bindingEpoch: 4,
      encryptedAccessToken: sealFacebookPageToken("exact-tenant-token"),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    global.fetch = fetchMock;

    await expect(
      sendText(psid, "handoff", {
        pageId: "page-tenant",
        workspaceId: 71,
        channelConnectionId: 19,
        bindingEpoch: 4,
      })
    ).resolves.toEqual({ sent: true });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("exact-tenant-token");
    expect(url).not.toContain("access_token");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer exact-tenant-token",
    });
    expect(getConnectedFacebookPageConnectionMock).toHaveBeenCalledWith(
      "page-tenant",
      { workspaceId: 71, channelConnectionId: 19, bindingEpoch: 4 }
    );
  });

  it("fails closed before transport on a workspace/Page credential mismatch", async () => {
    const psid = "tenant-mismatch-psid";
    const now = Date.now();
    await runWithMessengerRequestContext("page-tenant", async () => {
      await getOrCreateState(psid);
      await setMessengerPageId(psid, "page-tenant", now);
      await setLastUserMessageAt(psid, now);
    });
    getConnectedFacebookPageConnectionMock.mockResolvedValue(null);
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;

    await expect(
      sendText(psid, "handoff", {
        pageId: "page-tenant",
        workspaceId: 71,
        channelConnectionId: 19,
        bindingEpoch: 4,
      })
    ).rejects.toThrow("credential binding is unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a recipient that does not hash to the fenced privacy subject", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;

    await expect(
      sendText("recipient-b", "must not send", {
        pageId: "page-tenant",
        workspaceId: 71,
        channelConnectionId: 19,
        bindingEpoch: 4,
        userKey: toUserKey("recipient-a"),
        privacyEpoch: 2,
      })
    ).rejects.toThrow("recipient does not match privacy subject");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getConnectedFacebookPageConnectionMock).not.toHaveBeenCalled();
  });

  it("selects separate tenant Bearer tokens for parallel normal replies", async () => {
    const now = Date.now();
    for (const [psid, pageId] of [
      ["user-a", "page-a"],
      ["user-b", "page-b"],
    ] as const) {
      await runWithMessengerRequestContext(pageId, async () => {
        await getOrCreateState(psid);
        await setMessengerPageId(psid, pageId, now);
        await setLastUserMessageAt(psid, now);
      });
    }
    getConnectedFacebookPageConnectionMock.mockImplementation(async pageId => ({
      workspaceId: pageId === "page-a" ? 1 : 2,
      encryptedAccessToken: sealFacebookPageToken(`token-${pageId}`),
    }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    global.fetch = fetchMock;

    await Promise.all([
      runWithMessengerRequestContext("page-a", () => sendText("user-a", "a")),
      runWithMessengerRequestContext("page-b", () => sendText("user-b", "b")),
    ]);

    const auth = fetchMock.mock.calls.map(
      ([, request]) =>
        (request?.headers as Record<string, string>).Authorization
    );
    expect(auth).toEqual(
      expect.arrayContaining(["Bearer token-page-a", "Bearer token-page-b"])
    );
    expect(
      fetchMock.mock.calls.map(([url]) => String(url)).join(" ")
    ).not.toContain("token-page");
  });

  it("rejects an explicit background Page that conflicts with verified request context", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;
    await expect(
      runWithMessengerRequestContext("page-a", () =>
        sendText("psid-1", "hello", { pageId: "page-b" })
      )
    ).rejects.toThrow("does not match");
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("sends Messenger video attachment payloads", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    global.fetch = fetchMock;

    await sendVideo("psid-1", "https://cdn.example/generated-video.mp4");

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      messaging_type: "RESPONSE",
      recipient: { id: "psid-1" },
      message: {
        attachment: {
          type: "video",
          payload: {
            url: "https://cdn.example/generated-video.mp4",
            is_reusable: false,
          },
        },
      },
    });
  });

  it("limits button-template text to 640 Unicode code points", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    global.fetch = fetchMock;
    const expectedText = `${"a".repeat(639)}😀`;

    await sendButtonTemplate("psid-1", `${expectedText}trailing`, [
      {
        type: "web_url",
        title: "Open",
        url: "https://leaderbot.live",
      },
    ]);

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(body.message.attachment.payload.text).toBe(expectedText);
    expect(Array.from(body.message.attachment.payload.text)).toHaveLength(640);
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
