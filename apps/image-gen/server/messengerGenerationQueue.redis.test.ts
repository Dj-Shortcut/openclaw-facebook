import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  drainMessengerGenerationQueue,
  enqueueMessengerGenerationJob,
  eraseMessengerGenerationJobsForSubject,
  ensureMessengerGenerationQueueReady,
} from "./_core/messengerGenerationQueue";
import { createMessengerGenerationTenantPartition } from "./_core/messengerGenerationJob";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;

suite("Redis Messenger generation privacy fences", () => {
  beforeAll(() => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/14";
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_PARTITION_SECRET =
      "redis-generation-partition-secret";
  });

  beforeEach(async () => {
    const redis = await getRedisClient();
    await redis.eval("return redis.call('FLUSHDB')", 0);
  });

  afterAll(() => {
    delete process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
    delete process.env.MESSENGER_GENERATION_INLINE_FALLBACK;
    delete process.env.MESSENGER_GENERATION_PARTITION_SECRET;
    delete process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    resetRedisClientForTests();
  });

  it("atomically scrubs queued content and permanently blocks the erased epoch", async () => {
    const job = {
      psid: "redis-private-psid",
      userId: "redis-private-user-key",
      pageId: "redis-page",
      reqId: "redis-erasure-race",
      lang: "nl",
      workspaceId: 501,
      channelConnectionId: 502,
      bindingEpoch: 3,
      privacyEpoch: 7,
      prompt: "redis-private-prompt-sentinel",
    };
    await expect(enqueueMessengerGenerationJob(job)).resolves.toBe(true);
    await expect(
      eraseMessengerGenerationJobsForSubject({
        workspaceId: job.workspaceId,
        channelConnectionId: job.channelConnectionId,
        bindingEpoch: job.bindingEpoch,
        privacyEpoch: job.privacyEpoch,
        pageId: job.pageId,
        userKey: job.userId,
      })
    ).resolves.toBe(1);
    await expect(
      enqueueMessengerGenerationJob({ ...job, reqId: "redis-old-replay" })
    ).rejects.toThrow("subject epoch is erased");

    const redis = await getRedisClient();
    const keys = await scanAll("*");
    for (const key of keys) {
      const value = await redis.get(key).catch(() => null);
      expect(value ?? "").not.toContain("redis-private-prompt-sentinel");
      expect(value ?? "").not.toContain("redis-private-psid");
    }
  });

  it("leaves no old-epoch content when enqueue races erasure", async () => {
    const base = {
      psid: "race-private-psid",
      userId: "race-private-user",
      pageId: "race-page",
      lang: "nl" as const,
      workspaceId: 551,
      channelConnectionId: 552,
      bindingEpoch: 1,
      privacyEpoch: 2,
    };
    await enqueueMessengerGenerationJob({ ...base, reqId: "race-seed" });
    await Promise.allSettled([
      enqueueMessengerGenerationJob({ ...base, reqId: "race-concurrent" }),
      eraseMessengerGenerationJobsForSubject({
        workspaceId: base.workspaceId,
        channelConnectionId: base.channelConnectionId,
        bindingEpoch: base.bindingEpoch,
        privacyEpoch: base.privacyEpoch,
        pageId: base.pageId,
        userKey: base.userId,
      }),
    ]);
    await expect(
      enqueueMessengerGenerationJob({ ...base, reqId: "race-replay" })
    ).rejects.toThrow("subject epoch is erased");
    const redis = await getRedisClient();
    const contentKeys = await scanAll("messenger-generation-jobs:*:content:*");
    expect(contentKeys).toHaveLength(0);
    const allKeys = await scanAll("*");
    for (const key of allKeys) {
      const value = await redis.get(key).catch(() => null);
      expect(value ?? "").not.toContain("race-private-psid");
    }
  });

  it("blocks legacy and partitioned raw payloads at readiness", async () => {
    const redis = await getRedisClient();
    await redis.lpush("messenger-generation-jobs", '{"psid":"legacy"}');
    await expect(ensureMessengerGenerationQueueReady()).rejects.toThrow(
      "must be purged"
    );
    await redis.del("messenger-generation-jobs");
    await redis.set("messenger-generation-privacy-index-version", "v2");
    const partition = createMessengerGenerationTenantPartition(
      "raw-page",
      "redis-generation-partition-secret"
    );
    await redis.sadd("messenger-generation-job-partitions:v1", partition);
    await redis.lpush(
      `messenger-generation-jobs:{${partition}}:queued`,
      '{"psid":"partitioned-raw"}'
    );
    await expect(ensureMessengerGenerationQueueReady()).rejects.toThrow(
      "Raw Messenger generation payloads must be purged"
    );
  });

  it("never extends the immutable content deadline on retry", async () => {
    process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS = "3600";
    const job = {
      psid: "retry-psid",
      userId: "retry-user",
      pageId: "retry-page",
      reqId: "retry-deadline",
      lang: "nl",
      workspaceId: 601,
      channelConnectionId: 602,
      bindingEpoch: 1,
      privacyEpoch: 1,
    };
    await enqueueMessengerGenerationJob(job);
    const redis = await getRedisClient();
    const [, keys] = await redis.scan(
      "0",
      "MATCH",
      "messenger-generation-jobs:*:content:*",
      "COUNT",
      500
    );
    const contentKey = keys[0]!;
    const before = await redis.ttl(contentKey);
    await drainMessengerGenerationQueue(async () => {
      throw new Error("known test failure");
    });
    const after = await redis.ttl(contentKey);
    expect(after).toBeLessThanOrEqual(before);
    delete process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS;
  });

  it("does not shorten a shared subject index deadline when an older job retries", async () => {
    const base = {
      psid: "shared-ttl-psid",
      userId: "shared-ttl-user",
      pageId: "shared-ttl-page",
      lang: "nl" as const,
      workspaceId: 701,
      channelConnectionId: 702,
      bindingEpoch: 1,
      privacyEpoch: 1,
    };
    process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS = "3600";
    await enqueueMessengerGenerationJob({ ...base, reqId: "ttl-older" });
    process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS = "7200";
    await enqueueMessengerGenerationJob({ ...base, reqId: "ttl-newer" });
    const redis = await getRedisClient();
    const subjectKeys = await scanAll("messenger-generation-jobs:*:subject:*");
    expect(subjectKeys).toHaveLength(1);
    const before = await redis.ttl(subjectKeys[0]!);
    await drainMessengerGenerationQueue(async () => {
      throw new Error("retry older job");
    });
    const after = await redis.ttl(subjectKeys[0]!);
    expect(after).toBeGreaterThanOrEqual(before - 1);
    delete process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS;
  });
});

async function scanAll(pattern: string): Promise<string[]> {
  const redis = await getRedisClient();
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      500
    );
    found.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return found;
}
