import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRedisClientMock, isRedisEnabledMock } = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(() => false),
}));

vi.mock("./_core/redis", () => ({
  getRedisClient: getRedisClientMock,
  isRedisEnabled: isRedisEnabledMock,
}));

import {
  assertMessengerGenerationQueueConfig,
  drainMessengerGenerationQueue,
  enqueueMessengerGenerationJob,
  enqueueOrRunMessengerGenerationJob,
  getMessengerGenerationQueueStats,
  isMessengerGenerationQueueEnabled,
  reclaimReservedMessengerGenerationJobs,
  resetMessengerGenerationQueueForTests,
  scheduleMessengerGenerationQueueDrain,
} from "./_core/messengerGenerationQueue";
import {
  getTodayRuntimeStats,
  resetRuntimeStatsForTests,
} from "./_core/botRuntimeStats";
import {
  createMessengerGenerationTenantPartition,
  type MessengerGenerationJob,
} from "./_core/messengerGenerationJob";

const TEST_PARTITION_SECRET = "queue-partition-test-secret";

function getTenantPartition(pageId: string): string {
  return createMessengerGenerationTenantPartition(
    pageId,
    TEST_PARTITION_SECRET
  );
}

function getJobKeyToken(reqId: string): string {
  return createHash("sha256").update(reqId).digest("hex");
}

function getPartitionKey(
  tenantPartition: string,
  state: "queued" | "processing" | "dead"
): string {
  return `messenger-generation-jobs:{${tenantPartition}}:${state}`;
}

function createJob(
  overrides: Partial<MessengerGenerationJob> = {}
): MessengerGenerationJob {
  return {
    psid: "psid-1",
    userId: "user-1",
    pageId: "page-1",
    reqId: "req-1",
    lang: "nl",
    ...overrides,
  };
}

function createDrainRedis(
  queue: string[],
  options: {
    processing?: string[];
    dead?: string[];
    leases?: Record<string, string>;
  } = {}
) {
  const processing = options.processing ?? [];
  const dead = options.dead ?? [];
  const leases = new Map<string, string>(Object.entries(options.leases ?? {}));
  const redis = {
    del: vi.fn(async (key: string) => {
      const existed = leases.delete(key);
      return existed ? 1 : 0;
    }),
    get: vi.fn(async (key: string) => leases.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      leases.set(key, value);
      return "OK";
    }),
    llen: vi.fn(async (key: string) => {
      if (key.endsWith(":processing")) return processing.length;
      if (key.endsWith(":dead")) return dead.length;
      return queue.length;
    }),
    lrem: vi.fn(async (_key: string, _count: number, value: string) => {
      const index = processing.indexOf(value);
      if (index === -1) return 0;
      processing.splice(index, 1);
      return 1;
    }),
    lpush: vi.fn(async (key: string, value: string) => {
      if (key.endsWith(":processing")) {
        processing.unshift(value);
      } else {
        queue.unshift(value);
      }
      return queue.length;
    }),
    lrange: vi.fn(async () => [...processing]),
    rpoplpush: vi.fn(async () => {
      const value = queue.pop() ?? null;
      if (value) {
        processing.unshift(value);
      }
      return value;
    }),
    rpush: vi.fn(async (_key: string, value: string) => {
      dead.push(value);
      return dead.length;
    }),
    sadd: vi.fn(async () => 0),
    smembers: vi.fn(async () => []),
  };

  return { dead, processing, redis };
}

