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
  scheduleMessengerGenerationQueueDrain,
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
  const originalMaxAttempts = process.env.MESSENGER_GENERATION_MAX_ATTEMPTS;

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

  it("requeues a failed job with an incremented attempt count", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-retry" });
    const queue: string[] = [JSON.stringify(job)];
    const processing: string[] = [];
    const dead: string[] = [];
    const leases = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => {
        const existed = leases.delete(key);
        return existed ? 1 : 0;
      }),
      get: vi.fn(async (key: string) => leases.get(key) ?? null),
      llen: vi.fn(async (key: string) => {
        if (key.endsWith(":processing")) return processing.length;
        if (key.endsWith(":dead")) return dead.length;
        return queue.length;
      }),
      lpush: vi.fn(async (key: string, value: string) => {
        if (key.endsWith(":processing")) {
          processing.unshift(value);
        } else {
          queue.unshift(value);
        }
        return queue.length;
      }),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
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
      set: vi.fn(async (key: string, value: string) => {
        leases.set(key, value);
        return "OK";
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    const processor = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    await drainMessengerGenerationQueue(processor);

    expect(processor).toHaveBeenCalledTimes(1);
    expect(processing).toEqual([]);
    expect(dead).toEqual([]);
    expect(queue).toEqual([JSON.stringify({ ...job, attempts: 1 })]);
  });

  it("dead-letters a job after the configured max attempts", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "2";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-dead", attempts: 1 });
    const queue: string[] = [JSON.stringify(job)];
    const processing: string[] = [];
    const dead: string[] = [];
    const leases = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => {
        const existed = leases.delete(key);
        return existed ? 1 : 0;
      }),
      get: vi.fn(async (key: string) => leases.get(key) ?? null),
      llen: vi.fn(async (key: string) => {
        if (key.endsWith(":processing")) return processing.length;
        if (key.endsWith(":dead")) return dead.length;
        return queue.length;
      }),
      lpush: vi.fn(async (_key: string, value: string) => {
        queue.unshift(value);
        return queue.length;
      }),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
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
      set: vi.fn(async (key: string, value: string) => {
        leases.set(key, value);
        return "OK";
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    const processor = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const onDeadLetter = vi.fn(async () => undefined);
    await drainMessengerGenerationQueue(processor, { onDeadLetter });

    expect(processor).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([JSON.stringify({ ...job, attempts: 2 })]);
    expect(redis.rpush).toHaveBeenCalledWith(
      "messenger-generation-jobs:dead",
      JSON.stringify({ ...job, attempts: 2 })
    );
    expect(onDeadLetter).toHaveBeenCalledWith(
      job,
      expect.any(Error)
    );
  });

  it("does not fail the drain when a dead-letter callback fails", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-dead-callback" });
    const queue: string[] = [JSON.stringify(job)];
    const processing: string[] = [];
    const dead: string[] = [];
    const redis = {
      del: vi.fn(async () => 1),
      get: vi.fn(async () => "1"),
      llen: vi.fn(async (key: string) => {
        if (key.endsWith(":processing")) return processing.length;
        if (key.endsWith(":dead")) return dead.length;
        return queue.length;
      }),
      lpush: vi.fn(async (_key: string, value: string) => {
        queue.unshift(value);
        return queue.length;
      }),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
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
      set: vi.fn(async () => "OK"),
    };
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

    expect(dead).toEqual([JSON.stringify({ ...job, attempts: 1 })]);
  });

  it("reclaims expired reserved jobs into the pending queue", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-reserved" });
    const reserved = JSON.stringify(job);
    const queue: string[] = [];
    const dead: string[] = [];
    const processing = [reserved];
    const redis = {
      del: vi.fn(async () => 0),
      get: vi.fn(async () => null),
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing")
          ? processing.length
          : key.endsWith(":dead")
            ? dead.length
            : queue.length
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
      rpush: vi.fn(async (_key: string, value: string) => {
        dead.push(value);
        return dead.length;
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(reclaimReservedMessengerGenerationJobs()).resolves.toBe(1);

    expect(processing).toEqual([]);
    expect(queue).toEqual([JSON.stringify({ ...job, attempts: 1 })]);
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
    const redis = {
      del: vi.fn(async () => 0),
      get: vi.fn(async () => null),
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing")
          ? processing.length
          : key.endsWith(":dead")
            ? dead.length
            : queue.length
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
      rpush: vi.fn(async (_key: string, value: string) => {
        dead.push(value);
        return dead.length;
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);
    const onDeadLetter = vi.fn(async () => undefined);

    await expect(
      reclaimReservedMessengerGenerationJobs({ onDeadLetter })
    ).resolves.toBe(1);

    expect(queue).toEqual([]);
    expect(processing).toEqual([]);
    expect(dead).toEqual([JSON.stringify({ ...job, attempts: 2 })]);
    expect(onDeadLetter).toHaveBeenCalledWith(
      job,
      expect.any(Error)
    );
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

  it("reclaims stale reserved jobs before scheduled inline fallback drains", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-scheduled-reclaim" });
    const rawJob = JSON.stringify(job);
    const queue: string[] = [];
    const processing = [rawJob];
    const leases = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => {
        const existed = leases.delete(key);
        return existed ? 1 : 0;
      }),
      get: vi.fn(async () => null),
      llen: vi.fn(async (key: string) => {
        if (key.endsWith(":processing")) return processing.length;
        if (key.endsWith(":dead")) return 0;
        return queue.length;
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
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
      rpoplpush: vi.fn(async () => {
        const value = queue.pop() ?? null;
        if (value) {
          processing.unshift(value);
        }
        return value;
      }),
      rpush: vi.fn(async () => 1),
      set: vi.fn(async (key: string, value: string) => {
        leases.set(key, value);
        return "OK";
      }),
    };
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

  it("runs the dead-letter callback from scheduled inline fallback drains", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_MAX_ATTEMPTS = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const job = createJob({ reqId: "req-scheduled-dead" });
    const queue: string[] = [JSON.stringify(job)];
    const processing: string[] = [];
    const dead: string[] = [];
    const leases = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => {
        const existed = leases.delete(key);
        return existed ? 1 : 0;
      }),
      get: vi.fn(async () => null),
      llen: vi.fn(async (key: string) => {
        if (key.endsWith(":processing")) return processing.length;
        if (key.endsWith(":dead")) return dead.length;
        return queue.length;
      }),
      lpush: vi.fn(async (key: string, value: string) => {
        if (key.endsWith(":processing")) {
          processing.unshift(value);
        } else {
          queue.unshift(value);
        }
        return queue.length;
      }),
      lrange: vi.fn(async () => []),
      lrem: vi.fn(async (_key: string, _count: number, value: string) => {
        const index = processing.indexOf(value);
        if (index === -1) return 0;
        processing.splice(index, 1);
        return 1;
      }),
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
      set: vi.fn(async (key: string, value: string) => {
        leases.set(key, value);
        return "OK";
      }),
    };
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
    expect(dead).toEqual([JSON.stringify({ ...job, attempts: 1 })]);
  });

  it("reports queue depth when queueing is enabled", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    isRedisEnabledMock.mockReturnValue(true);
    const redis = {
      llen: vi.fn(async (key: string) =>
        key.endsWith(":processing") ? 2 : key.endsWith(":dead") ? 0 : 5
      ),
    };
    getRedisClientMock.mockResolvedValue(redis);

    await expect(getMessengerGenerationQueueStats()).resolves.toEqual({
      enabled: true,
      queued: 5,
      processing: 2,
      failed: 0,
    });
  });
});
