import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveOwnershipMock,
  ensurePrivacyMock,
  resolveWhatsAppOwnershipMock,
  admitWhatsAppScopeMock,
  getErasingSubjectMock,
  processWhatsAppMock,
  runLockedErasureMock,
} = vi.hoisted(() => ({
  resolveOwnershipMock: vi.fn(),
  ensurePrivacyMock: vi.fn(async () => 1),
  resolveWhatsAppOwnershipMock: vi.fn(),
  admitWhatsAppScopeMock: vi.fn(),
  getErasingSubjectMock: vi.fn(),
  processWhatsAppMock: vi.fn(),
  runLockedErasureMock: vi.fn(),
}));

vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  resolveMessengerGenerationOwnership: resolveOwnershipMock,
}));
vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    admitMessengerPrivacySubjectFromMetaEvent: ensurePrivacyMock,
    getErasingMessengerPrivacySubject: getErasingSubjectMock,
    runWithLockedMessengerPrivacyErasure: runLockedErasureMock,
  };
});
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
    resolveWhatsAppGenerationOwnership: resolveWhatsAppOwnershipMock,
    admitWhatsAppGenerationScope: admitWhatsAppScopeMock,
    WhatsAppGenerationScopeError,
  };
});
vi.mock("./_core/whatsappWebhook", () => ({
  processWhatsAppWebhookPayload: processWhatsAppMock,
}));

import {
  enqueueWebhookIngressDelivery,
  eraseWebhookIngressDeliveriesForSubject,
  resetWebhookIngressQueueForTests,
  scheduleWebhookIngressDrain,
  webhookIngressQueueTestHooks,
} from "./_core/meta/webhookIngressQueue";
import { MessengerPrivacyFenceError } from "./_core/messengerPrivacySubject";
import { getRedisClient } from "./_core/redis";
import { toUserKey } from "./_core/privacy";

const runRedis = process.env.RUN_REDIS_INTEGRATION === "1";
const suite = runRedis ? describe : describe.skip;