function createKeyedRedis(
  initialLists: Record<string, string[]> = {},
  initialTenantPartitions: string[] = [],
  options: { failingListKeys?: string[] } = {}
) {
  const lists = new Map(
    Object.entries(initialLists).map(([key, values]) => [key, [...values]])
  );
  const strings = new Map<string, string>();
  const expirations = new Map<string, number>();
  const tenantPartitions = new Set(initialTenantPartitions);
  const failingListKeys = new Set(options.failingListKeys ?? []);
  const getList = (key: string) => {
    let list = lists.get(key);
    if (!list) {
      list = [];
      lists.set(key, list);
    }
    return list;
  };

  const setString = (
    key: string,
    value: string,
    args: Array<string | number>
  ) => {
    if (args.includes("NX") && strings.has(key)) {
      return null;
    }
    strings.set(key, value);
    const expiryIndex = args.indexOf("EX");
    if (expiryIndex >= 0) {
      expirations.set(key, Number(args[expiryIndex + 1]));
    }
    return "OK";
  };

  const evaluate = async (
    script: string,
    numKeys: number,
    ...redisArgs: Array<string | number>
  ): Promise<number> => {
    const keys = redisArgs.slice(0, numKeys).map(String);
    const args = redisArgs.slice(numKeys).map(String);

    if (script.includes('redis.pcall("LPUSH", KEYS[2], ARGV[2])')) {
      const [acceptedKey, queueKey] = keys;
      const [acceptedTtl, raw] = args;
      if (strings.has(acceptedKey)) {
        return 0;
      }
      strings.set(acceptedKey, "1");
      expirations.set(acceptedKey, Number(acceptedTtl));
      if (failingListKeys.has(queueKey)) {
        strings.delete(acceptedKey);
        expirations.delete(acceptedKey);
        throw new Error("WRONGTYPE queue key is not a list");
      }
      getList(queueKey).unshift(raw);
      return 1;
    }

    if (script.includes("return -3") && script.includes('redis.call("RPOP"')) {
      const [queueKey, processingKey, leaseKey] = keys;
      const [raw, leaseToken, leaseTtl] = args;
      if (strings.get(leaseKey) === leaseToken) {
        return getList(processingKey).includes(raw) ? 2 : -3;
      }
      if (strings.has(leaseKey)) {
        return -2;
      }
      const queue = getList(queueKey);
      if (queue.length === 0) {
        return 0;
      }
      if (queue.at(-1) !== raw) {
        return -1;
      }
      if (failingListKeys.has(processingKey)) {
        throw new Error("WRONGTYPE processing key is not a list");
      }
      queue.pop();
      getList(processingKey).unshift(raw);
      strings.set(leaseKey, leaseToken);
      expirations.set(leaseKey, Number(leaseTtl));
      return 1;
    }

    if (
      script.includes('redis.pcall("SET", KEYS[3], "completed", "EX", ARGV[3])')
    ) {
      const [processingKey, leaseKey, receiptKey] = keys;
      const [raw, leaseToken, receiptTtl] = args;
      if (strings.get(receiptKey) === "completed") {
        return 2;
      }
      if (strings.get(leaseKey) !== leaseToken) {
        return 0;
      }
      const processing = getList(processingKey);
      const index = processing.indexOf(raw);
      if (index === -1) {
        return -1;
      }
      processing.splice(index, 1);
      strings.delete(leaseKey);
      expirations.delete(leaseKey);
      strings.set(receiptKey, "completed");
      expirations.set(receiptKey, Number(receiptTtl));
      return 1;
    }

    if (script.includes('ARGV[6] == "owned"')) {
      const [processingKey, leaseKey, destinationKey, receiptKey] = keys;
      const [
        raw,
        nextRaw,
        leaseToken,
        transitionName,
        destination,
        ownership,
        receiptTtl,
      ] = args;
      if (strings.get(receiptKey) === transitionName) {
        return 2;
      }
      if (ownership === "owned") {
        if (strings.get(leaseKey) !== leaseToken) {
          return 0;
        }
      } else if (strings.has(leaseKey)) {
        return -2;
      }
      const processing = getList(processingKey);
      const index = processing.indexOf(raw);
      if (index === -1) {
        return -1;
      }
      if (failingListKeys.has(destinationKey)) {
        throw new Error("WRONGTYPE destination key is not a list");
      }
      processing.splice(index, 1);
      strings.delete(leaseKey);
      expirations.delete(leaseKey);
      if (destination === "dead") {
        getList(destinationKey).push(nextRaw);
      } else {
        getList(destinationKey).unshift(nextRaw);
      }
      strings.set(receiptKey, transitionName);
      expirations.set(receiptKey, Number(receiptTtl));
      return 1;
    }

    if (script.includes('redis.call("LINDEX", KEYS[1], -1)')) {
      const [queueKey, deadLetterKey] = keys;
      const [raw] = args;
      const queue = getList(queueKey);
      if (queue.at(-1) !== raw) {
        return 0;
      }
      if (failingListKeys.has(deadLetterKey)) {
        throw new Error("WRONGTYPE dead-letter key is not a list");
      }
      queue.pop();
      getList(deadLetterKey).push(raw);
      return 1;
    }

    if (
      script.includes('redis.pcall("RPUSH", KEYS[2], ARGV[1])') &&
      script.includes('return redis.error_reply("lease key is not a string")')
    ) {
      const [processingKey, deadLetterKey, leaseKey] = keys;
      const [raw] = args;
      if (strings.has(leaseKey)) {
        return -2;
      }
      const processing = getList(processingKey);
      const index = processing.indexOf(raw);
      if (index === -1) {
        return 0;
      }
      if (failingListKeys.has(deadLetterKey)) {
        throw new Error("WRONGTYPE dead-letter key is not a list");
      }
      processing.splice(index, 1);
      getList(deadLetterKey).push(raw);
      return 1;
    }

    throw new Error("Unsupported Messenger generation queue Lua script");
  };

  const redis = {
    del: vi.fn(async (key: string) => (strings.delete(key) ? 1 : 0)),
    get: vi.fn(async (key: string) => strings.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: string, ...args: Array<string | number>) => {
        return setString(key, value, args);
      }
    ),
    eval: vi.fn(evaluate),
    llen: vi.fn(async (key: string) => getList(key).length),
    lrem: vi.fn(async (key: string, _count: number, value: string) => {
      const list = getList(key);
      const index = list.indexOf(value);
      if (index === -1) return 0;
      list.splice(index, 1);
      return 1;
    }),
    lpush: vi.fn(async (key: string, value: string) => {
      const list = getList(key);
      list.unshift(value);
      return list.length;
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = getList(key);
      return list.slice(start, stop === -1 ? undefined : stop + 1);
    }),
    rpoplpush: vi.fn(async (source: string, destination: string) => {
      const value = getList(source).pop() ?? null;
      if (value !== null) {
        getList(destination).unshift(value);
      }
      return value;
    }),
    rpush: vi.fn(async (key: string, value: string) => {
      const list = getList(key);
      list.push(value);
      return list.length;
    }),
    sadd: vi.fn(async (_key: string, member: string) => {
      const before = tenantPartitions.size;
      tenantPartitions.add(member);
      return tenantPartitions.size - before;
    }),
    smembers: vi.fn(async () => [...tenantPartitions]),
  };

  return {
    evaluate,
    expirations,
    lists,
    redis,
    strings,
    tenantPartitions,
  };
}

