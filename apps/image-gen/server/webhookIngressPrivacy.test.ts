import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitPrivacy: vi.fn(),
  admitWhatsAppScope: vi.fn(),
  getErasingSubject: vi.fn(),
  processFacebook: vi.fn(),
  processWhatsApp: vi.fn(),
  resolveOwnership: vi.fn(),
  resolveWhatsAppOwnership: vi.fn(),
  claimReplay: vi.fn(),
  runLockedErasure: vi.fn(),
}));

vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    admitMessengerPrivacySubjectFromMetaEvent: mocks.admitPrivacy,
    getErasingMessengerPrivacySubject: mocks.getErasingSubject,
    runWithLockedMessengerPrivacyErasure: mocks.runLockedErasure,
  };
});
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  resolveMessengerGenerationOwnership: mocks.resolveOwnership,
}));
vi.mock("./_core/messengerWebhook", () => ({
  processFacebookWebhookPayload: mocks.processFacebook,
}));
vi.mock("./_core/whatsappWebhook", () => ({
  processWhatsAppWebhookPayload: mocks.processWhatsApp,
}));
vi.mock("./_core/webhookReplayProtection", () => ({
  claimWebhookReplayKey: mocks.claimReplay,
}));
vi.mock("./_core/whatsappGenerationScope", () => {
  class WhatsAppGenerationScopeError extends Error {
    readonly retryable: boolean;

    constructor(options?: { retryable?: boolean }) {
      super("WhatsApp generation ownership is unavailable");
      this.name = "WhatsAppGenerationScopeError";
      this.retryable = options?.retryable === true;
    }
  }
  return {
    admitWhatsAppGenerationScope: mocks.admitWhatsAppScope,
    resolveWhatsAppGenerationOwnership: mocks.resolveWhatsAppOwnership,
    WhatsAppGenerationScopeError,
  };
});

