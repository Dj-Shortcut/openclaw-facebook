import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveOwnershipMock, ensurePrivacyMock } = vi.hoisted(() => ({
  resolveOwnershipMock: vi.fn(),
  ensurePrivacyMock: vi.fn(async () => 1),
}));

vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  resolveMessengerGenerationOwnership: resolveOwnershipMock,
}));
vi.mock("./_core/messengerPrivacySubject", () => ({
  ensureActiveMessengerPrivacySubject: ensurePrivacyMock,
}));

import {
  enqueueWebhookIngressDelivery,
  eraseWebhookIngressDeliveriesForSubject,
  resetWebhookIngressQueueForTests,
} from "./_core/meta/webhookIngressQueue";
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