suite("webhook ingress Redis privacy fence", () => {
  const originalPepper = process.env.PRIVACY_PEPPER;

  beforeEach(async () => {
    process.env.PRIVACY_PEPPER = "webhook-ingress-redis-test-pepper";
    resetWebhookIngressQueueForTests();
    const redis = await getRedisClient();
    await redis.flushdb();
    resolveOwnershipMock.mockReset();
    resolveOwnershipMock.mockImplementation(async (pageId: string) =>
      pageId === "page-a"
        ? {
            workspaceId: 42,
            channelConnectionId: 7,
            bindingEpoch: 3,
            pageId,
          }
        : {
            workspaceId: 84,
            channelConnectionId: 9,
            bindingEpoch: 1,
            pageId,
          }
    );
    ensurePrivacyMock.mockReset();
    ensurePrivacyMock.mockResolvedValue(1);
    resolveWhatsAppOwnershipMock
      .mockReset()
      .mockImplementation(async (input: { userKey: string }) => ({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: input.userKey,
      }));
    admitWhatsAppScopeMock
      .mockReset()
      .mockImplementation(async (input: { ownership: object }) => ({
        ...input.ownership,
        privacyEpoch: 1,
      }));
    getErasingSubjectMock.mockReset().mockResolvedValue(null);
    processWhatsAppMock.mockReset().mockResolvedValue(undefined);
    runLockedErasureMock
      .mockReset()
      .mockImplementation(
        async (
          _scope: unknown,
          task: () => Promise<{ value: unknown; complete: boolean }>
        ) => (await task()).value
      );
  });

  afterAll(() => {
    resetWebhookIngressQueueForTests();
    if (originalPepper === undefined) delete process.env.PRIVACY_PEPPER;
    else process.env.PRIVACY_PEPPER = originalPepper;
  });

  it("scrubs only the exact tenant subject and rejects its stale epoch", async () => {
    const psid = "same-psid-on-two-pages";
    await enqueueWebhookIngressDelivery(
      "facebook",
      messengerPayload("page-a", psid, "mid-a")
    );
    await enqueueWebhookIngressDelivery(
      "facebook",
      messengerPayload("page-b", psid, "mid-b")
    );

    await expect(
      eraseWebhookIngressDeliveriesForSubject({
        workspaceId: 42,
        channelConnectionId: 7,
        userKey: toUserKey(psid),
        privacyEpoch: 2,
      })
    ).resolves.toBe(1);

    const redis = await getRedisClient();
    const refs = await redis.lrange("{meta-webhook-ingress}:queued", 0, -1);
    expect(refs).toHaveLength(1);
    const remaining = await redis.get(
      `{meta-webhook-ingress}:delivery:${refs[0]}`
    );
    expect(remaining).toContain('"id":"page-b"');
    expect(remaining).not.toContain('"id":"page-a"');

    await expect(
      enqueueWebhookIngressDelivery(
        "facebook",
        messengerPayload("page-a", psid, "mid-a-replayed")
      )
    ).rejects.toThrow("subject epoch is erased");
  });

  it("does not extend the immutable content deadline on enqueue", async () => {
    await enqueueWebhookIngressDelivery(
      "facebook",
      messengerPayload("page-a", "ttl-user", "mid-ttl")
    );
    const redis = await getRedisClient();
    const refs = await redis.lrange("{meta-webhook-ingress}:queued", 0, -1);
    const raw = await redis.get(`{meta-webhook-ingress}:delivery:${refs[0]}`);
    const delivery = JSON.parse(raw ?? "{}") as {
      receivedAt?: string;
      expiresAt?: number;
    };
    expect(delivery.expiresAt).toBe(
      Date.parse(delivery.receivedAt ?? "") + 24 * 60 * 60 * 1_000
    );
    await expect(
      redis.pexpiretime(`{meta-webhook-ingress}:delivery:${refs[0]}`)
    ).resolves.toBe(delivery.expiresAt);
  });

  it("never shortens the shared subject-index deadline", async () => {
    const psid = "shared-index-ttl-user";
    await enqueueWebhookIngressDelivery(
      "facebook",
      messengerPayload("page-a", psid, "mid-index-first")
    );
    const redis = await getRedisClient();
    const subjectKeys = await redis.keys("{meta-webhook-ingress}:subject:*");
    expect(subjectKeys).toHaveLength(1);
    const laterDeadline = Date.now() + 48 * 60 * 60 * 1_000;
    await redis.pexpireat(subjectKeys[0], laterDeadline);

    await enqueueWebhookIngressDelivery(
      "facebook",
      messengerPayload("page-a", psid, "mid-index-second")
    );

    expect(await redis.pexpiretime(subjectKeys[0])).toBe(laterDeadline);
  });

  it("scrubs bounded batches beyond one hundred subject references", async () => {
    const psid = "large-subject-index";
    for (let index = 0; index < 125; index += 1) {
      await enqueueWebhookIngressDelivery(
        "facebook",
        messengerPayload("page-a", psid, `mid-batch-${index}`)
      );
    }

    await expect(
      eraseWebhookIngressDeliveriesForSubject({
        workspaceId: 42,
        channelConnectionId: 7,
        userKey: toUserKey(psid),
        privacyEpoch: 2,
      })
    ).resolves.toBe(125);

    const redis = await getRedisClient();
    await expect(
      redis.lrange("{meta-webhook-ingress}:queued", 0, -1)
    ).resolves.toEqual([]);
    const contentKeys = await redis.keys("{meta-webhook-ingress}:delivery:*");
    expect(contentKeys).toEqual([]);
  });

  it("scrubs queued, processing, dead, content, and lease state together", async () => {
    const psid = "all-ingress-states";
    for (let index = 0; index < 3; index += 1) {
      await enqueueWebhookIngressDelivery(
        "facebook",
        messengerPayload("page-a", psid, `mid-state-${index}`)
      );
    }
    const redis = await getRedisClient();
    const processingRef = await redis.lpop("{meta-webhook-ingress}:queued");
    const deadRef = await redis.lpop("{meta-webhook-ingress}:queued");
    expect(processingRef).toBeTruthy();
    expect(deadRef).toBeTruthy();
    await redis.rpush("{meta-webhook-ingress}:processing", processingRef!);
    await redis.rpush("{meta-webhook-ingress}:dead", deadRef!);
    await redis.set(
      `{meta-webhook-ingress}:lease:${processingRef}`,
      "1",
      "EX",
      60
    );

    await expect(
      eraseWebhookIngressDeliveriesForSubject({
        workspaceId: 42,
        channelConnectionId: 7,
        userKey: toUserKey(psid),
        privacyEpoch: 2,
      })
    ).resolves.toBe(3);

    for (const list of ["queued", "processing", "dead"]) {
      await expect(
        redis.lrange(`{meta-webhook-ingress}:${list}`, 0, -1)
      ).resolves.toEqual([]);
    }
    expect(await redis.keys("{meta-webhook-ingress}:delivery:*")).toEqual([]);
    expect(await redis.keys("{meta-webhook-ingress}:lease:*")).toEqual([]);
  });

  it("splits WhatsApp senders and scrubs only the exact queued subject", async () => {
    const firstSender = "32470000001";
    const secondSender = "32470000002";
    await enqueueWebhookIngressDelivery(
      "whatsapp",
      whatsAppPayload([
        whatsAppMessage(firstSender, "wamid.redis.one", "sentinel one"),
        whatsAppMessage(secondSender, "wamid.redis.two", "sentinel two"),
      ])
    );

    const redis = await getRedisClient();
    const refs = await redis.lrange("{meta-webhook-ingress}:queued", 0, -1);
    expect(refs).toHaveLength(2);
    const before = await Promise.all(
      refs.map(ref => redis.get(`{meta-webhook-ingress}:delivery:${ref}`))
    );
    expect(
      before.filter(value => value?.includes("sentinel one"))
    ).toHaveLength(1);
    expect(
      before.filter(value => value?.includes("sentinel two"))
    ).toHaveLength(1);
    expect(
      before.some(
        value =>
          value?.includes("sentinel one") && value.includes("sentinel two")
      )
    ).toBe(false);

    await expect(
      eraseWebhookIngressDeliveriesForSubject({
        workspaceId: 42,
        channelConnectionId: 8,
        userKey: toUserKey(firstSender),
        privacyEpoch: 2,
      })
    ).resolves.toBe(1);

    const remainingRefs = await redis.lrange(
      "{meta-webhook-ingress}:queued",
      0,
      -1
    );
    expect(remainingRefs).toHaveLength(1);
    const remaining = await redis.get(
      `{meta-webhook-ingress}:delivery:${remainingRefs[0]}`
    );
    expect(remaining).toContain("sentinel two");
    expect(remaining).not.toContain("sentinel one");

    await expect(
      enqueueWebhookIngressDelivery(
        "whatsapp",
        whatsAppPayload([
          whatsAppMessage(
            firstSender,
            "wamid.redis.one.replay",
            "stale sentinel"
          ),
        ])
      )
    ).rejects.toThrow("subject epoch is erased");
  });

  it("scrubs WhatsApp queued, processing, and dead content references", async () => {
    const senderId = "32470000003";
    for (let index = 0; index < 3; index += 1) {
      await enqueueWebhookIngressDelivery(
        "whatsapp",
        whatsAppPayload([
          whatsAppMessage(
            senderId,
            `wamid.redis.state.${index}`,
            `whatsapp state sentinel ${index}`
          ),
        ])
      );
    }
    const redis = await getRedisClient();
    const processingRef = await redis.lpop("{meta-webhook-ingress}:queued");
    const deadRef = await redis.lpop("{meta-webhook-ingress}:queued");
    expect(processingRef).toBeTruthy();
    expect(deadRef).toBeTruthy();
    await redis.rpush("{meta-webhook-ingress}:processing", processingRef!);
    await redis.rpush("{meta-webhook-ingress}:dead", deadRef!);
    await redis.set(
      `{meta-webhook-ingress}:lease:${processingRef}`,
      "1",
      "EX",
      60
    );

    await expect(
      eraseWebhookIngressDeliveriesForSubject({
        workspaceId: 42,
        channelConnectionId: 8,
        userKey: toUserKey(senderId),
        privacyEpoch: 2,
      })
    ).resolves.toBe(3);

    for (const list of ["queued", "processing", "dead"]) {
      await expect(
        redis.lrange(`{meta-webhook-ingress}:${list}`, 0, -1)
      ).resolves.toEqual([]);
    }
    expect(await redis.keys("{meta-webhook-ingress}:delivery:*")).toEqual([]);
    expect(await redis.keys("{meta-webhook-ingress}:lease:*")).toEqual([]);
  });

  it("resumes an exact deletion retry at its tombstoned erasing epoch", async () => {
    const senderId = "32470000004";
    getErasingSubjectMock.mockResolvedValue({
      privacyEpoch: 2,
      dataPrivacyEpoch: 1,
    });
    await eraseWebhookIngressDeliveriesForSubject({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: toUserKey(senderId),
      privacyEpoch: 2,
    });

    await expect(
      enqueueWebhookIngressDelivery(
        "whatsapp",
        whatsAppPayload([
          whatsAppMessage(
            senderId,
            "wamid.redis.delete.retry",
            "delete my data"
          ),
        ])
      )
    ).resolves.toBeUndefined();

    const redis = await getRedisClient();
    const refs = await redis.lrange("{meta-webhook-ingress}:queued", 0, -1);
    expect(refs).toHaveLength(1);
    const stored = await redis.get(
      `{meta-webhook-ingress}:delivery:${refs[0]}`
    );
    expect(stored).toContain('"privacyControl":"erasure_retry"');
    expect(runLockedErasureMock).toHaveBeenCalledWith(
      {
        workspaceId: 42,
        channelConnectionId: 8,
        userKey: toUserKey(senderId),
        privacyEpoch: 2,
        dataPrivacyEpoch: 1,
      },
      expect.any(Function)
    );

    await expect(
      enqueueWebhookIngressDelivery(
        "whatsapp",
        whatsAppPayload([
          whatsAppMessage(
            senderId,
            "wamid.redis.ordinary.stale",
            "ordinary private content"
          ),
        ])
      )
    ).rejects.toThrow("subject epoch is erased");

    scheduleWebhookIngressDrain();
    await vi.waitFor(() => {
      expect(processWhatsAppMock).toHaveBeenCalledOnce();
    });
    expect(processWhatsAppMock).toHaveBeenCalledWith(expect.any(Object), {
      expectedScope: expect.objectContaining({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 2,
        userKey: toUserKey(senderId),
      }),
    });
    await vi.waitFor(async () => {
      await expect(
        redis.lrange("{meta-webhook-ingress}:queued", 0, -1)
      ).resolves.toEqual([]);
      expect(await redis.keys("{meta-webhook-ingress}:delivery:*")).toEqual([]);
    });
  });

  it("rejects an ordinary WhatsApp message at the exact erased epoch", async () => {
    const senderId = "32470000006";
    admitWhatsAppScopeMock.mockImplementationOnce(
      async (input: { ownership: object }) => ({
        ...input.ownership,
        privacyEpoch: 2,
      })
    );
    await eraseWebhookIngressDeliveriesForSubject({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: toUserKey(senderId),
      privacyEpoch: 2,
    });

    await expect(
      enqueueWebhookIngressDelivery(
        "whatsapp",
        whatsAppPayload([
          whatsAppMessage(
            senderId,
            "wamid.redis.ordinary.equal",
            "ordinary private content"
          ),
        ])
      )
    ).rejects.toThrow("subject epoch is erased");

    const redis = await getRedisClient();
    await expect(
      redis.lrange("{meta-webhook-ingress}:queued", 0, -1)
    ).resolves.toEqual([]);
    expect(await redis.keys("{meta-webhook-ingress}:delivery:*")).toEqual([]);
    expect(await redis.keys("{meta-webhook-ingress}:subject:*")).toEqual([]);
  });

  it("requeues a failed erasure retry while its exact SQL erasure remains active", async () => {
    const senderId = "32470000007";
    getErasingSubjectMock.mockResolvedValue({
      privacyEpoch: 2,
      dataPrivacyEpoch: 1,
    });
    await eraseWebhookIngressDeliveriesForSubject({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: toUserKey(senderId),
      privacyEpoch: 2,
    });
    await enqueueWebhookIngressDelivery(
      "whatsapp",
      whatsAppPayload([
        whatsAppMessage(
          senderId,
          "wamid.redis.delete.requeue",
          "delete my data"
        ),
      ])
    );

    const redis = await getRedisClient();
    const reserved =
      await webhookIngressQueueTestHooks.reserveWebhookIngressDelivery(redis);
    if (!reserved || "invalid" in reserved || "subjectBlocked" in reserved) {
      throw new Error("expected an erasure retry reservation");
    }
    await expect(
      webhookIngressQueueTestHooks.releaseFailedWebhookIngressDelivery(
        redis,
        reserved,
        new Error("retryable erasure step")
      )
    ).resolves.toBe("requeued");

    await expect(
      redis.lrange("{meta-webhook-ingress}:queued", 0, -1)
    ).resolves.toEqual([reserved.delivery.deliveryId]);
    await expect(
      redis.lrange("{meta-webhook-ingress}:processing", 0, -1)
    ).resolves.toEqual([]);
    await expect(
      redis.get(
        `{meta-webhook-ingress}:delivery:${reserved.delivery.deliveryId}`
      )
    ).resolves.toContain('"privacyControl":"erasure_retry"');
    expect(runLockedErasureMock).toHaveBeenCalledTimes(2);
  });

  it("scrubs a failed erasure retry when its SQL erasure fence has disappeared", async () => {
    const senderId = "32470000008";
    getErasingSubjectMock.mockResolvedValue({
      privacyEpoch: 2,
      dataPrivacyEpoch: 1,
    });
    await eraseWebhookIngressDeliveriesForSubject({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: toUserKey(senderId),
      privacyEpoch: 2,
    });
    await enqueueWebhookIngressDelivery(
      "whatsapp",
      whatsAppPayload([
        whatsAppMessage(senderId, "wamid.redis.delete.scrub", "delete my data"),
      ])
    );

    const redis = await getRedisClient();
    const reserved =
      await webhookIngressQueueTestHooks.reserveWebhookIngressDelivery(redis);
    if (!reserved || "invalid" in reserved || "subjectBlocked" in reserved) {
      throw new Error("expected an erasure retry reservation");
    }
    runLockedErasureMock.mockRejectedValueOnce(
      new MessengerPrivacyFenceError()
    );
    await expect(
      webhookIngressQueueTestHooks.releaseFailedWebhookIngressDelivery(
        redis,
        reserved,
        new Error("stale erasure retry")
      )
    ).resolves.toBe("erased");

    for (const list of ["queued", "processing", "dead"]) {
      await expect(
        redis.lrange(`{meta-webhook-ingress}:${list}`, 0, -1)
      ).resolves.toEqual([]);
    }
    expect(await redis.keys("{meta-webhook-ingress}:delivery:*")).toEqual([]);
    expect(await redis.keys("{meta-webhook-ingress}:subject:*")).toEqual([]);
    expect(await redis.keys("{meta-webhook-ingress}:lease:*")).toEqual([]);
  });

  it("does not resurrect WhatsApp content when erasure wins a failed retry", async () => {
    const senderId = "32470000005";
    let rejectProcessing: ((error: Error) => void) | undefined;
    let markProcessingStarted: (() => void) | undefined;
    const processingStarted = new Promise<void>(resolve => {
      markProcessingStarted = resolve;
    });
    processWhatsAppMock.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          rejectProcessing = reject;
          markProcessingStarted?.();
        })
    );

    await enqueueWebhookIngressDelivery(
      "whatsapp",
      whatsAppPayload([
        whatsAppMessage(
          senderId,
          "wamid.redis.retry.race",
          "retry race private sentinel"
        ),
      ])
    );
    const redis = await getRedisClient();
    const [deliveryId] = await redis.lrange(
      "{meta-webhook-ingress}:queued",
      0,
      -1
    );
    expect(deliveryId).toBeTruthy();

    scheduleWebhookIngressDrain();
    await processingStarted;
    await expect(
      redis.lrange("{meta-webhook-ingress}:processing", 0, -1)
    ).resolves.toEqual([deliveryId]);

    await expect(
      eraseWebhookIngressDeliveriesForSubject({
        workspaceId: 42,
        channelConnectionId: 8,
        userKey: toUserKey(senderId),
        privacyEpoch: 2,
      })
    ).resolves.toBe(1);

    rejectProcessing?.(new Error("handler failed after erasure"));

    await vi.waitFor(async () => {
      for (const list of ["queued", "processing", "dead"]) {
        await expect(
          redis.lrange(`{meta-webhook-ingress}:${list}`, 0, -1)
        ).resolves.toEqual([]);
      }
      expect(await redis.keys("{meta-webhook-ingress}:delivery:*")).toEqual([]);
      expect(await redis.keys("{meta-webhook-ingress}:subject:*")).toEqual([]);
      expect(await redis.keys("{meta-webhook-ingress}:lease:*")).toEqual([]);
    });
    await expect(
      redis.get(`{meta-webhook-ingress}:delivery:${deliveryId}`)
    ).resolves.toBeNull();
  });
});

function messengerPayload(pageId: string, psid: string, mid: string) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: { mid, text: "private content sentinel" },
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
