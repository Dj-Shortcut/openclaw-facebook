import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRedisClientMock,
  isRedisEnabledMock,
  safeLogMock,
  processFacebookWebhookPayloadMock,
  processWhatsAppWebhookPayloadMock,
  assertMessengerGenerationOwnershipMock,
  assertMessengerPrivacySubjectMock,
  runWithMessengerRequestContextMock,
} = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(() => false),
  safeLogMock: vi.fn(),
  processFacebookWebhookPayloadMock: vi.fn(),
  processWhatsAppWebhookPayloadMock: vi.fn(),
  assertMessengerGenerationOwnershipMock: vi.fn(),
  assertMessengerPrivacySubjectMock: vi.fn(),
  runWithMessengerRequestContextMock: vi.fn(
    async (_pageId: string, task: () => Promise<void>) => await task()
  ),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

vi.mock("./_core/redis", () => ({
  ensureRedisReady: vi.fn(async () => undefined),
  getRedisClient: getRedisClientMock,
  isRedisEnabled: isRedisEnabledMock,
  resetRedisClientForTests: vi.fn(),
}));

vi.mock("./_core/messengerWebhook", () => ({
  processFacebookWebhookPayload: processFacebookWebhookPayloadMock,
}));

vi.mock("./_core/whatsappWebhook", () => ({
  processWhatsAppWebhookPayload: processWhatsAppWebhookPayloadMock,
}));

vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: assertMessengerGenerationOwnershipMock,
  resolveMessengerGenerationOwnership: vi.fn(),
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: assertMessengerPrivacySubjectMock,
  ensureActiveMessengerPrivacySubject: vi.fn(),
}));

vi.mock("./_core/messengerRequestContext", () => ({
  runWithMessengerRequestContext: runWithMessengerRequestContextMock,
}));

import {
  resetWebhookIngressQueueForTests,
  scheduleWebhookIngressDrain,
} from "./_core/meta/webhookIngressQueue";

