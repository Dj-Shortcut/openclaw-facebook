import { afterEach, describe, expect, it, vi } from "vitest";

const {
  getRedisClientMock,
  isRedisEnabledMock,
  processFacebookWebhookPayloadMock,
  processWhatsAppWebhookPayloadMock,
} = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(() => false),
  processFacebookWebhookPayloadMock: vi.fn(),
  processWhatsAppWebhookPayloadMock: vi.fn(),
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
  afterEach(() => {
    getRedisClientMock.mockReset();
    isRedisEnabledMock.mockReset();
    isRedisEnabledMock.mockReturnValue(false);
    processFacebookWebhookPayloadMock.mockReset();
    processWhatsAppWebhookPayloadMock.mockReset();
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
