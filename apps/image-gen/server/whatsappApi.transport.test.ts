import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  claimErasure: vi.fn(),
  reserveFence: vi.fn(),
  markFence: vi.fn(),
  finalizeFence: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("./_core/whatsappTransportCredential", () => {
  class WhatsAppTransportBindingError extends Error {
    constructor() {
      super("WhatsApp transport binding is unavailable");
      this.name = "WhatsAppTransportBindingError";
    }
  }
  return {
    resolveWhatsAppTransportCredential: mocks.resolveCredential,
    WhatsAppTransportBindingError,
  };
});

vi.mock("./_core/whatsappProviderAttemptFence", () => ({
  claimWhatsAppErasureControlProviderAttempt: mocks.claimErasure,
  reserveWhatsAppProviderAttemptFence: mocks.reserveFence,
  markWhatsAppProviderAttemptStarted: mocks.markFence,
  finalizeWhatsAppProviderAttemptFence: mocks.finalizeFence,
}));

vi.mock("./_core/logger", () => ({
  createLogger: () => ({ error: mocks.loggerError }),
}));

import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";
import {
  downloadWhatsAppMedia,
  sendWhatsAppImageWithReceipt,
  sendWhatsAppText,
  WhatsAppDeliveryError,
} from "./_core/whatsappApi";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

type TestScope = {
  phoneNumberId: string;
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  senderId: string;
  privacyEpoch: number;
  token: string;
};

const TENANT_A: TestScope = {
  phoneNumberId: "404040404040404",
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  senderId: "32470000001",
  privacyEpoch: 2,
  token: "tenant-token-a-never-log",
};

const TENANT_B: TestScope = {
  phoneNumberId: "707070707070707",
  workspaceId: 99,
  channelConnectionId: 18,
  bindingEpoch: 7,
  senderId: "32470000002",
  privacyEpoch: 5,
  token: "tenant-token-b-never-log",
};

async function withScope<T>(
  scope: TestScope,
  action: () => Promise<T>
): Promise<T> {
  return await runWithMessengerRequestContext(
    scope.phoneNumberId,
    async () => {
      setMessengerRequestPrivacySubject({
        userKey: toUserKey(scope.senderId),
        privacyEpoch: scope.privacyEpoch,
      });
      return await action();
    },
    {
      channel: "whatsapp",
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      bindingEpoch: scope.bindingEpoch,
    }
  );
}

function installExactCredentialResolver(): void {
  const scopes = new Map([
    [TENANT_A.phoneNumberId, TENANT_A],
    [TENANT_B.phoneNumberId, TENANT_B],
  ]);
  mocks.resolveCredential.mockImplementation(async () => {
    const phoneNumberId = getMessengerRequestPageId();
    const ownership = getMessengerRequestOwnership();
    const scope = phoneNumberId ? scopes.get(phoneNumberId) : undefined;
    if (
      !scope ||
      ownership?.workspaceId !== scope.workspaceId ||
      ownership.channelConnectionId !== scope.channelConnectionId ||
      ownership.bindingEpoch !== scope.bindingEpoch
    ) {
      throw new Error("test transport scope mismatch");
    }
    return {
      accessToken: scope.token,
      phoneNumberId: scope.phoneNumberId,
      userKey: toUserKey(scope.senderId),
    };
  });
}