describe("webhookIngressQueue", () => {
  const originalMaxAttempts = process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;
  const originalRetryDelayMs = process.env.WEBHOOK_INGRESS_RETRY_DELAY_MS;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "webhook-ingress-queue-test-pepper";
  });

  afterEach(() => {
    vi.useRealTimers();
    getRedisClientMock.mockReset();
    isRedisEnabledMock.mockReset();
    isRedisEnabledMock.mockReturnValue(false);
    processFacebookWebhookPayloadMock.mockReset();
    processWhatsAppWebhookPayloadMock.mockReset();
    assertMessengerGenerationOwnershipMock.mockReset();
    assertMessengerGenerationOwnershipMock.mockResolvedValue(undefined);
    assertMessengerPrivacySubjectMock.mockReset();
    assertMessengerPrivacySubjectMock.mockResolvedValue(undefined);
    runWithMessengerRequestContextMock.mockReset();
    runWithMessengerRequestContextMock.mockImplementation(
      async (_pageId: string, task: () => Promise<void>) => await task()
    );
    safeLogMock.mockReset();
    if (originalMaxAttempts === undefined) {
      delete process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;
    } else {
      process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = originalMaxAttempts;
    }
    if (originalRetryDelayMs === undefined) {
      delete process.env.WEBHOOK_INGRESS_RETRY_DELAY_MS;
    } else {
      process.env.WEBHOOK_INGRESS_RETRY_DELAY_MS = originalRetryDelayMs;
    }
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    resetWebhookIngressQueueForTests();
  });

  it("awaits each queued delivery before popping the next one", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    let releaseFirstDelivery: (() => void) | undefined;
    processFacebookWebhookPayloadMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseFirstDelivery = resolve;
        })
    );
    processFacebookWebhookPayloadMock.mockResolvedValue(undefined);

    const deliveries = [
      JSON.stringify({
        channel: "facebook",
        payload: { entry: [{ id: "first" }] },
        receivedAt: "2026-05-28T00:00:00.000Z",
      }),
      JSON.stringify({
        channel: "facebook",
        payload: { entry: [{ id: "second" }] },
        receivedAt: "2026-05-28T00:00:01.000Z",
      }),
    ];
    const processing: string[] = [];
    const leases = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => {
        leases.delete(key);
        return 1;
      }),
      get: vi.fn(async (key: string) => leases.get(key) ?? null),
      lpush: vi.fn(async (_key: string, value: string) => {
        deliveries.unshift(value);
        return deliveries.length;
      }),
      lrange: vi.fn(async () => []),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
      lmove: vi.fn(async () => {
        const value = deliveries.shift() ?? null;
        if (value) {
          processing.push(value);
        }
        return value;
      }),
      set: vi.fn(async (key: string, value: string) => {
        leases.set(key, value);
        return "OK";
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(1);
    });
    expect(redis.lmove).toHaveBeenCalledTimes(1);
    expect(processing).toHaveLength(1);

    releaseFirstDelivery?.();

    await vi.waitFor(() => {
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(2);
    });
    expect(redis.lmove).toHaveBeenCalledTimes(3);
    expect(processing).toHaveLength(0);
    expect(processFacebookWebhookPayloadMock).toHaveBeenNthCalledWith(1, {
      entry: [{ id: "first" }],
    });
    expect(processFacebookWebhookPayloadMock).toHaveBeenNthCalledWith(2, {
      entry: [{ id: "second" }],
    });
  });

  it("rejects a persisted Messenger delivery after its Page ownership changed", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "1";
    const deliveryId = "53f625ce-8f2b-40b7-ae76-c9228bd6a14a";
    const senderId = "sender-from-workspace-a";
    const userKey = createHmac("sha256", process.env.PRIVACY_PEPPER!)
      .update(senderId)
      .digest("hex");
    const now = Date.now();
    const delivery = {
      deliveryId,
      channel: "facebook",
      payload: {
        object: "page",
        entry: [
          {
            id: "page-a",
            messaging: [
              {
                sender: { id: senderId },
                recipient: { id: "page-a" },
                message: { mid: "message-a", text: "private prompt" },
              },
            ],
          },
        ],
      },
      receivedAt: new Date(now).toISOString(),
      expiresAt: now + 60_000,
      subjects: [
        {
          workspaceId: 41,
          channelConnectionId: 17,
          bindingEpoch: 3,
          privacyEpoch: 2,
          pageId: "page-a",
          userKey,
        },
      ],
    };
    assertMessengerGenerationOwnershipMock.mockRejectedValue(
      new Error("Messenger generation ownership changed after enqueue")
    );
    const queue = [deliveryId];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead, {}, [
      [
        `{meta-webhook-ingress}:delivery:${deliveryId}`,
        JSON.stringify(delivery),
      ],
    ]);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => expect(dead).toEqual([deliveryId]));
    await vi.waitFor(() => expect(redis.lmove).toHaveBeenCalledTimes(2));
    expect(assertMessengerGenerationOwnershipMock).toHaveBeenCalledWith(
      delivery.subjects[0]
    );
    expect(assertMessengerPrivacySubjectMock).not.toHaveBeenCalled();
    expect(runWithMessengerRequestContextMock).not.toHaveBeenCalled();
    expect(processFacebookWebhookPayloadMock).not.toHaveBeenCalled();
    expect(processing).toEqual([]);
  });

  it("processes a persisted Messenger delivery under its captured immutable scope", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    const deliveryId = "4fc91875-6114-45d5-b784-44e28e00615f";
    const senderId = "sender-with-scoped-delivery";
    const userKey = createHmac("sha256", process.env.PRIVACY_PEPPER!)
      .update(senderId)
      .digest("hex");
    const now = Date.now();
    const subject = {
      workspaceId: 42,
      channelConnectionId: 18,
      bindingEpoch: 4,
      privacyEpoch: 3,
      pageId: "page-b",
      userKey,
    };
    const payload = {
      object: "page",
      entry: [
        {
          id: subject.pageId,
          messaging: [
            {
              sender: { id: senderId },
              recipient: { id: subject.pageId },
              message: { mid: "message-b", text: "scoped prompt" },
            },
          ],
        },
      ],
    };
    const delivery = {
      deliveryId,
      channel: "facebook",
      payload,
      receivedAt: new Date(now).toISOString(),
      expiresAt: now + 60_000,
      subjects: [subject],
    };
    const queue = [deliveryId];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead, {}, [
      [
        `{meta-webhook-ingress}:delivery:${deliveryId}`,
        JSON.stringify(delivery),
      ],
    ]);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() =>
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledWith(payload)
    );
    await vi.waitFor(() => expect(redis.lmove).toHaveBeenCalledTimes(2));
    expect(assertMessengerGenerationOwnershipMock).toHaveBeenCalledWith(
      subject
    );
    expect(assertMessengerPrivacySubjectMock).toHaveBeenCalledWith({
      workspaceId: subject.workspaceId,
      channelConnectionId: subject.channelConnectionId,
      userKey,
      privacyEpoch: subject.privacyEpoch,
    });
    expect(runWithMessengerRequestContextMock).toHaveBeenCalledWith(
      subject.pageId,
      expect.any(Function),
      subject
    );
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
  });

  it.each([
    { transition: "retry", maxAttempts: "3" },
    { transition: "dead-letter", maxAttempts: "1" },
  ])(
    "atomically scrubs instead of $transition when erasure wins after processing",
    async ({ maxAttempts }) => {
      isRedisEnabledMock.mockReturnValue(true);
      process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = maxAttempts;
      processFacebookWebhookPayloadMock.mockRejectedValue(
        new Error("handler failed after tombstone")
      );
      const deliveryId = "921cd3e0-e722-4539-8abe-f19439a18f67";
      const senderId = "sender-erased-before-retry";
      const userKey = createHmac("sha256", process.env.PRIVACY_PEPPER!)
        .update(senderId)
        .digest("hex");
      const subject = {
        workspaceId: 42,
        channelConnectionId: 18,
        bindingEpoch: 4,
        privacyEpoch: 3,
        pageId: "page-b",
        userKey,
      };
      const now = Date.now();
      const delivery = {
        deliveryId,
        channel: "facebook",
        payload: {
          object: "page",
          entry: [
            {
              id: subject.pageId,
              messaging: [
                {
                  sender: { id: senderId },
                  recipient: { id: subject.pageId },
                  message: { mid: "message-erased", text: "private prompt" },
                },
              ],
            },
          ],
        },
        receivedAt: new Date(now).toISOString(),
        expiresAt: now + 60_000,
        subjects: [subject],
      };
      const queue = [deliveryId];
      const processing: string[] = [];
      const dead: string[] = [];
      const redis = createQueueRedis(
        queue,
        processing,
        dead,
        {
          beforePersistedTransition: (tombstoneKeys, stored) => {
            stored.set(tombstoneKeys[0], String(subject.privacyEpoch));
          },
        },
        [
          [
            `{meta-webhook-ingress}:delivery:${deliveryId}`,
            JSON.stringify(delivery),
          ],
        ]
      );
      getRedisClientMock.mockResolvedValue(redis);

      scheduleWebhookIngressDrain();

      await vi.waitFor(() =>
        expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(1)
      );
      await vi.waitFor(() => expect(processing).toEqual([]));
      expect(queue).toEqual([]);
      expect(dead).toEqual([]);
      expect(
        await redis.get(`{meta-webhook-ingress}:delivery:${deliveryId}`)
      ).toBeNull();
      expect(safeLogMock).not.toHaveBeenCalledWith(
        "webhook_queued_delivery_requeued",
        expect.any(Object)
      );
      expect(safeLogMock).not.toHaveBeenCalledWith(
        "webhook_queued_delivery_dead_lettered",
        expect.any(Object)
      );
      const subjectId = createHash("sha256")
        .update(String(subject.workspaceId))
        .update("\0")
        .update(String(subject.channelConnectionId))
        .update("\0")
        .update(subject.userKey)
        .digest("hex");
      expect(
        await redis.get(`{meta-webhook-ingress}:erased:${subjectId}`)
      ).toBe(String(subject.privacyEpoch));
    }
  );

  it("does not silently complete a delivery when processing fails", async () => {
    vi.useFakeTimers();
    isRedisEnabledMock.mockReturnValue(true);
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "3";
    process.env.WEBHOOK_INGRESS_RETRY_DELAY_MS = "10";
    const rawPsid = "raw-psid-queue-987654321";
    const rawPhone = "+32470987654";
    const rawPageId = "raw-page-id-queue-123456789";
    const rawPrompt = "make my private portrait look cinematic";
    const processingError = Object.assign(
      new TypeError(
        `handler exploded for ${rawPsid} ${rawPhone} ${rawPageId}: ${rawPrompt}`
      ),
      { code: "ERR_WEBHOOK_HANDLER" }
    );
    processFacebookWebhookPayloadMock
      .mockRejectedValueOnce(processingError)
      .mockResolvedValueOnce(undefined);

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "failed" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.rpush).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:queued",
        expect.any(String)
      );
    });

    expect(processing).toEqual([]);
    expect(queue).toHaveLength(1);
    expect(dead).toHaveLength(0);
    expect(JSON.parse(queue[0])).toMatchObject({
      channel: "facebook",
      attempts: 1,
      payload: { entry: [{ id: "failed" }] },
    });
    expect(safeLogMock).not.toHaveBeenCalledWith(
      "webhook_async_processing_failed",
      expect.any(Object)
    );
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.objectContaining({
        channel: "facebook",
        attempts: 1,
        error: {
          class: "TypeError",
          code: "ERR_WEBHOOK_HANDLER",
        },
      })
    );
    const serializedLogs = JSON.stringify(safeLogMock.mock.calls);
    expect(serializedLogs).not.toContain(rawPsid);
    expect(serializedLogs).not.toContain(rawPhone);
    expect(serializedLogs).not.toContain(rawPageId);
    expect(serializedLogs).not.toContain(rawPrompt);
    expect(serializedLogs).not.toContain("handler exploded");

    await vi.advanceTimersByTimeAsync(10);

    await vi.waitFor(() => {
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(2);
    });
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(processFacebookWebhookPayloadMock).toHaveBeenNthCalledWith(2, {
      entry: [{ id: "failed" }],
    });
  });

  it("requeues safely when error metadata access throws", async () => {
    vi.useFakeTimers();
    isRedisEnabledMock.mockReturnValue(true);
    const processingError = new Error("private handler failure");
    Object.defineProperty(processingError, "code", {
      get() {
        throw new TypeError("code accessor failed");
      },
    });
    processFacebookWebhookPayloadMock
      .mockRejectedValueOnce(processingError)
      .mockResolvedValueOnce(undefined);

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "throwing-error-metadata" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.rpush).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:queued",
        expect.any(String)
      );
    });
    expect(processing).toEqual([]);
    expect(queue).toHaveLength(1);
    expect(dead).toEqual([]);
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.objectContaining({
        error: { class: "UnknownError" },
      })
    );
  });

  it("requeues safely when error classification throws", async () => {
    vi.useFakeTimers();
    isRedisEnabledMock.mockReturnValue(true);
    const processingError = new Proxy(new Error("private handler failure"), {
      getPrototypeOf() {
        throw new TypeError("prototype lookup failed");
      },
    });
    processFacebookWebhookPayloadMock
      .mockRejectedValueOnce(processingError)
      .mockResolvedValueOnce(undefined);

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "throwing-error-classification" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.rpush).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:queued",
        expect.any(String)
      );
    });
    expect(processing).toEqual([]);
    expect(queue).toHaveLength(1);
    expect(dead).toEqual([]);
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.objectContaining({
        error: { class: "UnknownError" },
      })
    );
  });

  it("keeps a failed delivery in processing when retry storage fails", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock.mockRejectedValue(new Error("retry me"));

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "retry-store-failed" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    redis.eval.mockRejectedValueOnce(new Error("redis write failed"));
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(safeLogMock).toHaveBeenCalledWith(
        "webhook_ingress_queue_drain_failed",
        expect.objectContaining({
          error: expect.objectContaining({
            class: "Error",
          }),
        })
      );
    });

    expect(queue).toEqual([]);
    expect(processing).toEqual([delivery]);
    expect(dead).toEqual([]);
    expect(redis.lrem).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.rpush).not.toHaveBeenCalled();
    expect(safeLogMock).not.toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.any(Object)
    );
  });

  it("requeues a failed delivery with an incremented attempt count", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "2";
    processWhatsAppWebhookPayloadMock.mockRejectedValue(new Error("try again"));

    const delivery = JSON.stringify({
      channel: "whatsapp",
      payload: { entry: [{ id: "retry" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
      attempts: 1,
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.rpush).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:dead",
        expect.any(String)
      );
    });

    expect(queue).toHaveLength(0);
    expect(processing).toEqual([]);
    expect(dead).toHaveLength(1);
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_dead_lettered",
      expect.objectContaining({
        channel: "whatsapp",
        attempts: 2,
        error: expect.objectContaining({
          class: "Error",
        }),
      })
    );
  });

  it("moves a delivery to dead-letter after max attempts", async () => {
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "2";
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock
      .mockRejectedValueOnce(new RangeError("too many"))
      .mockResolvedValueOnce(undefined);

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "dead" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
      attempts: 1,
    });
    const nextDelivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "next" }] },
      receivedAt: "2026-05-28T00:00:01.000Z",
    });
    const queue = [delivery, nextDelivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.rpush).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:dead",
        expect.any(String)
      );
    });
    await vi.waitFor(() => {
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(2);
    });

    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0])).toMatchObject({
      channel: "facebook",
      attempts: 2,
    });
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(processFacebookWebhookPayloadMock).toHaveBeenNthCalledWith(2, {
      entry: [{ id: "next" }],
    });
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_dead_lettered",
      expect.objectContaining({
        channel: "facebook",
        attempts: 2,
        error: expect.objectContaining({
          class: "RangeError",
        }),
      })
    );
  });

  it("completes a successful delivery without requeueing or dead-lettering it", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock.mockResolvedValue(undefined);

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "ok" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.lmove).toHaveBeenCalledTimes(2);
    });

    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.rpush).not.toHaveBeenCalled();
    expect(processFacebookWebhookPayloadMock).toHaveBeenCalledWith({
      entry: [{ id: "ok" }],
    });
  });

  it("does not requeue a delivery when completion fails after successful processing", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock.mockResolvedValue(undefined);

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "complete-failed" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead);
    redis.lrem.mockRejectedValueOnce(new Error("redis unavailable"));
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(safeLogMock).toHaveBeenCalledWith(
        "webhook_ingress_queue_drain_failed",
        expect.objectContaining({
          error: expect.objectContaining({
            class: "Error",
          }),
        })
      );
    });

    expect(processFacebookWebhookPayloadMock).toHaveBeenCalledWith({
      entry: [{ id: "complete-failed" }],
    });
    expect(processing).toEqual([delivery]);
    expect(queue).toEqual([]);
    expect(dead).toEqual([]);
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(redis.rpush).not.toHaveBeenCalled();
    expect(safeLogMock).not.toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.any(Object)
    );
  });

  it("does not remove a failed delivery when atomic requeue preflight fails", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock.mockRejectedValue(
      new Error("callback failed")
    );

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "requeue-preflight-failed" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead, {
      destinationType: "string",
    });
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(safeLogMock).toHaveBeenCalledWith(
        "webhook_ingress_queue_drain_failed",
        expect.objectContaining({
          error: expect.objectContaining({
            class: "Error",
          }),
        })
      );
    });

    expect(processing).toEqual([delivery]);
    expect(queue).toEqual([]);
    expect(dead).toEqual([]);
    expect(redis.lpush).not.toHaveBeenCalledWith(
      "{meta-webhook-ingress}:queued",
      expect.any(String)
    );
  });

  it("does not remove a failed delivery when the atomic retry push fails", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock.mockRejectedValue(
      new Error("callback failed")
    );

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "requeue-push-failed" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue = [delivery];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = createQueueRedis(queue, processing, dead, {
      pushError: new Error(
        "OOM command not allowed when used memory > maxmemory"
      ),
    });
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(safeLogMock).toHaveBeenCalledWith(
        "webhook_ingress_queue_drain_failed",
        expect.objectContaining({
          error: expect.objectContaining({
            class: "Error",
          }),
        })
      );
    });

    expect(processing).toEqual([delivery]);
    expect(queue).toEqual([]);
    expect(dead).toEqual([]);
    expect(redis.lrem).not.toHaveBeenCalledWith(
      "{meta-webhook-ingress}:processing",
      1,
      delivery
    );
  });

  it("reclaims processing deliveries whose lease expired before draining", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    const expiredDelivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "expired" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue: string[] = [];
    const processing = [expiredDelivery];
    const redis = {
      del: vi.fn(async () => 1),
      get: vi.fn(async () => null),
      lpush: vi.fn(async (_key: string, value: string) => {
        queue.unshift(value);
        return queue.length;
      }),
      lrange: vi.fn(async () => [...processing]),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
      lmove: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
    };
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.lpush).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:queued",
        expiredDelivery
      );
    });
    expect(queue).toEqual([expiredDelivery]);
    expect(processing).toEqual([]);
  });

  it("does not duplicate a delivery if another drain already reclaimed it", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    const expiredDelivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "expired" }] },
      receivedAt: "2026-05-28T00:00:00.000Z",
    });
    const queue: string[] = [];
    const redis = {
      del: vi.fn(async () => 1),
      get: vi.fn(async () => null),
      lpush: vi.fn(async (_key: string, value: string) => {
        queue.unshift(value);
        return queue.length;
      }),
      lrange: vi.fn(async () => [expiredDelivery]),
      lrem: vi.fn(async () => 0),
      lmove: vi.fn(async () => null),
      set: vi.fn(async () => "OK"),
    };
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(redis.lrem).toHaveBeenCalledWith(
        "{meta-webhook-ingress}:processing",
        1,
        expiredDelivery
      );
    });
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(queue).toEqual([]);
  });
});

