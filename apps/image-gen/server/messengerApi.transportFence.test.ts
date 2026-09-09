import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  markStarted: vi.fn(),
  finalize: vi.fn(),
  getConnection: vi.fn(),
  assertPrivacy: vi.fn(),
  assertErasureControl: vi.fn(),
}));

vi.mock("./db", () => ({
  getConnectedFacebookPageConnection: mocks.getConnection,
}));
vi.mock("./_core/facebookPageToken", () => ({
  unsealFacebookPageToken: vi.fn(() => "tenant-secret-token"),
}));
vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: mocks.assertPrivacy,
  assertMessengerErasureControlDelivery: mocks.assertErasureControl,
}));
vi.mock("./_core/messengerProviderAttemptFence", () => ({
  claimMessengerProviderAttemptFence: mocks.claim,
  markMessengerProviderAttemptStarted: mocks.markStarted,
  finalizeMessengerProviderAttemptFence: mocks.finalize,
}));
vi.mock("./_core/messengerState", () => ({
  hasOpenMessengerResponseWindow: vi.fn(async () => true),
}));

import { sendText } from "./_core/messengerApi";
import {
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";

describe("Messenger Graph durable transport fence", () => {
  const originalFetch = global.fetch;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalGraphApiRequestTimeoutMs =
    process.env.GRAPH_API_REQUEST_TIMEOUT_MS;
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
    mocks.claim.mockReset().mockResolvedValue({
      kind: "owned",
      fence: {
        leaseToken: "lease-1",
        attemptKeyHash: "hash-1",
        workspaceId: 41,
        channelConnectionId: 17,
        bindingEpoch: 3,
        pageId: "page-1",
        userKey: toUserKey("psid-fenced"),
        privacyEpoch: 6,
      },
    });
    mocks.markStarted.mockReset().mockResolvedValue(undefined);
    mocks.finalize.mockReset().mockResolvedValue(undefined);
    mocks.assertPrivacy.mockReset().mockResolvedValue(undefined);
    mocks.assertErasureControl.mockReset().mockResolvedValue(undefined);
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
    if (originalGraphApiRequestTimeoutMs === undefined) {
      delete process.env.GRAPH_API_REQUEST_TIMEOUT_MS;
    } else {
      process.env.GRAPH_API_REQUEST_TIMEOUT_MS =
        originalGraphApiRequestTimeoutMs;
    }
  });

  it("marks started at the fetch boundary and completes exactly once", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));

    await expect(sendText("psid-fenced", "hello", options())).resolves.toEqual({
      sent: true,
    });

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.any(Object),
      "messenger-graph-send",
      1,
      expect.any(Date),
      { takeOverReserved: true }
    );
    expect(mocks.markStarted).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "succeeded"
    );
  });

  it("marks a lost success marker ambiguous so callers never resend", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    mocks.finalize.mockRejectedValueOnce(
      new Error("provider success marker unavailable")
    );

    const error = await sendText("psid-fenced", "hello", options()).catch(
      caught => caught
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "provider success marker unavailable",
      messengerDeliveryAmbiguous: true,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the narrowly scoped erasure-control privacy assertion", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));

    await runWithMessengerRequestContext(
      "page-1",
      () =>
        runWithMessengerErasureControlDelivery(() =>
          sendText("psid-fenced", "deletion outcome", options())
        ),
      {
        workspaceId: 41,
        channelConnectionId: 17,
        bindingEpoch: 3,
        userKey: toUserKey("psid-fenced"),
        privacyEpoch: 6,
      }
    );

    expect(mocks.assertErasureControl).toHaveBeenCalled();
    expect(mocks.assertPrivacy).not.toHaveBeenCalled();
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

  it("blocks before fetch when the privacy/start fence is lost", async () => {
    mocks.markStarted.mockRejectedValueOnce(new Error("privacy contained"));
    global.fetch = vi.fn();

    const error = await sendText("psid-fenced", "hello", options()).catch(
      caught => caught
    );

    expect(error).toMatchObject({ message: "privacy contained" });
    expect(error).not.toHaveProperty("messengerDeliveryAmbiguous");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("recovers a still-reserved attempt after a crash before provider start", async () => {
    mocks.markStarted
      .mockRejectedValueOnce(new Error("crash before provider start"))
      .mockResolvedValueOnce(undefined);
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));

    await expect(sendText("psid-fenced", "hello", options())).rejects.toThrow(
      "crash before provider start"
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();

    await expect(sendText("psid-fenced", "hello", options())).resolves.toEqual({
      sent: true,
    });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "succeeded"
    );
  });

  it("never fetches again for a provider-started or ambiguous attempt", async () => {
    global.fetch = vi.fn();
    for (const status of ["started", "ambiguous"] as const) {
      mocks.claim.mockResolvedValueOnce({ kind: "unsafe_or_done", status });
      const error = await sendText("psid-fenced", "hello", options()).catch(
        caught => caught
      );
      expect(error).toMatchObject({ messengerDeliveryAmbiguous: true });
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.markStarted).not.toHaveBeenCalled();
  });

  it("treats an already-succeeded attempt as an idempotent success", async () => {
    mocks.claim.mockResolvedValueOnce({
      kind: "unsafe_or_done",
      status: "succeeded",
    });
    global.fetch = vi.fn();

    await expect(sendText("psid-fenced", "hello", options())).resolves.toEqual({
      sent: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps one notice attempt id stable when its live balance text changes", async () => {
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const firstOptions = {
      ...options(),
      providerAttemptKey: "generation-success-notice-v1",
    };
    await sendText("psid-fenced", "Today 4 of 5", firstOptions);
    await sendText("psid-fenced", "Today 3 of 5", firstOptions);

    const firstJob = mocks.claim.mock.calls[0]?.[0];
    const secondJob = mocks.claim.mock.calls[1]?.[0];
    expect(firstJob.reqId).toBe(secondJob.reqId);
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

  it("aborts and fences a stalled Graph request at the configured deadline", async () => {
    vi.useFakeTimers();
    process.env.GRAPH_API_REQUEST_TIMEOUT_MS = "25";
    let requestSignal: AbortSignal | undefined;
    global.fetch = vi.fn(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>(() => undefined);
    });

    const rejection = expect(
      sendText("psid-fenced", "hello", options())
    ).rejects.toThrow("Messenger Graph request timed out after 25ms");
    await vi.advanceTimersByTimeAsync(26);
    await rejection;

    expect(requestSignal?.aborted).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: "lease-1" }),
      "ambiguous"
    );
  });
});
