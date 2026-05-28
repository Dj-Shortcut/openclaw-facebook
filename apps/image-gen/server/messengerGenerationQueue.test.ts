import { afterEach, describe, expect, it, vi } from "vitest";

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
} from "./_core/messengerGenerationQueue";
import type { MessengerGenerationJob } from "./_core/messengerGenerationJob";

function createJob(overrides: Partial<MessengerGenerationJob> = {}): MessengerGenerationJob {
  return {
    psid: "psid-1",
    userId: "user-1",
    style: "gold",
    reqId: "req-1",
    lang: "nl",
    ...overrides,
  };
}

describe("messengerGenerationQueue", () => {
  const originalQueueEnabled = process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
  const originalInlineFallback = process.env.MESSENGER_GENERATION_INLINE_FALLBACK;
  const originalWorker = process.env.MESSENGER_GENERATION_WORKER;
  const originalWorkerOnly = process.env.MESSENGER_GENERATION_WORKER_ONLY;

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
    getRedisClientMock.mockReset();
    isRedisEnabledMock.mockReset();
    isRedisEnabledMock.mockReturnValue(false);
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

  it("runs inline when queueing is disabled", async () => {
    const processor = vi.fn(async () => "done");
    const result = await enqueueOrRunMessengerGenerationJob(createJob(), processor);

    expect(result).toEqual({ mode: "inline", outcome: "done" });
    expect(processor).toHaveBeenCalledWith(createJob());
    expect(getRedisClientMock).not.toHaveBeenCalled();
  });

  it("enqueues without running the generation processor when queueing is enabled", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const redis = {
      llen: vi.fn(async () => 0),
      lpush: vi.fn(async () => 1),
    };
    getRedisClientMock.mockResolvedValue(redis);
    const processor = vi.fn(async () => "should-not-run");
    const job = createJob({ reqId: "req-handoff" });

    const result = await enqueueOrRunMessengerGenerationJob(job, processor);

    expect(result).toEqual({ mode: "queued" });
    expect(processor).not.toHaveBeenCalled();
    expect(redis.lpush).toHaveBeenCalledWith(
      "messenger-generation-jobs",
      JSON.stringify(job)
    );
  });

  it("enqueues and drains Redis jobs", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const queue: string[] = [];
    const processing: string[] = [];
    const leases = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => {
        const existed = leases.delete(key);
        return existed ? 1 : 0;
      }),
      get: vi.fn(async (key: string) => leases.get(key) ?? null),
      lpush: vi.fn(async (key: string, value: string) => {
        if (key.endsWith(":processing")) {
          processing.unshift(value);
        } else {
          queue.unshift(value);
        }
        return queue.length;
      }),
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing") ? processing.length : queue.length
      ),
      lrange: vi.fn(async () => processing),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
      set: vi.fn(async (key: string, value: string) => {
        leases.set(key, value);
        return "OK";
      }),
      rpoplpush: vi.fn(async () => {
        const value = queue.pop() ?? null;
        if (value) {
          processing.unshift(value);
        }
        return value;
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    const job = createJob({ reqId: "req-queued" });
    await enqueueMessengerGenerationJob(job);
    const processor = vi.fn(async () => undefined);
    await drainMessengerGenerationQueue(processor);

    expect(redis.lpush).toHaveBeenCalledWith(
      "messenger-generation-jobs",
      JSON.stringify(job)
    );
    expect(redis.rpoplpush).toHaveBeenCalledWith(
      "messenger-generation-jobs",
      "messenger-generation-jobs:processing"
    );
    expect(redis.lrem).toHaveBeenCalledWith(
      "messenger-generation-jobs:processing",
      1,
      JSON.stringify(job)
    );
    expect(redis.set).toHaveBeenCalledWith(
      "messenger-generation-job-lease:req-queued",
      "1",
      "EX",
      900
    );
    expect(redis.del).toHaveBeenCalledWith(
      "messenger-generation-job-lease:req-queued"
    );
    expect(processor).toHaveBeenCalledWith(job);
    expect(processing).toEqual([]);
  });

  it("reclaims expired reserved jobs into the pending queue", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const reserved = JSON.stringify(createJob({ reqId: "req-reserved" }));
    const queue: string[] = [];
    const processing = [reserved];
    const redis = {
      get: vi.fn(async () => null),
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing") ? processing.length : queue.length
      ),
      lrange: vi.fn(async () => [...processing]),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
      lpush: vi.fn(async (_key: string, value: string) => {
        queue.unshift(value);
        return queue.length;
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(1);

    expect(processing).toEqual([]);
    expect(queue).toEqual([reserved]);
  });

  it("keeps actively leased reserved jobs in processing", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const reserved = JSON.stringify(createJob({ reqId: "req-active" }));
    const queue: string[] = [];
    const processing = [reserved];
    const redis = {
      get: vi.fn(async () => "1"),
      lrange: vi.fn(async () => [...processing]),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
      lpush: vi.fn(async (_key: string, value: string) => {
        queue.unshift(value);
        return queue.length;
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(0);

    expect(processing).toEqual([reserved]);
    expect(queue).toEqual([]);
    expect(redis.lrem).not.toHaveBeenCalled();
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it("reports queue depth when queueing is enabled", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const redis = {
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing") ? 2 : 5
      ),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(getMessengerGenerationQueueStats()).resolves.toEqual({
      enabled: true,
      queued: 5,
      processing: 2,
    });
  });
});