function createQueueRedis(
  queue: string[],
  processing: string[],
  dead: string[],
  types: {
    processingType?: "none" | "list" | "string";
    leaseType?: "none" | "string" | "list";
    destinationType?: "none" | "list" | "string";
    pushError?: Error;
    beforePersistedTransition?: (
      tombstoneKeys: string[],
      stored: Map<string, string>
    ) => void;
  } = {},
  storedEntries: Array<[string, string]> = []
) {
  const leases = new Map<string, string>();
  const stored = new Map(storedEntries);

  const redis = {
    del: vi.fn(async (key: string) => {
      leases.delete(key);
      stored.delete(key);
      return 1;
    }),
    get: vi.fn(
      async (key: string) => stored.get(key) ?? leases.get(key) ?? null
    ),
    lpush: vi.fn(async (key: string, value: string) => {
      if (key === "{meta-webhook-ingress}:queued") {
        queue.unshift(value);
        return queue.length;
      }
      return 0;
    }),
    lrange: vi.fn(async () => []),
    lrem: vi.fn(async (_key: string, _count: number, value: string) => {
      const index = processing.indexOf(value);
      if (index === -1) return 0;
      processing.splice(index, 1);
      return 1;
    }),
    lmove: vi.fn(async () => {
      const value = queue.shift() ?? null;
      if (value) {
        processing.push(value);
      }
      return value;
    }),
    rpush: vi.fn(async (key: string, value: string) => {
      if (key === "{meta-webhook-ingress}:dead") {
        dead.push(value);
        return dead.length;
      }
      queue.push(value);
      return queue.length;
    }),
    srem: vi.fn(async () => 1),
    set: vi.fn(async (key: string, value: string) => {
      if (key.startsWith("{meta-webhook-ingress}:delivery:")) {
        stored.set(key, value);
      } else {
        leases.set(key, value);
      }
      return "OK";
    }),
  };

  return {
    ...redis,
    eval: vi.fn(
      async (
        _script: string,
        numKeys: number,
        _processingKey: string,
        leaseKey: string,
        destinationKey: string,
        ...remaining: string[]
      ) => {
        if (numKeys > 3) {
          const subjectCount = (numKeys - 4) / 2;
          const contentKey = remaining[0];
          const subjectIndexKeys = remaining.slice(1, 1 + subjectCount);
          const tombstoneKeys = remaining.slice(
            1 + subjectCount,
            1 + subjectCount * 2
          );
          const args = remaining.slice(numKeys - 3);
          const [
            rawDelivery,
            action,
            serializedDelivery,
            _deadMaxItems,
            expiresAt,
            now,
            _serializedSubjectCount,
            ...privacyEpochs
          ] = args;
          types.beforePersistedTransition?.(tombstoneKeys, stored);
          const erased =
            Number(expiresAt) <= Number(now) ||
            tombstoneKeys.some(
              (key, index) =>
                Number(stored.get(key) ?? "0") >=
                Number(privacyEpochs[index] ?? "0")
            );
          if (erased) {
            for (let index = processing.length - 1; index >= 0; index -= 1) {
              if (processing[index] === rawDelivery)
                processing.splice(index, 1);
            }
            for (const list of [queue, dead]) {
              for (let index = list.length - 1; index >= 0; index -= 1) {
                if (list[index] === rawDelivery) list.splice(index, 1);
              }
            }
            leases.delete(leaseKey);
            stored.delete(contentKey);
            return -1;
          }

          if (!processing.includes(rawDelivery)) return 0;
          if (types.pushError) throw types.pushError;
          if (action === "dead") {
            dead.push(rawDelivery);
            stored.delete(contentKey);
          } else {
            queue.push(rawDelivery);
            stored.set(contentKey, serializedDelivery);
          }
          const index = processing.indexOf(rawDelivery);
          processing.splice(index, 1);
          leases.delete(leaseKey);
          void subjectIndexKeys;
          return action === "dead" ? 2 : 1;
        }

        const [rawDelivery, pushDirection, serializedDelivery] = remaining;
        const processingType = types.processingType ?? "list";
        if (processingType !== "none" && processingType !== "list") {
          throw new Error("processing key is not a list");
        }
        const leaseType = types.leaseType ?? "string";
        if (leaseType !== "none" && leaseType !== "string") {
          throw new Error("lease key is not a string");
        }
        const destinationType = types.destinationType ?? "list";
        if (destinationType !== "none" && destinationType !== "list") {
          throw new Error("destination key is not a list");
        }

        if (!processing.includes(rawDelivery)) {
          return 0;
        }

        if (types.pushError) {
          throw types.pushError;
        }
        if (pushDirection === "LPUSH") {
          await redis.lpush(destinationKey, serializedDelivery);
        } else {
          await redis.rpush(destinationKey, serializedDelivery);
        }

        const removed = await redis.lrem(
          "{meta-webhook-ingress}:processing",
          1,
          rawDelivery
        );
        if (removed <= 0) {
          return removed;
        }

        await redis.del(leaseKey);
        return removed;
      }
    ),
  };
}
