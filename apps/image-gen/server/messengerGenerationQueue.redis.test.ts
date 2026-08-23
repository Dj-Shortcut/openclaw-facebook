import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  drainMessengerGenerationQueue,
  enqueueMessengerGenerationJob,
  eraseMessengerGenerationJobsForSubject,
  ensureMessengerGenerationQueueReady,
  reclaimReservedMessengerGenerationJobs,
} from "./_core/messengerGenerationQueue";
import {
  createMessengerGenerationOwnershipPartition,
  createMessengerGenerationTenantPartition,
} from "./_core/messengerGenerationJob";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const originalQueueWriteVersion =
  process.env.MESSENGER_GENERATION_QUEUE_WRITE_VERSION;
const originalOpenAiTimeoutMs = process.env.OPENAI_IMAGE_TIMEOUT_MS;
const originalOpenAiMaxRetries = process.env.OPENAI_IMAGE_MAX_RETRIES;
const originalLeaseHeartbeatMs =
  process.env.MESSENGER_GENERATION_LEASE_HEARTBEAT_MS;

suite("Redis Messenger generation privacy fences", () => {
  beforeAll(() => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/14";
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_PARTITION_SECRET =
      "redis-generation-partition-secret";
    process.env.MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v2";
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
    restoreEnv(
      "MESSENGER_GENERATION_QUEUE_WRITE_VERSION",
      originalQueueWriteVersion
    );
    restoreEnv("OPENAI_IMAGE_TIMEOUT_MS", originalOpenAiTimeoutMs);
    restoreEnv("OPENAI_IMAGE_MAX_RETRIES", originalOpenAiMaxRetries);
    restoreEnv(
      "MESSENGER_GENERATION_LEASE_HEARTBEAT_MS",
      originalLeaseHeartbeatMs
    );
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

  it("keeps v2 jobs invisible to a v1-only reader", async () => {
    const job = {
      psid: "namespace-psid",
      userId: "namespace-user",
      pageId: "namespace-page",
      reqId: "namespace-v2-job",
      lang: "nl" as const,
      workspaceId: 801,
      channelConnectionId: 802,
      bindingEpoch: 1,
      privacyEpoch: 1,
    };
    await enqueueMessengerGenerationJob(job);
    const redis = await getRedisClient();
    const [partition] = await redis.smembers(
      "messenger-generation-job-partitions:v2"
    );
    expect(partition).toBeTruthy();
    expect(
      await redis.smembers("messenger-generation-job-partitions:v1")
    ).not.toContain(partition);
    await expect(
      redis.rpoplpush(
        `messenger-generation-jobs:{${partition}}:queued`,
        `messenger-generation-jobs:{${partition}}:processing`
      )
    ).resolves.toBeNull();

    const processorCalls: string[] = [];
    await drainMessengerGenerationQueue(async drained => {
      processorCalls.push(drained.reqId);
    });
    expect(processorCalls).toEqual([job.reqId]);
  });

  it("drains a legacy v1 partition with the dual reader", async () => {
    const job = buildPartitionedJob({
      psid: "legacy-v1-psid",
      userId: "legacy-v1-user",
      pageId: "legacy-v1-page",
      reqId: "legacy-v1-job",
      workspaceId: 811,
      channelConnectionId: 812,
    });
    const redis = await getRedisClient();
    await redis.sadd(
      "messenger-generation-job-partitions:v1",
      job.tenantPartition
    );
    await redis.lpush(
      `messenger-generation-jobs:{${job.tenantPartition}}:queued`,
      JSON.stringify(job)
    );
    const processorCalls: string[] = [];

    await drainMessengerGenerationQueue(async drained => {
      processorCalls.push(drained.reqId);
    });

    expect(processorCalls).toEqual([job.reqId]);
    expect(
      await redis.llen(
        `messenger-generation-jobs:{${job.tenantPartition}}:queued`
      )
    ).toBe(0);
  });

  it("erases the same subject from both queue namespaces", async () => {
    const v1Job = buildPartitionedJob({
      psid: "dual-erase-psid",
      userId: "dual-erase-user",
      pageId: "dual-erase-page",
      reqId: "dual-erase-v1",
      workspaceId: 816,
      channelConnectionId: 817,
    });
    await enqueueMessengerGenerationJob({
      ...v1Job,
      reqId: "dual-erase-v2",
      tenantPartition: undefined,
      createdAt: undefined,
      expiresAt: undefined,
    });
    const redis = await getRedisClient();
    const v1Token = jobToken(v1Job.userId, v1Job.privacyEpoch, v1Job.reqId);
    const v1Reference = `job-${v1Token}`;
    const v1Prefix = `messenger-generation-jobs:{${v1Job.tenantPartition}}`;
    const subjectDigest = createHash("sha256")
      .update(v1Job.userId)
      .digest("hex");
    await redis.sadd(
      "messenger-generation-job-partitions:v1",
      v1Job.tenantPartition
    );
    await redis.set(
      `${v1Prefix}:content:${v1Token}`,
      JSON.stringify(v1Job),
      "EX",
      60
    );
    await redis.lpush(`${v1Prefix}:queued`, v1Reference);
    await redis.sadd(`${v1Prefix}:subject:${subjectDigest}`, v1Reference);

    await expect(
      eraseMessengerGenerationJobsForSubject({
        workspaceId: v1Job.workspaceId,
        channelConnectionId: v1Job.channelConnectionId,
        bindingEpoch: v1Job.bindingEpoch,
        privacyEpoch: v1Job.privacyEpoch,
        pageId: v1Job.pageId,
        userKey: v1Job.userId,
      })
    ).resolves.toBe(2);
    expect(await scanAll("messenger-generation-jobs:*:content:*")).toHaveLength(
      0
    );
    expect(
      await scanAll("messenger-generation-jobs:*:v2:content:*")
    ).toHaveLength(0);
  });

  it("renews a shortened real Redis lease while processing stays active", async () => {
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "1";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    process.env.MESSENGER_GENERATION_LEASE_HEARTBEAT_MS = "200";
    const job = {
      psid: "heartbeat-psid",
      userId: "heartbeat-user",
      pageId: "heartbeat-page",
      reqId: "heartbeat-real-redis",
      lang: "nl" as const,
      workspaceId: 821,
      channelConnectionId: 822,
      bindingEpoch: 1,
      privacyEpoch: 1,
    };
    await enqueueMessengerGenerationJob(job);
    const redis = await getRedisClient();
    let releaseProcessor!: () => void;
    let enteredProcessor!: () => void;
    const entered = new Promise<void>(resolve => {
      enteredProcessor = resolve;
    });
    const draining = drainMessengerGenerationQueue(async () => {
      enteredProcessor();
      await new Promise<void>(resolve => {
        releaseProcessor = resolve;
      });
    });
    try {
      await entered;
      const [leaseKey] = await scanAll(
        "messenger-generation-jobs:*:v2:lease:*"
      );
      expect(leaseKey).toBeTruthy();
      await redis.expire(leaseKey!, 1);

      await new Promise(resolve => setTimeout(resolve, 1_500));
      expect(await redis.ttl(leaseKey!)).toBeGreaterThan(1);
      await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(0);
    } finally {
      releaseProcessor?.();
      await draining;
      delete process.env.OPENAI_IMAGE_TIMEOUT_MS;
      delete process.env.OPENAI_IMAGE_MAX_RETRIES;
      delete process.env.MESSENGER_GENERATION_LEASE_HEARTBEAT_MS;
    }
  });

  it("reclaims a real Redis processing job after heartbeats stop", async () => {
    const job = buildPartitionedJob({
      psid: "expired-heartbeat-psid",
      userId: "expired-heartbeat-user",
      pageId: "expired-heartbeat-page",
      reqId: "expired-heartbeat-job",
      workspaceId: 831,
      channelConnectionId: 832,
    });
    const token = jobToken(job.userId, job.privacyEpoch, job.reqId);
    const reference = `job-${token}`;
    const prefix = `messenger-generation-jobs:{${job.tenantPartition}}:v2`;
    const redis = await getRedisClient();
    await redis.sadd(
      "messenger-generation-job-partitions:v2",
      job.tenantPartition
    );
    await redis.set(
      `${prefix}:content:${token}`,
      JSON.stringify(job),
      "EX",
      60
    );
    await redis.lpush(`${prefix}:processing`, reference);
    await redis.set(`${prefix}:lease:${token}`, "stopped-owner", "EX", 1);

    await new Promise(resolve => setTimeout(resolve, 1_100));
    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(1);
    expect(await redis.llen(`${prefix}:processing`)).toBe(0);
    expect(await redis.llen(`${prefix}:queued`)).toBe(1);
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function jobToken(userId: string, privacyEpoch: number, reqId: string): string {
  return createHash("sha256")
    .update(`${userId}\0${privacyEpoch}\0${reqId}`)
    .digest("hex");
}

function buildPartitionedJob(input: {
  psid: string;
  userId: string;
  pageId: string;
  reqId: string;
  workspaceId: number;
  channelConnectionId: number;
}) {
  const bindingEpoch = 1;
  const privacyEpoch = 1;
  const tenantPartition = createMessengerGenerationOwnershipPartition(
    {
      workspaceId: input.workspaceId,
      channelConnectionId: input.channelConnectionId,
      bindingEpoch,
      privacyEpoch,
      pageId: input.pageId,
    },
    "redis-generation-partition-secret"
  );
  return {
    ...input,
    lang: "nl" as const,
    bindingEpoch,
    privacyEpoch,
    tenantPartition,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}
