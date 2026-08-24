import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";

const mocks = vi.hoisted(() => ({
  resolveCredential: vi.fn(),
  claimErasure: vi.fn(),
  claimDelivery: vi.fn(),
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
  claimWhatsAppDeliveryProviderAttemptFence: mocks.claimDelivery,
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
  sendWhatsAppErasureControlText,
  sendWhatsAppButtons,
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
    mocks.claimDelivery.mockResolvedValue({
      kind: "owned",
      fence: {
        leaseToken: "transport-lease",
        attemptKeyHash: "a".repeat(64),
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
      withScope(TENANT_A, () =>
        sendWhatsAppText(TENANT_A.senderId, "reply A", "parallel-reply")
      ),
      withScope(TENANT_B, () =>
        sendWhatsAppText(TENANT_B.senderId, "reply B", "parallel-reply")
      ),
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
      withScope(TENANT_A, () =>
        sendWhatsAppText(TENANT_B.senderId, "wrong", "wrong-recipient")
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "pre_transport",
    });

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
        sendWhatsAppText(TENANT_A.senderId, "must not leave", "privacy-race")
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "pre_transport",
      attemptKeyHash: "a".repeat(64),
    });

    expect(mocks.claimDelivery).toHaveBeenCalledOnce();
    expect(mocks.markFence).toHaveBeenCalledOnce();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a recovered reservation fence the crashed owner before one Graph POST", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const staleFence = {
      leaseToken: "stale-reservation-owner",
      attemptKeyHash: "7".repeat(64),
    };
    const recoveryFence = {
      leaseToken: "recovered-reservation-owner",
      attemptKeyHash: "7".repeat(64),
    };
    mocks.claimDelivery
      .mockResolvedValueOnce({ kind: "owned", fence: staleFence })
      .mockResolvedValueOnce({ kind: "owned", fence: recoveryFence });

    let rejectStaleStart: ((error: unknown) => void) | undefined;
    mocks.markFence
      .mockImplementationOnce(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectStaleStart = reject;
          })
      )
      .mockResolvedValueOnce(undefined);

    const staleDelivery = withScope(TENANT_A, () =>
      sendWhatsAppText(
        TENANT_A.senderId,
        "stale owner reply",
        "reserved-recovery-operation"
      )
    );
    const staleOutcome = expect(staleDelivery).rejects.toMatchObject({
      outcome: "pre_transport",
      attemptKeyHash: "7".repeat(64),
    });
    await vi.waitFor(() => expect(rejectStaleStart).toBeTypeOf("function"));

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppText(
          TENANT_A.senderId,
          "recovered owner reply",
          "reserved-recovery-operation"
        )
      )
    ).resolves.toBeUndefined();
    rejectStaleStart?.(new Error("provider attempt ownership was lost"));
    await staleOutcome;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
      "recovered owner reply"
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(
      "stale owner reply"
    );
    const requestIds = mocks.claimDelivery.mock.calls.map(
      call => (call[0] as { reqId: string }).reqId
    );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
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
    expect(mocks.claimDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "generation-operation-1",
        providerOperation: "whatsapp_graph_image",
      })
    );
  });

  it("replays a succeeded image operation as accepted without a second POST", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);
    mocks.claimDelivery
      .mockResolvedValueOnce({
        kind: "owned",
        fence: {
          leaseToken: "image-success-lease",
          attemptKeyHash: "b".repeat(64),
        },
      })
      .mockResolvedValueOnce({
        kind: "succeeded",
        attemptKeyHash: "b".repeat(64),
      });

    const send = (imageUrl: string) =>
      withScope(TENANT_A, () =>
        sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          imageUrl,
          "generation-operation-replay"
        )
      );
    await expect(send("https://assets.example/first.png")).resolves.toEqual({
      outcome: "accepted",
      attemptKeyHash: "b".repeat(64),
    });
    await expect(send("https://assets.example/changed.png")).resolves.toEqual({
      outcome: "accepted",
      attemptKeyHash: "b".repeat(64),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps an accepted image ambiguous after finalize loss without a second POST", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);
    mocks.finalizeFence.mockRejectedValueOnce(
      new Error("provider outcome persistence failed")
    );
    mocks.claimDelivery
      .mockResolvedValueOnce({
        kind: "owned",
        fence: {
          leaseToken: "image-ambiguous-lease",
          attemptKeyHash: "c".repeat(64),
        },
      })
      .mockResolvedValueOnce({
        kind: "ambiguous",
        attemptKeyHash: "c".repeat(64),
      });

    const send = () =>
      withScope(TENANT_A, () =>
        sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/ambiguous.png",
          "generation-operation-ambiguous"
        )
      );
    await expect(send()).rejects.toMatchObject({
      outcome: "ambiguous",
      attemptKeyHash: "c".repeat(64),
    });
    await expect(send()).rejects.toMatchObject({
      outcome: "ambiguous",
      attemptKeyHash: "c".repeat(64),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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
      attemptKeyHash: "a".repeat(64),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.claimDelivery).toHaveBeenCalledOnce();
    expect(mocks.markFence).not.toHaveBeenCalled();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
  });

  it.each(["text", "image"] as const)(
    "recognizes an already-succeeded %s operation before credential lookup",
    async kind => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      mocks.claimDelivery.mockResolvedValueOnce({
        kind: "succeeded",
        attemptKeyHash: "d".repeat(64),
      });
      mocks.resolveCredential.mockRejectedValue(
        new Error("credential store unavailable")
      );

      const delivery = withScope(TENANT_A, async () => {
        if (kind === "text") {
          return await sendWhatsAppText(
            TENANT_A.senderId,
            "already delivered",
            "credential-independent-replay"
          );
        }
        return await sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/already-delivered.png",
          "credential-independent-replay"
        );
      });

      if (kind === "text") {
        await expect(delivery).resolves.toBeUndefined();
      } else {
        await expect(delivery).resolves.toEqual({
          outcome: "accepted",
          attemptKeyHash: "d".repeat(64),
        });
      }
      expect(mocks.resolveCredential).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["text", "image"] as const)(
    "recognizes an ambiguous %s operation before credential lookup",
    async kind => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);
      mocks.claimDelivery.mockResolvedValueOnce({
        kind: "ambiguous",
        attemptKeyHash: "f".repeat(64),
      });
      mocks.resolveCredential.mockRejectedValue(
        new Error("credential store unavailable")
      );

      const delivery = withScope(TENANT_A, async () => {
        if (kind === "text") {
          return await sendWhatsAppText(
            TENANT_A.senderId,
            "outcome unknown",
            "credential-independent-ambiguous"
          );
        }
        return await sendWhatsAppImageWithReceipt(
          TENANT_A.senderId,
          "https://assets.example/outcome-unknown.png",
          "credential-independent-ambiguous"
        );
      });

      await expect(delivery).rejects.toMatchObject({
        name: "WhatsAppDeliveryError",
        outcome: "ambiguous",
        attemptKeyHash: "f".repeat(64),
      });
      expect(mocks.resolveCredential).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

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

  it("preserves an ambiguous text response instead of throwing a plain error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("sensitive", { status: 503 }))
    );

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppText(TENANT_A.senderId, "reply", "ambiguous-text")
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "ambiguous",
      attemptKeyHash: "a".repeat(64),
    });
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "ambiguous"
    );
  });

  it.each(["text", "buttons"] as const)(
    "reuses a succeeded %s operation without a second Graph POST",
    async kind => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
      vi.stubGlobal("fetch", fetchMock);
      mocks.claimDelivery
        .mockResolvedValueOnce({
          kind: "owned",
          fence: {
            leaseToken: "stable-transport-lease",
            attemptKeyHash: "b".repeat(64),
          },
        })
        .mockResolvedValueOnce({
          kind: "succeeded",
          attemptKeyHash: "b".repeat(64),
        });
      const send = (changed: boolean) =>
        withScope(TENANT_A, () =>
          kind === "text"
            ? sendWhatsAppText(
                TENANT_A.senderId,
                changed ? "changed localized response" : "stable response",
                "stable-response-slot"
              )
            : sendWhatsAppButtons(
                TENANT_A.senderId,
                changed ? "changed localized response" : "stable response",
                [
                  changed
                    ? { id: "retry", title: "Retry" }
                    : { id: "continue", title: "Continue" },
                ],
                "stable-response-slot"
              )
        );

      await expect(send(false)).resolves.toBeUndefined();
      await expect(send(true)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledOnce();
      const requestIds = mocks.claimDelivery.mock.calls.map(
        call => (call[0] as { reqId: string }).reqId
      );
      expect(requestIds).toHaveLength(2);
      expect(requestIds[0]).toBe(requestIds[1]);
    }
  );

  it.each(["text", "buttons"] as const)(
    "keeps an ambiguous %s operation ambiguous without a second Graph POST",
    async kind => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("sensitive", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      mocks.claimDelivery
        .mockResolvedValueOnce({
          kind: "owned",
          fence: {
            leaseToken: "ambiguous-transport-lease",
            attemptKeyHash: "c".repeat(64),
          },
        })
        .mockResolvedValueOnce({
          kind: "ambiguous",
          attemptKeyHash: "c".repeat(64),
        });
      const send = (changed: boolean) =>
        withScope(TENANT_A, () =>
          kind === "text"
            ? sendWhatsAppText(
                TENANT_A.senderId,
                changed ? "changed after ambiguity" : "ambiguous response",
                "ambiguous-response-slot"
              )
            : sendWhatsAppButtons(
                TENANT_A.senderId,
                changed ? "changed after ambiguity" : "ambiguous response",
                [
                  changed
                    ? { id: "cancel", title: "Cancel" }
                    : { id: "continue", title: "Continue" },
                ],
                "ambiguous-response-slot"
              )
        );

      await expect(send(false)).rejects.toMatchObject({ outcome: "ambiguous" });
      await expect(send(true)).rejects.toMatchObject({ outcome: "ambiguous" });

      expect(fetchMock).toHaveBeenCalledOnce();
      const requestIds = mocks.claimDelivery.mock.calls.map(
        call => (call[0] as { reqId: string }).reqId
      );
      expect(requestIds[0]).toBe(requestIds[1]);
    }
  );

  it("keeps identical text in distinct logical response slots separate", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ messages: [] })));
    vi.stubGlobal("fetch", fetchMock);

    await withScope(TENANT_A, () =>
      sendWhatsAppText(TENANT_A.senderId, "same text", "response-slot-a")
    );
    await withScope(TENANT_A, () =>
      sendWhatsAppText(TENANT_A.senderId, "same text", "response-slot-b")
    );

    const requestIds = mocks.claimDelivery.mock.calls.map(
      call => (call[0] as { reqId: string }).reqId
    );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a rejected erasure delivery outcome and attempt hash", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("sensitive", { status: 400 }))
    );

    await expect(
      withScope(TENANT_A, () =>
        sendWhatsAppErasureControlText(
          TENANT_A.senderId,
          "deletion outcome",
          "erasure-operation-1"
        )
      )
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "known_rejected",
      attemptKeyHash: "e".repeat(64),
    });
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
  });

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

    const error = await withScope(TENANT_A, () =>
      sendWhatsAppText(TENANT_A.senderId, "reply", "redaction")
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    const serializedError = inspect(error, { depth: 8 });
    expect(serializedError).not.toContain(TENANT_A.token);
    expect(serializedError).not.toContain(TENANT_A.senderId);
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