import { webhookIngressQueueTestHooks } from "./_core/meta/webhookIngressQueue";
import {
  getMessengerRequestChannel,
  getMessengerRequestOwnership,
  getMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";
import { MessengerPrivacyFenceError } from "./_core/messengerPrivacySubject";
import { WhatsAppGenerationScopeError } from "./_core/whatsappGenerationScope";

describe("Messenger webhook ingress privacy admission", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "webhook-ingress-privacy-test-pepper";
    mocks.admitPrivacy.mockReset().mockResolvedValue(4);
    mocks.admitWhatsAppScope.mockReset();
    mocks.getErasingSubject.mockReset().mockResolvedValue(null);
    mocks.processFacebook.mockReset().mockResolvedValue(undefined);
    mocks.processWhatsApp.mockReset().mockResolvedValue(undefined);
    mocks.claimReplay.mockReset();
    mocks.runLockedErasure
      .mockReset()
      .mockImplementation(
        async (
          _scope: unknown,
          task: () => Promise<{ value: unknown; complete: boolean }>
        ) => (await task()).value
      );
    mocks.resolveOwnership.mockReset().mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      pageId: "page-a",
    });
    mocks.resolveWhatsAppOwnership
      .mockReset()
      .mockImplementation(async (input: { userKey: string }) => ({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: input.userKey,
      }));
    mocks.admitWhatsAppScope.mockImplementation(
      async (input: { ownership: object }) => ({
        ...input.ownership,
        privacyEpoch: 5,
      })
    );
  });

  it("allows reactivation only for a timestamped user event", async () => {
    const timestamp = 1_777_000_000_123;
    const deliveries =
      await webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({ timestamp, message: { mid: "mid-1", text: "hi" } })
      );

    expect(deliveries).toHaveLength(1);
    expect(mocks.admitPrivacy).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 7,
      userKey: toUserKey("sender-a"),
      eventOccurredAt: new Date(timestamp),
      allowReactivation: true,
    });
    expect(deliveries[0]?.subjects[0]).toMatchObject({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 4,
      userKey: toUserKey("sender-a"),
    });
  });

  it("does not grant reactivation authority to non-user Meta events", async () => {
    const timestamp = 1_777_000_000_124;
    await webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
      messengerPayload({ timestamp })
    );

    expect(mocks.admitPrivacy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventOccurredAt: new Date(timestamp),
        allowReactivation: false,
      })
    );
  });

  it("keeps a delivery receipt under the immutable queued user scope", async () => {
    const timestamp = 1_777_000_000_125;
    const deliveries =
      await webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({
          timestamp,
          delivery: { mids: ["mid-paid-delivery"] },
        })
      );

    expect(mocks.admitPrivacy).toHaveBeenCalledWith(
      expect.objectContaining({
        userKey: toUserKey("sender-a"),
        eventOccurredAt: new Date(timestamp),
        allowReactivation: false,
      })
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.subjects).toEqual([
      expect.objectContaining({
        privacyEpoch: 4,
        userKey: toUserKey("sender-a"),
        pageId: "page-a",
      }),
    ]);
    expect(deliveries[0]?.payload).toEqual(
      expect.objectContaining({
        entry: [
          expect.objectContaining({
            messaging: [
              expect.objectContaining({
                delivery: { mids: ["mid-paid-delivery"] },
              }),
            ],
          }),
        ],
      })
    );
  });

  it("rejects an event without a stable Meta timestamp", async () => {
    await expect(
      webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({ message: { mid: "mid-no-time", text: "hi" } })
      )
    ).rejects.toThrow("event timestamp is unavailable");

    expect(mocks.admitPrivacy).not.toHaveBeenCalled();
  });

  it("acknowledges but never queues an event rejected by the durable privacy boundary", async () => {
    mocks.admitPrivacy.mockRejectedValueOnce(new MessengerPrivacyFenceError());

    await expect(
      webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({
          timestamp: 1_777_000_000_126,
          message: { mid: "mid-erased", text: "delayed" },
        })
      )
    ).resolves.toEqual([]);

    expect(mocks.processFacebook).not.toHaveBeenCalled();
  });

  it("processes queued work under its immutable privacy epoch without readmission", async () => {
    const userKey = toUserKey("sender-a");
    mocks.processFacebook.mockImplementationOnce(async () => {
      expect(getMessengerRequestChannel()).toBe("facebook_messenger");
      expect(getMessengerRequestOwnership()).toEqual({
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
      });
      expect(getMessengerRequestPrivacySubject()).toEqual({
        userKey,
        privacyEpoch: 4,
      });
    });

    await webhookIngressQueueTestHooks.processQueuedWebhookDelivery({
      deliveryId: "11111111-1111-4111-8111-111111111111",
      channel: "facebook",
      payload: messengerPayload({
        timestamp: 1_777_000_000_125,
        message: { mid: "mid-queued", text: "hi" },
      }),
      receivedAt: "2026-08-23T12:00:00.000Z",
      expiresAt: Date.now() + 60_000,
      subjects: [
        {
          workspaceId: 42,
          channelConnectionId: 7,
          bindingEpoch: 3,
          privacyEpoch: 4,
          pageId: "page-a",
          userKey,
        },
      ],
    });

    expect(mocks.processFacebook).toHaveBeenCalledTimes(1);
    expect(mocks.admitPrivacy).not.toHaveBeenCalled();
  });
});