describe("WhatsApp Graph tenant transport boundary", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "whatsapp-transport-test-pepper";
    mocks.reserveFence.mockResolvedValue({
      leaseToken: "transport-lease",
      attemptKeyHash: "a".repeat(64),
    });
    mocks.claimErasure.mockResolvedValue({
      kind: "owned",
      fence: {
        leaseToken: "erasure-transport-lease",
        attemptKeyHash: "e".repeat(64),
      },
    });
    mocks.markFence.mockResolvedValue(undefined);
    mocks.finalizeFence.mockResolvedValue(undefined);
    installExactCredentialResolver();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.WHATSAPP_GRAPH_SEND_TIMEOUT_MS;
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("uses each parallel tenant's own phone endpoint and Bearer credential", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      withScope(TENANT_A, () => sendWhatsAppText(TENANT_A.senderId, "reply A")),
      withScope(TENANT_B, () => sendWhatsAppText(TENANT_B.senderId, "reply B")),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const scope of [TENANT_A, TENANT_B]) {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).includes(`/${scope.phoneNumberId}/messages`)
      );
      expect(call).toBeDefined();
      expect(String(call?.[0])).not.toContain(scope.token);
      expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${scope.token}`
      );
      expect(call?.[1]?.redirect).toBe("error");
      expect(String(call?.[1]?.body)).toContain(scope.senderId);
    }
  });

  it("rejects a recipient outside the active privacy subject before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withScope(TENANT_A, () => sendWhatsAppText(TENANT_B.senderId, "wrong"))
    ).rejects.toMatchObject({ name: "WhatsAppTransportBindingError" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when deletion or rebind wins immediately before Graph transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    mocks.markFence.mockRejectedValueOnce(
      new Error("WhatsApp provider privacy changed")
    );

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppText(TENANT_A.senderId, "must not leave")
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "pre_transport",
      attemptKeyHash: "a".repeat(64),
    });

    expect(mocks.reserveFence).toHaveBeenCalledOnce();
    expect(mocks.markFence).toHaveBeenCalledOnce();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a stable accepted image receipt for the supplied operation id", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/result.png",
          "generation-operation-1"
        )
      )
    ).resolves.toEqual({
      outcome: "accepted",
      attemptKeyHash: "a".repeat(64),
    });
    expect(mocks.reserveFence).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: "generation-operation-1" })
    );
  });

  it("classifies image credential rejection as pre-transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveCredential.mockRejectedValueOnce(
      new Error("credential binding changed")
    );

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/result.png",
          "generation-credential-reject"
        )
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "pre_transport",
      attemptKeyHash: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.reserveFence).not.toHaveBeenCalled();
  });

  it.each([
    [400, "known_rejected"],
    [429, "ambiguous"],
    [503, "ambiguous"],
  ] as const)(
    "classifies Graph %i without exposing the response body",
    async (status, outcome) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("sensitive", { status }))
      );

      const delivery = withScope(TENANT_A, () =>
        sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/result.png",
          `generation-${status}`
        )
      );
      await expect(delivery).rejects.toBeInstanceOf(WhatsAppDeliveryError);
      await expect(delivery).rejects.toMatchObject({ outcome });
      expect(mocks.finalizeFence).toHaveBeenCalledWith(
        expect.any(Object),
        outcome === "known_rejected" ? "known_failed" : "ambiguous"
      );
    }
  );

  it("classifies a transport reset as ambiguous and never retries fetch", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("socket reset"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/result.png",
          "generation-reset"
        )
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "ambiguous",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "ambiguous"
    );
  });

  it("bounds a hanging Graph send after the durable transport fence starts", async () => {
    vi.useFakeTimers();
    process.env.WHATSAPP_GRAPH_SEND_TIMEOUT_MS = "25";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const delivery = withScope(TENANT_A, () =>
      sendWhatsAppImageWithReceipt(
        TENANT_A.senderId,
        "https://assets.example/result.png",
        "generation-timeout"
      )
    );
    const rejected = expect(delivery).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "ambiguous",
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.markFence).toHaveBeenCalledBefore(fetchMock);
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "ambiguous"
    );
  });

  it("revalidates the tenant credential for metadata and media bytes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/file",
            mime_type: "image/jpeg",
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("image"), {
          headers: { "content-type": "image/jpeg" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withScope(TENANT_A, () => downloadWhatsAppMedia("media-a"))
    ).resolves.toMatchObject({ contentType: "image/jpeg" });

    expect(mocks.resolveCredential).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${TENANT_A.token}`
      );
    }
  });

  it("never forwards a tenant Bearer token to an untrusted media host", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: "https://attacker.invalid/whatsapp-media",
          mime_type: "image/jpeg",
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      withScope(TENANT_A, () => downloadWhatsAppMedia("media-a"))
    ).rejects.toThrow("WhatsApp media URL is invalid");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(TENANT_A.token);
  });

  it("redacts provider response bodies from logs and errors", async () => {
    const sensitiveBody = `${TENANT_A.token}:${TENANT_A.senderId}`;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(sensitiveBody, {
          status: 400,
          statusText: sensitiveBody,
        })
      )
    );

    const result = withScope(TENANT_A, () =>
      sendWhatsAppText(TENANT_A.senderId, "reply")
    );
    await expect(result).rejects.not.toThrow(TENANT_A.token);
    await expect(result).rejects.not.toThrow(TENANT_A.senderId);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      TENANT_A.token
    );
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      TENANT_A.senderId
    );
    expect(mocks.loggerError).toHaveBeenCalledWith({
      event: "whatsapp_send_failed",
      status: 400,
    });
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
  });
});
