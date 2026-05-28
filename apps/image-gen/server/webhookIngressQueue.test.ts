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
    const redis = {
      lpop: vi.fn(async () => deliveries.shift() ?? null),
    };
    getRedisClientMock.mockResolvedValue(redis);

    scheduleWebhookIngressDrain();

    await vi.waitFor(() => {
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(1);
    });
    expect(redis.lpop).toHaveBeenCalledTimes(1);

    releaseFirstDelivery?.();

    await vi.waitFor(() => {
      expect(processFacebookWebhookPayloadMock).toHaveBeenCalledTimes(2);
    });
    expect(redis.lpop).toHaveBeenCalledTimes(3);
    expect(processFacebookWebhookPayloadMock).toHaveBeenNthCalledWith(1, {
      entry: [{ id: "first" }],
    });
    expect(processFacebookWebhookPayloadMock).toHaveBeenNthCalledWith(2, {
      entry: [{ id: "second" }],
    });
  });
});
