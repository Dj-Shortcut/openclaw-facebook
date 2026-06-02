import { afterEach, describe, expect, it, vi } from "vitest";

const {
  getRedisClientMock,
  isRedisEnabledMock,
  safeLogMock,
  processFacebookWebhookPayloadMock,
  processWhatsAppWebhookPayloadMock,
} = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(() => false),
  safeLogMock: vi.fn(),
  processFacebookWebhookPayloadMock: vi.fn(),
  processWhatsAppWebhookPayloadMock: vi.fn(),
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

import {
  resetWebhookIngressQueueForTests,
  scheduleWebhookIngressDrain,
} from "./_core/meta/webhookIngressQueue";

describe("webhookIngressQueue", () => {
  const originalMaxAttempts = process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;

  afterEach(() => {
    getRedisClientMock.mockReset();
    isRedisEnabledMock.mockReset();
    isRedisEnabledMock.mockReturnValue(false);
    processFacebookWebhookPayloadMock.mockReset();
    processWhatsAppWebhookPayloadMock.mockReset();
    safeLogMock.mockReset();
    if (originalMaxAttempts === undefined) {
      delete process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;
    } else {
      process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = originalMaxAttempts;
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

  it("does not silently complete a delivery when processing fails", async () => {
    isRedisEnabledMock.mockReturnValue(true);
    const processingError = new TypeError("handler exploded");
    processFacebookWebhookPayloadMock.mockRejectedValue(processingError);

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
      expect(redis.lpush).toHaveBeenCalledWith(
        "meta-webhook-ingress",
        expect.any(String)
      );
    });

    expect(processing).toEqual([]);
    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0])).toMatchObject({
      channel: "facebook",
      attempts: 1,
      payload: { entry: [{ id: "failed" }] },
    });
    expect(dead).toEqual([]);
    expect(safeLogMock).not.toHaveBeenCalledWith(
      "webhook_async_processing_failed",
      expect.any(Object)
    );
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.objectContaining({
        channel: "facebook",
        attempts: 1,
        error: expect.objectContaining({
          class: "TypeError",
          message: "handler exploded",
        }),
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
            message: "redis write failed",
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
      expect(redis.lpush).toHaveBeenCalledWith(
        "meta-webhook-ingress",
        expect.any(String)
      );
    });

    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0])).toMatchObject({
      channel: "whatsapp",
      attempts: 2,
    });
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_requeued",
      expect.objectContaining({
        channel: "whatsapp",
        attempts: 2,
        error: expect.objectContaining({
          class: "Error",
          message: "try again",
        }),
      })
    );
  });

  it("moves a delivery to dead-letter after max attempts", async () => {
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "2";
    isRedisEnabledMock.mockReturnValue(true);
    processFacebookWebhookPayloadMock.mockRejectedValue(
      new RangeError("too many")
    );

    const delivery = JSON.stringify({
      channel: "facebook",
      payload: { entry: [{ id: "dead" }] },
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
        "meta-webhook-ingress:dead",
        expect.any(String)
      );
    });

    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0])).toMatchObject({
      channel: "facebook",
      attempts: 2,
    });
    expect(redis.lpush).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "webhook_queued_delivery_dead_lettered",
      expect.objectContaining({
        channel: "facebook",
        attempts: 2,
        error: expect.objectContaining({
          class: "RangeError",
          message: "too many",
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
            message: "redis unavailable",
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
    processFacebookWebhookPayloadMock.mockRejectedValue(new Error("callback failed"));

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
            message: "destination key is not a list",
          }),
        })
      );
    });

    expect(processing).toEqual([delivery]);
    expect(queue).toEqual([]);
    expect(dead).toEqual([]);
    expect(redis.lpush).not.toHaveBeenCalledWith(
      "meta-webhook-ingress",
      expect.any(String)
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
        "meta-webhook-ingress",
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
        "meta-webhook-ingress:processing",
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
  } = {}
) {
  const leases = new Map<string, string>();

  const redis = {
    del: vi.fn(async (key: string) => {
      leases.delete(key);
      return 1;
    }),
    get: vi.fn(async (key: string) => leases.get(key) ?? null),
    lpush: vi.fn(async (key: string, value: string) => {
      if (key === "meta-webhook-ingress") {
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
      if (key === "meta-webhook-ingress:dead") {
        dead.push(value);
        return dead.length;
      }
      queue.push(value);
      return queue.length;
    }),
    set: vi.fn(async (key: string, value: string) => {
      leases.set(key, value);
      return "OK";
    }),
  };

  return {
    ...redis,
    eval: vi.fn(
      async (
        _script: string,
        _numKeys: number,
        _processingKey: string,
        leaseKey: string,
        destinationKey: string,
        rawDelivery: string,
        pushDirection: string,
        serializedDelivery: string
      ) => {
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

        const removed = await redis.lrem(
          "meta-webhook-ingress:processing",
          1,
          rawDelivery
        );
        if (removed <= 0) {
          return removed;
        }

        await redis.del(leaseKey);
        if (pushDirection === "LPUSH") {
          await redis.lpush(destinationKey, serializedDelivery);
        } else {
          await redis.rpush(destinationKey, serializedDelivery);
        }
        return removed;
      }
    ),
  };
}