describe("WhatsApp webhook ingress privacy admission", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "webhook-ingress-privacy-test-pepper";
    mocks.getErasingSubject.mockReset().mockResolvedValue(null);
    mocks.processWhatsApp.mockReset().mockResolvedValue(undefined);
    mocks.claimReplay.mockReset();
    mocks.resolveWhatsAppOwnership
      .mockReset()
      .mockImplementation(async (input: { userKey: string }) => ({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: input.userKey,
      }));
    mocks.admitWhatsAppScope
      .mockReset()
      .mockImplementation(async (input: { ownership: object }) => ({
        ...input.ownership,
        privacyEpoch: 5,
      }));
  });

  it("splits a batch into one immutable subject-scoped delivery per sender", async () => {
    const deliveries =
      await webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([
          whatsAppMessage("32470000001", "wamid.one", "private one"),
          whatsAppMessage("32470000002", "wamid.two", "private two"),
        ])
      );

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.subjects).toEqual([
      {
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 5,
        pageId: "404040404040404",
        userKey: toUserKey("32470000001"),
      },
    ]);
    expect(JSON.stringify(deliveries[0]?.payload)).toContain("private one");
    expect(JSON.stringify(deliveries[0]?.payload)).not.toContain("private two");
    expect(deliveries[1]?.subjects[0]?.userKey).toBe(toUserKey("32470000002"));
    expect(mocks.claimReplay).not.toHaveBeenCalled();
  });

  it("drops a WhatsApp event without a stable timestamp before reactivation", async () => {
    const message = whatsAppMessage(
      "32470000008",
      "wamid.no-timestamp",
      "private"
    );
    const { timestamp: _timestamp, ...withoutTimestamp } = message;

    await expect(
      webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([withoutTimestamp])
      )
    ).resolves.toEqual([]);

    expect(mocks.admitWhatsAppScope).not.toHaveBeenCalled();
    expect(mocks.claimReplay).not.toHaveBeenCalled();
  });

  it("indexes an erasure retry under the exact erasing epoch without reactivation", async () => {
    mocks.getErasingSubject.mockResolvedValueOnce({
      privacyEpoch: 6,
      dataPrivacyEpoch: 5,
    });

    const deliveries =
      await webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([
          whatsAppMessage("32470000003", "wamid.delete", "delete my data"),
        ])
      );

    expect(deliveries[0]?.subjects[0]?.privacyEpoch).toBe(6);
    expect(deliveries[0]?.privacyControl).toBe("erasure_retry");
    expect(deliveries[0]?.erasureControl).toEqual({
      privacyEpoch: 6,
      dataPrivacyEpoch: 5,
    });
    expect(mocks.admitWhatsAppScope).not.toHaveBeenCalled();
    expect(mocks.claimReplay).not.toHaveBeenCalled();
  });

  it("treats a subject-index loss as an erased atomic retry", async () => {
    const deliveryId = "11111111-1111-4111-8111-111111111111";
    const evalMock = vi.fn(async () => -1);
    const delivery = {
      deliveryId,
      channel: "facebook" as const,
      payload: { private: "content" },
      receivedAt: new Date().toISOString(),
      expiresAt: Date.now() + 60_000,
      subjects: [
        {
          workspaceId: 42,
          channelConnectionId: 7,
          bindingEpoch: 3,
          privacyEpoch: 5,
          pageId: "page-a",
          userKey: "a".repeat(64),
        },
      ],
    };

    await expect(
      webhookIngressQueueTestHooks.releaseFailedWebhookIngressDelivery(
        { eval: evalMock } as never,
        {
          raw: deliveryId,
          delivery,
          legacyInline: false,
        },
        new Error("retry")
      )
    ).resolves.toBe("erased");

    expect(evalMock).toHaveBeenCalledOnce();
    const [script, keyCount, ...args] = evalMock.mock.calls[0]!;
    expect(script).toContain('redis.call("SISMEMBER"');
    expect(script).toContain('redis.call("SET", KEYS[5]');
    expect(script).toContain('redis.call("LREM", KEYS[2]');
    expect(keyCount).toBe(7);
    expect(args).toContain(`{meta-webhook-ingress}:delivery:${deliveryId}`);
  });

  it("requeues an erasure control only while the exact database erasure is locked", async () => {
    const deliveryId = "33333333-3333-4333-8333-333333333333";
    const evalMock = vi.fn(async () => 1);
    const userKey = "b".repeat(64);
    const delivery = {
      deliveryId,
      channel: "whatsapp" as const,
      payload: { private: "delete retry" },
      receivedAt: new Date().toISOString(),
      expiresAt: Date.now() + 60_000,
      privacyControl: "erasure_retry" as const,
      erasureControl: { privacyEpoch: 6, dataPrivacyEpoch: 5 },
      subjects: [
        {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 6,
          pageId: "404040404040404",
          userKey,
        },
      ],
    };

    await expect(
      webhookIngressQueueTestHooks.releaseFailedWebhookIngressDelivery(
        { eval: evalMock } as never,
        { raw: deliveryId, delivery, legacyInline: false },
        new Error("retry")
      )
    ).resolves.toBe("requeued");

    expect(mocks.runLockedErasure).toHaveBeenCalledWith(
      {
        workspaceId: 42,
        channelConnectionId: 8,
        userKey,
        privacyEpoch: 6,
        dataPrivacyEpoch: 5,
      },
      expect.any(Function)
    );
    const [, keyCount, ...args] = evalMock.mock.calls[0]!;
    expect(keyCount).toBe(7);
    expect(args[14]).toBe(1);
    expect(args[15]).toBe(0);
    expect(args[16]).toBe(6);
  });

  it("atomically scrubs an erasure retry when the database erasure fence is gone", async () => {
    const deliveryId = "44444444-4444-4444-8444-444444444444";
    const evalMock = vi.fn(async () => -1);
    const userKey = "c".repeat(64);
    mocks.runLockedErasure.mockRejectedValueOnce(
      new MessengerPrivacyFenceError()
    );
    const delivery = {
      deliveryId,
      channel: "whatsapp" as const,
      payload: { private: "stale delete retry" },
      receivedAt: new Date().toISOString(),
      expiresAt: Date.now() + 60_000,
      privacyControl: "erasure_retry" as const,
      erasureControl: { privacyEpoch: 6, dataPrivacyEpoch: 5 },
      subjects: [
        {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 6,
          pageId: "404040404040404",
          userKey,
        },
      ],
    };

    await expect(
      webhookIngressQueueTestHooks.releaseFailedWebhookIngressDelivery(
        { eval: evalMock } as never,
        { raw: deliveryId, delivery, legacyInline: false },
        new Error("retry")
      )
    ).resolves.toBe("erased");

    expect(evalMock).toHaveBeenCalledOnce();
    const [script, keyCount, ...args] = evalMock.mock.calls[0]!;
    expect(script).toContain("if forceErase then return scrubErased() end");
    expect(keyCount).toBe(7);
    expect(args[14]).toBe(1);
    expect(args[15]).toBe(1);
    expect(args[16]).toBe(6);
  });

  it("processes one WhatsApp unit under the stored scope", async () => {
    const [unit] =
      await webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([
          whatsAppMessage("32470000004", "wamid.process", "process me"),
        ])
      );
    if (!unit) throw new Error("expected WhatsApp ingress unit");
    const subject = unit.subjects[0]!;
    mocks.processWhatsApp.mockImplementationOnce(
      async (_payload: unknown, options: { expectedScope: unknown }) => {
        expect(getMessengerRequestChannel()).toBe("whatsapp");
        expect(getMessengerRequestOwnership()).toEqual({
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
        });
        expect(getMessengerRequestPrivacySubject()).toEqual({
          userKey: subject.userKey,
          privacyEpoch: 5,
        });
        expect(options.expectedScope).toEqual({
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 5,
          userKey: subject.userKey,
        });
      }
    );

    await webhookIngressQueueTestHooks.processQueuedWebhookDelivery({
      deliveryId: "22222222-2222-4222-8222-222222222222",
      channel: "whatsapp",
      payload: unit.payload,
      receivedAt: "2026-08-24T12:00:00.000Z",
      expiresAt: Date.now() + 60_000,
      subjects: unit.subjects,
    });

    expect(mocks.processWhatsApp).toHaveBeenCalledOnce();
  });

  it("forwards the durable erasure scope when retrying a WhatsApp deletion", async () => {
    mocks.getErasingSubject.mockResolvedValueOnce({
      privacyEpoch: 6,
      dataPrivacyEpoch: 5,
    });
    const [unit] =
      await webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([
          whatsAppMessage(
            "32470000009",
            "wamid.delete-retry",
            "delete my data"
          ),
        ])
      );
    if (!unit) throw new Error("expected WhatsApp erasure ingress unit");

    await webhookIngressQueueTestHooks.processQueuedWebhookDelivery({
      deliveryId: "55555555-5555-4555-8555-555555555555",
      channel: "whatsapp",
      payload: unit.payload,
      receivedAt: "2026-08-24T12:00:00.000Z",
      expiresAt: Date.now() + 60_000,
      privacyControl: unit.privacyControl,
      erasureControl: unit.erasureControl,
      subjects: unit.subjects,
    });

    expect(mocks.processWhatsApp).toHaveBeenCalledWith(unit.payload, {
      expectedScope: {
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 6,
        userKey: unit.subjects[0]?.userKey,
      },
      expectedErasure: {
        privacyEpoch: 6,
        dataPrivacyEpoch: 5,
      },
    });
  });

  it("rejects an unscoped WhatsApp unit before invoking its handler", async () => {
    await expect(
      webhookIngressQueueTestHooks.processQueuedWebhookDelivery({
        deliveryId: "33333333-3333-4333-8333-333333333333",
        channel: "whatsapp",
        payload: whatsAppPayload([
          whatsAppMessage("32470000005", "wamid.unscoped", "private"),
        ]),
        receivedAt: "2026-08-24T12:00:00.000Z",
        expiresAt: Date.now() + 60_000,
        subjects: [],
      })
    ).rejects.toThrow("privacy scope is unavailable");

    expect(mocks.processWhatsApp).not.toHaveBeenCalled();
  });

  it("drops a terminal scope denial without storing content or claiming replay", async () => {
    mocks.resolveWhatsAppOwnership.mockRejectedValueOnce(
      new WhatsAppGenerationScopeError()
    );

    await expect(
      webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([
          whatsAppMessage("32470000006", "wamid.denied", "private"),
        ])
      )
    ).resolves.toEqual([]);

    expect(mocks.admitWhatsAppScope).not.toHaveBeenCalled();
    expect(mocks.claimReplay).not.toHaveBeenCalled();
  });

  it("propagates retryable ownership infrastructure failure before replay", async () => {
    mocks.resolveWhatsAppOwnership.mockRejectedValueOnce(
      new WhatsAppGenerationScopeError({ retryable: true })
    );

    await expect(
      webhookIngressQueueTestHooks.createWhatsAppIngressDeliveries(
        whatsAppPayload([
          whatsAppMessage("32470000007", "wamid.retryable", "private"),
        ])
      )
    ).rejects.toMatchObject({ retryable: true });

    expect(mocks.admitWhatsAppScope).not.toHaveBeenCalled();
    expect(mocks.claimReplay).not.toHaveBeenCalled();
  });
});

function messengerPayload(event: {
  timestamp?: number;
  message?: { mid: string; text: string };
  delivery?: { mids: string[] };
}) {
  return {
    object: "page",
    entry: [
      {
        id: "page-a",
        messaging: [
          {
            sender: { id: "sender-a" },
            recipient: { id: "page-a" },
            ...event,
          },
        ],
      },
    ],
  };
}

function whatsAppMessage(senderId: string, id: string, text: string) {
  return {
    from: senderId,
    id,
    timestamp: "1777000000",
    type: "text",
    text: { body: text },
  };
}

function whatsAppPayload(messages: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "303030303030303",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "404040404040404" },
              messages,
            },
          },
        ],
      },
    ],
  };
}
