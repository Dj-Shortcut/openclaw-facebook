import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  markStarted: vi.fn(),
  finalize: vi.fn(),
  getConnection: vi.fn(),
  assertPrivacy: vi.fn(),
}));

vi.mock("./db", () => ({
  getConnectedFacebookPageConnection: mocks.getConnection,
}));
vi.mock("./_core/facebookConnectStore", () => ({
  unsealFacebookPageToken: vi.fn(() => "tenant-secret-token"),
}));
vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: mocks.assertPrivacy,
}));
vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence: mocks.reserve,
  markMessengerProviderAttemptStarted: mocks.markStarted,
  finalizeMessengerProviderAttemptFence: mocks.finalize,
}));
vi.mock("./_core/messengerState", () => ({
  hasOpenMessengerResponseWindow: vi.fn(async () => true),
}));

import { sendText } from "./_core/messengerApi";
import { toUserKey } from "./_core/privacy";

describe("Messenger Graph durable transport fence", () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalGraphTimeout = process.env.GRAPH_API_TIMEOUT_MS;
  const options = () => ({
    pageId: "page-1",
    workspaceId: 41,
    channelConnectionId: 17,
    bindingEpoch: 3,
    userKey: toUserKey("psid-fenced"),
    privacyEpoch: 6,
    operationId: "req-fenced",
  });

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.PRIVACY_PEPPER = "transport-fence-test-pepper";
    mocks.reserve.mockReset().mockResolvedValue({
      leaseToken: "lease-1",
      attemptKeyHash: "hash-1",
      workspaceId: 41,
      channelConnectionId: 17,
      userKey: toUserKey("psid-fenced"),
      privacyEpoch: 6,
    });
    mocks.markStarted.mockReset().mockResolvedValue(undefined);
    mocks.finalize.mockReset().mockResolvedValue(undefined);
    mocks.assertPrivacy.mockReset().mockResolvedValue(undefined);
    mocks.getConnection.mockReset().mockResolvedValue({
      id: 17,
      workspaceId: 41,
      bindingEpoch: 3,
      encryptedAccessToken: "sealed",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    if (originalGraphTimeout === undefined) {
      delete process.env.GRAPH_API_TIMEOUT_MS;
    } else {
      process.env.GRAPH_API_TIMEOUT_MS = originalGraphTimeout;
    }
  });

  it("marks started at the fetch boundary and completes exactly once", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));

    await expect(sendText("psid-fenced", "hello", options())).resolves.toEqual({
      sent: true,
    });

    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.markStarted).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "succeeded"
    );
  });

  it("does not retry a response-loss after transport started", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("connection reset");
    });

    await expect(sendText("psid-fenced", "hello", options())).rejects.toThrow(
      "connection reset"
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "ambiguous"
    );
  });

  it("aborts a stalled Graph transport and keeps the outcome ambiguous", async () => {
    vi.useFakeTimers();
    process.env.GRAPH_API_TIMEOUT_MS = "25";
    global.fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    );

    const sending = expect(
      sendText("psid-fenced", "hello", options())
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(25);

    await sending;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "ambiguous"
    );
  });

  it("blocks before fetch when the privacy/start fence is lost", async () => {
    mocks.markStarted.mockRejectedValueOnce(new Error("privacy contained"));
    global.fetch = vi.fn();

    await expect(sendText("psid-fenced", "hello", options())).rejects.toThrow(
      "privacy contained"
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "known_failed"
    );
  });

  it("treats a provider 5xx as ambiguous and never retries", async () => {
    global.fetch = vi.fn(async () => new Response("unknown", { status: 503 }));

    await expect(sendText("psid-fenced", "hello", options())).rejects.toThrow(
      "ambiguous error 503"
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "ambiguous"
    );
  });
});