describe("messengerGenerationQueue", () => {
  const originalQueueEnabled = process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
  const originalInlineFallback =
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK;
  const originalWorker = process.env.MESSENGER_GENERATION_WORKER;
  const originalWorkerOnly = process.env.MESSENGER_GENERATION_WORKER_ONLY;
  const originalMaxAttempts = process.env.MESSENGER_GENERATION_MAX_ATTEMPTS;
  const originalDrainBatchSize =
    process.env.MESSENGER_GENERATION_DRAIN_BATCH_SIZE;
  const originalJobLeaseSeconds =
    process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS;
  const originalOpenAiTimeoutMs = process.env.OPENAI_IMAGE_TIMEOUT_MS;
  const originalPartitionSecret =
    process.env.MESSENGER_GENERATION_PARTITION_SECRET;
  const originalFbAppSecret = process.env.FB_APP_SECRET;

  beforeEach(() => {
    process.env.MESSENGER_GENERATION_PARTITION_SECRET = TEST_PARTITION_SECRET;
  });

  afterEach(() => {
    if (originalQueueEnabled === undefined) {
      delete process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
    } else {
      process.env.MESSENGER_GENERATION_QUEUE_ENABLED = originalQueueEnabled;
    }
    if (originalInlineFallback === undefined) {
      delete process.env.MESSENGER_GENERATION_INLINE_FALLBACK;
    } else {
      process.env.MESSENGER_GENERATION_INLINE_FALLBACK = originalInlineFallback;
    }
    if (originalWorker === undefined) {
      delete process.env.MESSENGER_GENERATION_WORKER;
    } else {
      process.env.MESSENGER_GENERATION_WORKER = originalWorker;
    }
    if (originalWorkerOnly === undefined) {
      delete process.env.MESSENGER_GENERATION_WORKER_ONLY;
    } else {
      process.env.MESSENGER_GENERATION_WORKER_ONLY = originalWorkerOnly;
    }
    if (originalMaxAttempts === undefined) {
      delete process.env.MESSENGER_GENERATION_MAX_ATTEMPTS;
    } else {
      process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = originalMaxAttempts;
    }
    if (originalDrainBatchSize === undefined) {
      delete process.env.MESSENGER_GENERATION_DRAIN_BATCH_SIZE;
    } else {
      process.env.MESSENGER_GENERATION_DRAIN_BATCH_SIZE =
        originalDrainBatchSize;
    }
    if (originalJobLeaseSeconds === undefined) {
      delete process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS;
    } else {
      process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS =
        originalJobLeaseSeconds;
    }
    if (originalOpenAiTimeoutMs === undefined) {
      delete process.env.OPENAI_IMAGE_TIMEOUT_MS;
    } else {
      process.env.OPENAI_IMAGE_TIMEOUT_MS = originalOpenAiTimeoutMs;
    }
    if (originalPartitionSecret === undefined) {
      delete process.env.MESSENGER_GENERATION_PARTITION_SECRET;
    } else {
      process.env.MESSENGER_GENERATION_PARTITION_SECRET =
        originalPartitionSecret;
    }
    if (originalFbAppSecret === undefined) {
      delete process.env.FB_APP_SECRET;
    } else {
      process.env.FB_APP_SECRET = originalFbAppSecret;
    }
    getRedisClientMock.mockReset();
    isRedisEnabledMock.mockReset();
    isRedisEnabledMock.mockReturnValue(false);
    resetRuntimeStatsForTests();
    resetMessengerGenerationQueueForTests();
  });

  it("stays disabled unless both the flag and Redis are present", () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(false);
    expect(isMessengerGenerationQueueEnabled()).toBe(false);

    isRedisEnabledMock.mockReturnValue(true);
    expect(isMessengerGenerationQueueEnabled()).toBe(true);
  });

  it("fails fast for worker mode without a Redis-backed queue", () => {
    process.env.MESSENGER_GENERATION_WORKER_ONLY = "1";
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(false);

    expect(() => assertMessengerGenerationQueueConfig()).toThrow(
      "MESSENGER_GENERATION_QUEUE_ENABLED=1 and REDIS_URL are required"
    );
  });

  it("fails fast when inline fallback is disabled without an active queue", () => {
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(false);

    expect(() => assertMessengerGenerationQueueConfig()).toThrow(
      "MESSENGER_GENERATION_INLINE_FALLBACK=0 requires"
    );
  });

  it("fails fast when queueing has no stable partition secret", () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    delete process.env.MESSENGER_GENERATION_PARTITION_SECRET;
    delete process.env.FB_APP_SECRET;
    isRedisEnabledMock.mockReturnValue(true);

    expect(() => assertMessengerGenerationQueueConfig()).toThrow(
      "requires MESSENGER_GENERATION_PARTITION_SECRET or FB_APP_SECRET"
    );
  });

  it("runs inline when queueing is disabled", async () => {
    const processor = vi.fn(async () => "done");
    const result = await enqueueOrRunMessengerGenerationJob(
      createJob(),
      processor
    );

    expect(result).toEqual({ mode: "inline", outcome: "done" });
    expect(processor).toHaveBeenCalledWith(createJob());
    expect(getRedisClientMock).not.toHaveBeenCalled();
  });

  it("preserves inline compatibility without a Page boundary", async () => {
    const processor = vi.fn(async () => "done");
    const job = createJob({ pageId: undefined });

    await expect(
      enqueueOrRunMessengerGenerationJob(job, processor)
    ).resolves.toEqual({ mode: "inline", outcome: "done" });
    expect(processor).toHaveBeenCalledWith(job);
    expect(getRedisClientMock).not.toHaveBeenCalled();
  });

  it("fails closed before Redis when a queued job has no Page boundary", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);

    await expect(
      enqueueOrRunMessengerGenerationJob(
        createJob({ pageId: undefined }),
        vi.fn(async () => undefined)
      )
    ).rejects.toThrow("requires a receiving Page boundary");
    expect(getRedisClientMock).not.toHaveBeenCalled();
  });

  it("enqueues without running the generation processor when queueing is enabled", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const { expirations, lists, redis, strings } = createKeyedRedis();
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => "should-not-run");
    const job = createJob({ reqId: "req-handoff" });

    const result = await enqueueOrRunMessengerGenerationJob(job, processor);
    const tenantPartition = getTenantPartition(job.pageId!);
    const partitionedJob = { ...job, tenantPartition };

    expect(result).toEqual({ mode: "queued" });
    expect(processor).not.toHaveBeenCalled();
    expect(redis.sadd).toHaveBeenCalledWith(
      "messenger-generation-job-partitions:v1",
      tenantPartition
    );
    const acceptedKey =
      `messenger-generation-jobs:{${tenantPartition}}:accepted:` +
      getJobKeyToken(job.reqId);
    expect(strings.get(acceptedKey)).toBe("1");
    expect(expirations.get(acceptedKey)).toBe(7 * 24 * 60 * 60);
    expect(lists.get(getPartitionKey(tenantPartition, "queued"))).toEqual([
      JSON.stringify(partitionedJob),
    ]);
    expect(lists.has("messenger-generation-jobs")).toBe(false);
    const firstEvalArgs = redis.eval.mock.calls[0]?.slice(2);
    expect(firstEvalArgs?.[0]).not.toContain(job.pageId);
    expect(firstEvalArgs?.[1]).not.toContain(job.pageId);
  });

  it("dedupes queued generation jobs by reqId before enqueueing", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const { lists, redis } = createKeyedRedis();
    getRedisClientMock.mockResolvedValue(redis);
    const job = createJob({ reqId: "req-duplicate" });

    await expect(enqueueMessengerGenerationJob(job)).resolves.toBe(true);
    await expect(enqueueMessengerGenerationJob(job)).resolves.toBe(false);

    const tenantPartition = getTenantPartition(job.pageId!);
    expect(lists.get(getPartitionKey(tenantPartition, "queued"))).toEqual([
      JSON.stringify({ ...job, tenantPartition }),
    ]);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(getTodayRuntimeStats().duplicateSkipCountToday).toBe(1);
  });

  it("rolls back the accepted marker when the atomic queue push fails", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-atomic-push-failure" });
    const tenantPartition = getTenantPartition(job.pageId!);
    const queueKey = getPartitionKey(tenantPartition, "queued");
    const acceptedKey =
      `messenger-generation-jobs:{${tenantPartition}}:accepted:` +
      getJobKeyToken(job.reqId);
    const { lists, redis, strings } = createKeyedRedis({}, [], {
      failingListKeys: [queueKey],
    });
    getRedisClientMock.mockResolvedValue(redis);

    await expect(enqueueMessengerGenerationJob(job)).rejects.toThrow(
      "queue key is not a list"
    );

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(strings.has(acceptedKey)).toBe(false);
    expect(lists.get(queueKey) ?? []).toEqual([]);
  });

  it("retries an ambiguous enqueue response without duplicating the job", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-ambiguous-enqueue" });
    const tenantPartition = getTenantPartition(job.pageId!);
    const queueKey = getPartitionKey(tenantPartition, "queued");
    const acceptedKey =
      `messenger-generation-jobs:{${tenantPartition}}:accepted:` +
      getJobKeyToken(job.reqId);
    const { evaluate, lists, redis, strings } = createKeyedRedis();
    redis.eval.mockImplementationOnce(
      async (
        script: string,
        numKeys: number,
        ...args: Array<string | number>
      ) => {
        await evaluate(script, numKeys, ...args);
        throw new Error("Redis response lost after commit");
      }
    );
    getRedisClientMock.mockResolvedValue(redis);

    await expect(enqueueMessengerGenerationJob(job)).resolves.toBe(false);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(strings.get(acceptedKey)).toBe("1");
    expect(lists.get(queueKey)).toEqual([
      JSON.stringify({ ...job, tenantPartition }),
    ]);
    expect(getTodayRuntimeStats().duplicateSkipCountToday).toBe(1);
  });

  it("returns duplicate mode without running or enqueueing the job twice", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const { lists, redis } = createKeyedRedis();
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);
    const job = createJob({ reqId: "req-duplicate-mode" });

    await expect(
      enqueueOrRunMessengerGenerationJob(job, processor)
    ).resolves.toEqual({ mode: "queued" });
    await expect(
      enqueueOrRunMessengerGenerationJob(job, processor)
    ).resolves.toEqual({ mode: "duplicate" });

    const tenantPartition = getTenantPartition(job.pageId!);
    expect(lists.get(getPartitionKey(tenantPartition, "queued"))).toEqual([
      JSON.stringify({ ...job, tenantPartition }),
    ]);
    expect(processor).not.toHaveBeenCalled();
  });

  it("scopes accepted dedupe records to the opaque Page partition", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const { lists, redis, strings } = createKeyedRedis();
    getRedisClientMock.mockResolvedValue(redis);
    const first = createJob({ pageId: "page-a", reqId: "shared-request" });
    const second = createJob({ pageId: "page-b", reqId: "shared-request" });

    await expect(enqueueMessengerGenerationJob(first)).resolves.toBe(true);
    await expect(enqueueMessengerGenerationJob(second)).resolves.toBe(true);

    const firstPartition = getTenantPartition(first.pageId!);
    const secondPartition = getTenantPartition(second.pageId!);
    expect(firstPartition).not.toBe(secondPartition);
    expect(lists.get(getPartitionKey(firstPartition, "queued"))).toHaveLength(
      1
    );
    expect(lists.get(getPartitionKey(secondPartition, "queued"))).toHaveLength(
      1
    );
    expect([...strings.keys()]).toEqual(
      expect.arrayContaining([
        `messenger-generation-jobs:{${firstPartition}}:accepted:${getJobKeyToken(first.reqId)}`,
        `messenger-generation-jobs:{${secondPartition}}:accepted:${getJobKeyToken(second.reqId)}`,
      ])
    );
  });

  it("enqueues and drains Redis jobs", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const { expirations, lists, redis, strings } = createKeyedRedis();
    getRedisClientMock.mockResolvedValue(redis);

    const job = createJob({ reqId: "req-queued" });
    await expect(enqueueMessengerGenerationJob(job)).resolves.toBe(true);
    const processor = vi.fn(async () => undefined);
    await drainMessengerGenerationQueue(processor);
    const tenantPartition = getTenantPartition(job.pageId!);
    const partitionedJob = { ...job, tenantPartition };
    const acceptedKey =
      `messenger-generation-jobs:{${tenantPartition}}:accepted:` +
      getJobKeyToken(job.reqId);
    const leaseKey =
      `messenger-generation-jobs:{${tenantPartition}}:lease:` +
      getJobKeyToken(job.reqId);

    expect(lists.get(getPartitionKey(tenantPartition, "queued"))).toEqual([]);
    expect(lists.get(getPartitionKey(tenantPartition, "processing"))).toEqual(
      []
    );
    expect(strings.get(acceptedKey)).toBe("1");
    expect(expirations.get(acceptedKey)).toBe(7 * 24 * 60 * 60);
    expect(strings.has(leaseKey)).toBe(false);
    expect(
      [...strings.entries()].some(
        ([key, value]) => key.includes(":transition:") && value === "completed"
      )
    ).toBe(true);
    expect(processor).toHaveBeenCalledWith(partitionedJob);
  });

  it("keeps a reservation when a stale worker loses its fenced lease", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const tenantPartition = getTenantPartition("page-lease-fence");
    const job = createJob({
      pageId: "page-lease-fence",
      reqId: "req-lease-fence",
      tenantPartition,
    });
    const raw = JSON.stringify(job);
    const queueKey = getPartitionKey(tenantPartition, "queued");
    const processingKey = getPartitionKey(tenantPartition, "processing");
    const leaseKey =
      `messenger-generation-jobs:{${tenantPartition}}:lease:` +
      getJobKeyToken(job.reqId);
    const { lists, redis, strings } = createKeyedRedis({ [queueKey]: [raw] }, [
      tenantPartition,
    ]);
    getRedisClientMock.mockResolvedValue(redis);

    await drainMessengerGenerationQueue(async () => {
      expect(strings.get(leaseKey)).toBeTruthy();
      strings.set(leaseKey, "new-worker-token");
    });

    expect(lists.get(queueKey)).toEqual([]);
    expect(lists.get(processingKey)).toEqual([raw]);
    expect(strings.get(leaseKey)).toBe("new-worker-token");
    expect(
      [...strings.values()].filter(value => value === "completed")
    ).toEqual([]);
  });

  it("drains a matching partition without reading content from another partition", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const firstPartition = getTenantPartition("page-a");
    const secondPartition = getTenantPartition("page-b");
    const firstJob = createJob({
      pageId: "page-a",
      reqId: "partition-drain-a",
      tenantPartition: firstPartition,
    });
    const secondJob = createJob({
      pageId: "page-b",
      reqId: "partition-drain-b",
      tenantPartition: secondPartition,
    });
    const { lists, redis } = createKeyedRedis(
      {
        [getPartitionKey(firstPartition, "queued")]: [JSON.stringify(firstJob)],
        [getPartitionKey(secondPartition, "queued")]: [
          JSON.stringify(secondJob),
        ],
      },
      [firstPartition, secondPartition]
    );
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await drainMessengerGenerationQueue(processor);

    expect(processor).toHaveBeenNthCalledWith(1, firstJob);
    expect(processor).toHaveBeenNthCalledWith(2, secondJob);
    expect(lists.get(getPartitionKey(firstPartition, "processing"))).toEqual(
      []
    );
    expect(lists.get(getPartitionKey(secondPartition, "processing"))).toEqual(
      []
    );
    expect(redis.rpoplpush).not.toHaveBeenCalledWith(
      getPartitionKey(firstPartition, "queued"),
      getPartitionKey(firstPartition, "processing")
    );
    expect(redis.eval.mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          getPartitionKey(firstPartition, "queued"),
          getPartitionKey(firstPartition, "processing"),
        ]),
        expect.arrayContaining([
          getPartitionKey(secondPartition, "queued"),
          getPartitionKey(secondPartition, "processing"),
        ]),
      ])
    );
  });

  it("requeues a failed partition job only inside the same partition", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const tenantPartition = getTenantPartition("page-retry");
    const job = createJob({
      pageId: "page-retry",
      reqId: "partition-retry",
      tenantPartition,
    });
    const { lists, redis } = createKeyedRedis(
      {
        [getPartitionKey(tenantPartition, "queued")]: [JSON.stringify(job)],
      },
      [tenantPartition]
    );
    getRedisClientMock.mockResolvedValue(redis);

    await drainMessengerGenerationQueue(async () => {
      throw new Error("retry");
    });

    expect(
      lists
        .get(getPartitionKey(tenantPartition, "queued"))
        ?.map(value => JSON.parse(value))
    ).toEqual([{ ...job, attempts: 1 }]);
    expect(lists.get("messenger-generation-jobs") ?? []).toEqual([]);
    expect(lists.get(getPartitionKey(tenantPartition, "dead")) ?? []).toEqual(
      []
    );
  });

  it("dead-letters a partition job only inside the same partition", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const tenantPartition = getTenantPartition("page-dead");
    const job = createJob({
      pageId: "page-dead",
      reqId: "partition-dead",
      tenantPartition,
    });
    const { lists, redis } = createKeyedRedis(
      {
        [getPartitionKey(tenantPartition, "queued")]: [JSON.stringify(job)],
      },
      [tenantPartition]
    );
    getRedisClientMock.mockResolvedValue(redis);

    await drainMessengerGenerationQueue(async () => {
      throw new Error("dead");
    });

    expect(
      lists
        .get(getPartitionKey(tenantPartition, "dead"))
        ?.map(value => JSON.parse(value))
    ).toEqual([{ ...job, attempts: 1 }]);
    expect(lists.get("messenger-generation-jobs:dead") ?? []).toEqual([]);
  });

  it("reclaims a stale partition reservation only into its own queue", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const tenantPartition = getTenantPartition("page-reclaim");
    const job = createJob({
      pageId: "page-reclaim",
      reqId: "partition-reclaim",
      tenantPartition,
    });
    const { lists, redis } = createKeyedRedis(
      {
        [getPartitionKey(tenantPartition, "processing")]: [JSON.stringify(job)],
      },
      [tenantPartition]
    );
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(1);

    expect(
      lists
        .get(getPartitionKey(tenantPartition, "queued"))
        ?.map(value => JSON.parse(value))
    ).toEqual([{ ...job, attempts: 1 }]);
    expect(lists.get(getPartitionKey(tenantPartition, "processing"))).toEqual(
      []
    );
    expect(lists.get("messenger-generation-jobs") ?? []).toEqual([]);
  });

  it.each(["missing", "different"] as const)(
    "dead-letters a %s payload partition mismatch without executing it",
    async mismatch => {
      process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
      isRedisEnabledMock.mockReturnValue(true);
      const activePartition = getTenantPartition("page-active");
      const job = createJob({
        pageId: "page-active",
        reqId: `partition-mismatch-${mismatch}`,
        tenantPartition:
          mismatch === "different"
            ? getTenantPartition("page-other")
            : undefined,
      });
      const raw = JSON.stringify(job);
      const { lists, redis } = createKeyedRedis(
        {
          [getPartitionKey(activePartition, "queued")]: [raw],
        },
        [activePartition]
      );
      getRedisClientMock.mockResolvedValue(redis);
      const processor = vi.fn(async () => undefined);

      await drainMessengerGenerationQueue(processor);

      expect(processor).not.toHaveBeenCalled();
      expect(lists.get(getPartitionKey(activePartition, "dead"))).toEqual([
        raw,
      ]);
      expect(lists.get("messenger-generation-jobs:dead") ?? []).toEqual([]);
    }
  );

  it("recomputes the Page HMAC before consuming a partitioned job", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const activePartition = getTenantPartition("page-active");
    const forgedJob = createJob({
      pageId: "page-other",
      reqId: "partition-forged-page",
      tenantPartition: activePartition,
    });
    const raw = JSON.stringify(forgedJob);
    const { lists, redis } = createKeyedRedis(
      {
        [getPartitionKey(activePartition, "queued")]: [raw],
      },
      [activePartition]
    );
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await drainMessengerGenerationQueue(processor);

    expect(processor).not.toHaveBeenCalled();
    expect(lists.get(getPartitionKey(activePartition, "queued"))).toEqual([]);
    expect(lists.get(getPartitionKey(activePartition, "dead"))).toEqual([raw]);
  });

  it("continues partitioned processing when legacy Redis keys return CROSSSLOT", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const tenantPartition = getTenantPartition("page-cluster");
    const partitionedJob = createJob({
      pageId: "page-cluster",
      reqId: "partition-cluster-job",
      tenantPartition,
    });
    const legacyRaw = JSON.stringify(
      createJob({ reqId: "legacy-cross-slot", tenantPartition: undefined })
    );
    const queueKey = getPartitionKey(tenantPartition, "queued");
    const processingKey = getPartitionKey(tenantPartition, "processing");
    const { lists, redis } = createKeyedRedis(
      {
        [queueKey]: [JSON.stringify(partitionedJob)],
        "messenger-generation-jobs": [legacyRaw],
      },
      [tenantPartition]
    );
    redis.rpoplpush.mockRejectedValue(
      new Error("CROSSSLOT Keys in request don't hash to the same slot")
    );
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await expect(
      drainMessengerGenerationQueue(processor)
    ).resolves.toBeUndefined();

    expect(processor).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledWith(partitionedJob);
    expect(lists.get(queueKey)).toEqual([]);
    expect(lists.get(processingKey)).toEqual([]);
    expect(lists.get("messenger-generation-jobs")).toEqual([legacyRaw]);
    expect(redis.rpoplpush).toHaveBeenCalledWith(
      "messenger-generation-jobs",
      "messenger-generation-jobs:processing"
    );
  });

  it("keeps a queued job when the atomic reserve destination write fails", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const pageId = "page-reserve-write-failure";
    const tenantPartition = getTenantPartition(pageId);
    const queuedKey = getPartitionKey(tenantPartition, "queued");
    const processingKey = getPartitionKey(tenantPartition, "processing");
    const raw = JSON.stringify({
      ...createJob({ pageId, reqId: "req-reserve-write-failure" }),
      tenantPartition,
    });
    const { lists, redis } = createKeyedRedis(
      { [queuedKey]: [raw] },
      [tenantPartition],
      { failingListKeys: [processingKey] }
    );
    getRedisClientMock.mockResolvedValue(redis);

    await expect(
      drainMessengerGenerationQueue(vi.fn(async () => undefined))
    ).rejects.toThrow("processing key is not a list");

    expect(lists.get(queuedKey)).toEqual([raw]);
    expect(lists.get(processingKey) ?? []).toEqual([]);
  });

  it("keeps a failed job reserved when its retry destination write fails", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const pageId = "page-retry-write-failure";
    const tenantPartition = getTenantPartition(pageId);
    const queuedKey = getPartitionKey(tenantPartition, "queued");
    const processingKey = getPartitionKey(tenantPartition, "processing");
    const raw = JSON.stringify({
      ...createJob({ pageId, reqId: "req-retry-write-failure" }),
      tenantPartition,
    });
    const { lists, redis } = createKeyedRedis(
      { [queuedKey]: [raw] },
      [tenantPartition],
      { failingListKeys: [queuedKey] }
    );
    getRedisClientMock.mockResolvedValue(redis);

    await expect(
      drainMessengerGenerationQueue(async () => {
        throw new Error("provider failed");
      })
    ).rejects.toThrow("destination key is not a list");

    expect(lists.get(queuedKey)).toEqual([]);
    expect(lists.get(processingKey)).toEqual([raw]);
  });

  it("does not dead-letter an invalid processing job with an active lease", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const tenantPartition = getTenantPartition("page-before-secret-drift");
    const processingKey = getPartitionKey(tenantPartition, "processing");
    const deadKey = getPartitionKey(tenantPartition, "dead");
    const job = {
      ...createJob({
        pageId: "page-after-secret-drift",
        reqId: "req-active-invalid-processing",
      }),
      tenantPartition,
    };
    const raw = JSON.stringify(job);
    const { lists, redis, strings } = createKeyedRedis(
      { [processingKey]: [raw] },
      [tenantPartition]
    );
    strings.set(
      `messenger-generation-jobs:{${tenantPartition}}:lease:${getJobKeyToken(job.reqId)}`,
      "active-lease-token"
    );
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(0);

    expect(lists.get(processingKey)).toEqual([raw]);
    expect(lists.get(deadKey) ?? []).toEqual([]);
  });

  it("drains pre-migration global jobs through the explicit legacy scope", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({
      reqId: "req-prompt-first-no-style",
      generationKind: "text_to_image",
      promptHint: "Maak een draak boven Antwerpen",
    });
    const queue: string[] = [JSON.stringify(job)];
    const { processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await drainMessengerGenerationQueue(processor);

    expect(processor).toHaveBeenCalledWith(job);
    expect(redis.rpoplpush).toHaveBeenCalledWith(
      "messenger-generation-jobs",
      "messenger-generation-jobs:processing"
    );
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(processing).toEqual([]);
  });

  it("uses an explicit job lease when configured", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS = "900";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-custom-lease" });
    const queue: string[] = [JSON.stringify(job)];
    const { redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);

    await drainMessengerGenerationQueue(vi.fn(async () => undefined));

    expect(redis.set).toHaveBeenCalledWith(
      "messenger-generation-job-lease:req-custom-lease",
      "1",
      "EX",
      900
    );
  });

  it("clamps an explicit lease below the provider retry duration", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS = "120";
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "300000";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-clamped-lease" });
    const queue: string[] = [JSON.stringify(job)];
    const { redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);

    await drainMessengerGenerationQueue(vi.fn(async () => undefined));

    expect(redis.set).toHaveBeenCalledWith(
      "messenger-generation-job-lease:req-clamped-lease",
      "1",
      "EX",
      661
    );
  });

  it("derives the default job lease from every OpenAI retry attempt", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "300000";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-derived-lease" });
    const queue: string[] = [JSON.stringify(job)];
    const { redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);

    await drainMessengerGenerationQueue(vi.fn(async () => undefined));

    expect(redis.set).toHaveBeenCalledWith(
      "messenger-generation-job-lease:req-derived-lease",
      "1",
      "EX",
      661
    );
  });

  it("requeues a failed job with an incremented attempt count", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-retry" });
    const queue: string[] = [JSON.stringify(job)];
    const { dead, processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);

    const processor = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    await drainMessengerGenerationQueue(processor);

    expect(processor).toHaveBeenCalledTimes(1);
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
    expect(queue.map(value => JSON.parse(value))).toEqual([
      { ...job, attempts: 1 },
    ]);
  });

  it("stops draining after the configured batch size", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_DRAIN_BATCH_SIZE = "2";
    isRedisEnabledMock.mockReturnValue(true);
    const jobs = [
      createJob({ reqId: "req-batch-1" }),
      createJob({ reqId: "req-batch-2" }),
      createJob({ reqId: "req-batch-3" }),
    ];
    const queue = jobs.map(job => JSON.stringify(job)).reverse();
    const { processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await drainMessengerGenerationQueue(processor);

    expect(processor).toHaveBeenCalledTimes(2);
    expect(processor).toHaveBeenNthCalledWith(1, jobs[0]);
    expect(processor).toHaveBeenNthCalledWith(2, jobs[1]);
    expect(queue).toEqual([JSON.stringify(jobs[2])]);
    expect(processing).toEqual([]);
  });

  it("dead-letters a job after the configured max attempts", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "2";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-dead", attempts: 1 });
    const queue: string[] = [JSON.stringify(job)];
    const { dead, processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);

    const processor = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const onDeadLetter = vi.fn(async () => undefined);
    await drainMessengerGenerationQueue(processor, { onDeadLetter });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead.map(value => JSON.parse(value))).toEqual([
      { ...job, attempts: 2 },
    ]);
    expect(redis.rpush).toHaveBeenCalledWith(
      "messenger-generation-jobs:dead",
      expect.any(String)
    );
    expect(onDeadLetter).toHaveBeenCalledWith(job, expect.any(Error));
  });

  it("dead-letters invalid pending job payloads without running the processor", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const invalidJob = "{not-json";
    const queue: string[] = [invalidJob];
    const { dead, processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await expect(
      drainMessengerGenerationQueue(processor)
    ).resolves.toBeUndefined();

    expect(processor).not.toHaveBeenCalled();
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([invalidJob]);
  });

  it("accepts supported UI locales and preserves lang through dequeue", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const nlJob = createJob({ lang: "nl", reqId: "req-locale-nl" });
    const enJob = createJob({ lang: "en", reqId: "req-locale-en" });
    const queue = [JSON.stringify(nlJob), JSON.stringify(enJob)];
    const { dead, processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await expect(
      drainMessengerGenerationQueue(processor)
    ).resolves.toBeUndefined();

    expect(processor).toHaveBeenCalledTimes(2);
    expect(processor).toHaveBeenNthCalledWith(1, enJob);
    expect(processor).toHaveBeenNthCalledWith(2, nlJob);
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
  });

  it("rejects unsupported queued UI locales without running the processor", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const unsupportedLocaleJob = JSON.stringify({
      psid: "psid-unsupported-locale",
      userId: "user-unsupported-locale",
      reqId: "req-unsupported-locale",
      lang: "fr",
    });
    const queue = [unsupportedLocaleJob];
    const { dead, processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await expect(
      drainMessengerGenerationQueue(processor)
    ).resolves.toBeUndefined();

    expect(processor).not.toHaveBeenCalled();
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([unsupportedLocaleJob]);
  });

  it("normalizes stale style-restyle jobs to prompt-first source-image edits", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const legacyJob = JSON.stringify({
      psid: "user-1",
      userId: "user-key-1",
      generationKind: "style_restyle",
      reqId: "req-legacy-style-kind",
      lang: "nl",
      sourceImageUrl: "https://img.example/source.jpg",
      promptHint: "make it brighter",
    });
    const queue: string[] = [legacyJob];
    const { dead, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await expect(
      drainMessengerGenerationQueue(processor)
    ).resolves.toBeUndefined();

    expect(processor).toHaveBeenCalledWith(
      expect.objectContaining({
        generationKind: "source_image_edit",
        promptHint: "make it brighter",
        sourceImageUrl: "https://img.example/source.jpg",
      })
    );
    expect(dead).toEqual([]);
  });

  it("ignores stale style payloads instead of letting them affect queued generation", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const staleJob = JSON.stringify({
      psid: "user-1",
      userId: "user-key-1",
      style: 123,
      reqId: "req-stale-style",
      lang: "nl",
    });
    const queue: string[] = [staleJob];
    const { dead, processing, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    await expect(
      drainMessengerGenerationQueue(processor)
    ).resolves.toBeUndefined();

    expect(processor).toHaveBeenCalledWith(
      expect.not.objectContaining({ style: expect.anything() })
    );
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
  });

  it("does not fail the drain when a dead-letter callback fails", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-dead-callback" });
    const queue: string[] = [JSON.stringify(job)];
    const { dead, redis } = createDrainRedis(queue, {
      leases: {
        "messenger-generation-job-lease:req-dead-callback": "1",
      },
    });
    getRedisClientMock.mockResolvedValue(redis);

    await expect(
      drainMessengerGenerationQueue(
        async () => {
          throw new Error("unexpected worker failure");
        },
        {
          onDeadLetter: async () => {
            throw new Error("callback failed");
          },
        }
      )
    ).resolves.toBeUndefined();

    expect(dead.map(value => JSON.parse(value))).toEqual([
      { ...job, attempts: 1 },
    ]);
  });

  it("reclaims expired reserved jobs into the pending queue", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-reserved" });
    const reserved = JSON.stringify(job);
    const queue: string[] = [];
    const dead: string[] = [];
    const processing = [reserved];
    const { redis } = createDrainRedis(queue, { dead, processing });
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(1);

    expect(processing).toEqual([]);
    expect(queue.map(value => JSON.parse(value))).toEqual([
      { ...job, attempts: 1 },
    ]);
    expect(dead).toEqual([]);
  });

  it("dead-letters expired reserved jobs after max reclaim attempts", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "2";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-expired-dead", attempts: 1 });
    const reserved = JSON.stringify(job);
    const queue: string[] = [];
    const dead: string[] = [];
    const processing = [reserved];
    const { redis } = createDrainRedis(queue, { dead, processing });
    getRedisClientMock.mockResolvedValue(redis);
    const onDeadLetter = vi.fn(async () => undefined);

    await expect(
      reclaimReservedMessengerGenerationJobs({ onDeadLetter })
    ).resolves.toBe(1);

    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead.map(value => JSON.parse(value))).toEqual([
      { ...job, attempts: 2 },
    ]);
    expect(onDeadLetter).toHaveBeenCalledWith(job, expect.any(Error));
  });

  it("keeps actively leased reserved jobs in processing", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const reserved = JSON.stringify(createJob({ reqId: "req-active" }));
    const queue: string[] = [];
    const processing = [reserved];
    const { redis } = createDrainRedis(queue, {
      processing,
      leases: {
        "messenger-generation-job-lease:req-active": "1",
      },
    });
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(0);

    expect(processing).toEqual([reserved]);
    expect(queue).toEqual([]);
    expect(redis.lrem).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it("reclaims stale reserved jobs before scheduled inline fallback drains", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-scheduled-reclaim" });
    const rawJob = JSON.stringify(job);
    const queue: string[] = [];
    const processing = [rawJob];
    const { redis } = createDrainRedis(queue, { processing });
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => undefined);

    scheduleMessengerGenerationQueueDrain(processor);

    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledWith({ ...job, attempts: 1 });
    });
    expect(redis.lrange).toHaveBeenCalledWith(
      "messenger-generation-jobs:processing",
      0,
      -1
    );
    expect(processing).toEqual([]);
    expect(queue).toEqual([]);
  });

  it("reschedules inline draining when a new partition arrives during an active drain", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "1";
    delete process.env.MESSENGER_GENERATION_WORKER;
    isRedisEnabledMock.mockReturnValue(true);
    const { redis } = createKeyedRedis();
    getRedisClientMock.mockResolvedValue(redis);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const holdFirst = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const processor = vi.fn(async (job: MessengerGenerationJob) => {
      if (job.reqId === "active-partition-a") {
        markFirstStarted();
        await holdFirst;
      }
    });

    await enqueueOrRunMessengerGenerationJob(
      createJob({ pageId: "page-active-a", reqId: "active-partition-a" }),
      processor
    );
    await firstStarted;
    await enqueueOrRunMessengerGenerationJob(
      createJob({ pageId: "page-active-b", reqId: "active-partition-b" }),
      processor
    );
    releaseFirst();

    await vi.waitFor(() => {
      expect(processor).toHaveBeenCalledWith(
        expect.objectContaining({ reqId: "active-partition-b" })
      );
    });
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it("catches a scheduled Redis failure and retries without an unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
      isRedisEnabledMock.mockReturnValue(true);
      const { redis } = createKeyedRedis();
      redis.smembers
        .mockRejectedValueOnce(new Error("temporary Redis failure"))
        .mockResolvedValue([]);
      getRedisClientMock.mockResolvedValue(redis);
      const processor = vi.fn(async () => undefined);

      scheduleMessengerGenerationQueueDrain(processor);
      await vi.waitFor(() => {
        expect(redis.smembers).toHaveBeenCalledTimes(1);
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(redis.smembers.mock.calls.length).toBeGreaterThanOrEqual(3);
      });
      expect(processor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the dead-letter callback from scheduled inline fallback drains", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-scheduled-dead" });
    const queue: string[] = [JSON.stringify(job)];
    const { dead, redis } = createDrainRedis(queue);
    getRedisClientMock.mockResolvedValue(redis);
    const processorError = new Error("scheduled worker failure");
    const processor = vi.fn(async () => {
      throw processorError;
    });
    const onDeadLetter = vi.fn(async () => undefined);

    scheduleMessengerGenerationQueueDrain(processor, { onDeadLetter });

    await vi.waitFor(() => {
      expect(onDeadLetter).toHaveBeenCalledWith(job, processorError);
    });
    expect(dead.map(value => JSON.parse(value))).toEqual([
      { ...job, attempts: 1 },
    ]);
  });

  it("reports queue depth when queueing is enabled", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const redis = {
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing") ? 2 : key.endsWith(":dead") ? 0 : 5
      ),
      smembers: vi.fn(async () => []),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(getMessengerGenerationQueueStats()).resolves.toEqual({
      enabled: true,
      queued: 5,
      processing: 2,
      failed: 0,
    });
  });

  it("aggregates counts across opaque partitions and legacy keys without reading payloads", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const firstPartition = getTenantPartition("stats-page-a");
    const secondPartition = getTenantPartition("stats-page-b");
    const { redis } = createKeyedRedis(
      {
        "messenger-generation-jobs": ["legacy-a", "legacy-b"],
        "messenger-generation-jobs:processing": ["legacy-processing"],
        "messenger-generation-jobs:dead": ["legacy-dead"],
        [getPartitionKey(firstPartition, "queued")]: ["a", "b", "c"],
        [getPartitionKey(firstPartition, "processing")]: ["a-processing"],
        [getPartitionKey(firstPartition, "dead")]: ["a-dead", "b-dead"],
        [getPartitionKey(secondPartition, "queued")]: ["d"],
        [getPartitionKey(secondPartition, "processing")]: [
          "b-processing",
          "c-processing",
        ],
      },
      [firstPartition, secondPartition]
    );
    getRedisClientMock.mockResolvedValue(redis);

    await expect(getMessengerGenerationQueueStats()).resolves.toEqual({
      enabled: true,
      queued: 6,
      processing: 4,
      failed: 3,
    });
    expect(redis.lrange).not.toHaveBeenCalled();
    expect(redis.rpoplpush).not.toHaveBeenCalled();
  });
});
