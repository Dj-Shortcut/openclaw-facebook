import { createHash } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { appendCostLedgerEntry } from "./_core/costLedger";
import {
  admitMessengerProviderSpend,
  MessengerSpendBudgetExceededError,
} from "./_core/generationGuard";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const USER = "redis-spend-user";
const NOW = new Date("2031-02-14T12:00:00.000Z");

function tenantScope(userKey: string) {
  return {
    workspaceId: 42,
    channelConnectionId: 7,
    bindingEpoch: 3,
    privacyEpoch: 5,
    userKey,
  };
}

suite("distributed Redis spend admission", () => {
  beforeAll(() => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/15";
  });

  beforeEach(async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.05";
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;
    const redis = await getRedisClient();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "*", "COUNT", 500);
      cursor = next;
      await Promise.all(keys.map(key => redis.del(key)));
    } while (cursor !== "0");
  });

  afterAll(() => {
    delete process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    resetRedisClientForTests();
  });

  it("atomically admits only the shared remaining budget and starts no rejected provider", async () => {
    const providerStart = vi.fn();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        admit(`race-${index}`, USER, 0.01, NOW, providerStart)
      )
    );
    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(5);
    expect(providerStart).toHaveBeenCalledTimes(5);
  });

  it("makes an attempt id single-use across worker contexts", async () => {
    const providerStart = vi.fn();
    await admit("same-attempt", USER, 0.01, NOW, providerStart);
    await expect(
      admit("same-attempt", USER, 0.01, NOW, providerStart)
    ).rejects.toBeInstanceOf(MessengerSpendBudgetExceededError);
    expect(providerStart).toHaveBeenCalledOnce();
  });

  it("enforces user, daily and monthly caps with UTC day/month partitioning", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.04";
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "0.06";
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.02";
    const providerStart = vi.fn();
    await admit("u1-a", "user-a", 0.02, NOW, providerStart);
    await expect(
      admit("u1-b", "user-a", 0.01, NOW, providerStart)
    ).rejects.toThrow();
    await admit("u2-a", "user-b", 0.02, NOW, providerStart);
    const nextDay = new Date("2031-02-15T00:00:01.000Z");
    await admit("next-day", "user-a", 0.02, nextDay, providerStart);
    await expect(
      admit("month-full", "user-c", 0.01, nextDay, providerStart)
    ).rejects.toThrow();
    await admit(
      "next-month",
      "user-a",
      0.02,
      new Date("2031-03-01T00:00:01.000Z"),
      providerStart
    );
    expect(providerStart).toHaveBeenCalledTimes(4);
  });

  it("releases a failed ledger reservation and conservatively keeps it on release failure", async () => {
    await expect(
      admit("ledger-fail", USER, 0.05, NOW, async () => {
        throw new Error("ledger unavailable");
      })
    ).rejects.toThrow("ledger unavailable");
    await expect(
      admit("after-release", USER, 0.05, NOW, vi.fn())
    ).resolves.toBeUndefined();

    const redis = await getRedisClient();
    const originalEval = redis.eval.bind(redis);
    let calls = 0;
    redis.eval = vi.fn(async (...args: Parameters<typeof redis.eval>) => {
      calls += 1;
      if (calls === 2) throw new Error("release unavailable");
      return originalEval(...args);
    });
    await expect(
      admit(
        "release-fail",
        USER,
        0.01,
        new Date("2031-03-02T12:00:00.000Z"),
        async () => {
          throw new Error("ledger unavailable");
        }
      )
    ).rejects.toThrow("ledger unavailable");
    redis.eval = originalEval;
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.01";
    await expect(
      admit(
        "after-release-fail",
        USER,
        0.01,
        new Date("2031-03-02T12:00:00.000Z"),
        vi.fn()
      )
    ).rejects.toThrow();
  });

  it("reconciles upward from the durable ledger baseline", async () => {
    await appendCostLedgerEntry(
      {
        id: "baseline-ledger",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "test",
        model: null,
        ...tenantScope(USER),
        userKey: USER,
        reqId: "baseline",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.04,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "test",
        unpricedCostComponents: [],
      },
      NOW
    );
    const providerStart = vi.fn();
    await expect(
      admit("baseline-block", USER, 0.02, NOW, providerStart)
    ).rejects.toThrow();
    expect(providerStart).not.toHaveBeenCalled();
  });

  it("fails closed before provider start when Redis reservation is unavailable", async () => {
    const redis = await getRedisClient();
    const originalEval = redis.eval.bind(redis);
    redis.eval = vi.fn(async () => {
      throw new Error("redis unavailable");
    });
    const providerStart = vi.fn();
    await expect(
      admit("redis-outage", USER, 0.01, NOW, providerStart)
    ).rejects.toThrow("redis unavailable");
    redis.eval = originalEval;
    expect(providerStart).not.toHaveBeenCalled();
  });
});

async function admit(
  attemptId: string,
  userKey: string,
  cost: number,
  now: Date,
  providerStart: () => void | Promise<void>
): Promise<void> {
  await admitMessengerProviderSpend({
    reqId: `req-${createHash("sha256").update(attemptId).digest("hex").slice(0, 8)}`,
    attemptId,
    userKey,
    tenantScope: tenantScope(userKey),
    estimatedCostUsd: cost,
    costEstimateComplete: true,
    now,
    recordAttempt: async () => {
      await providerStart();
    },
  });
}
