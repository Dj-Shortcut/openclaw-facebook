import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  commitMessengerImageQuotaSuccess,
  eraseMessengerImageQuotaForUser,
  getMessengerImageQuotaStatus,
  renewMessengerImageQuotaReservation,
  reserveMessengerImageQuota,
  type MessengerImageQuotaIdentity,
} from "./_core/messengerImageQuotaStore";
import { MessengerPrivacyFenceError } from "./_core/messengerPrivacySubject";
import {
  getRedisClient,
  resetRedisClientForTests,
  type RedisLike,
} from "./_core/redis";

const enabled = process.env.RUN_REDIS_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const DEDICATED_REDIS_DATABASE = 14;
const originalRedisUrl = process.env.REDIS_URL;
const originalDailyLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;
const originalMonthlyLimit = process.env.MESSENGER_FREE_MONTHLY_LIMIT;
const originalQuotaTimeZone = process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE;

const rawIdentitySentinel = `raw-psid-${randomUUID()}`;
const baseIdentity: MessengerImageQuotaIdentity = {
  workspaceId: 910_001,
  channelConnectionId: 920_001,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: createHash("sha256").update(rawIdentitySentinel).digest("hex"),
};

let redis: RedisLike;

suite("Messenger image quota Redis Lua integration", () => {
  beforeAll(async () => {
    process.env.REDIS_URL = useDedicatedRedisDatabase(
      originalRedisUrl ?? "redis://127.0.0.1:6379"
    );
    process.env.MESSENGER_FREE_DAILY_LIMIT = "5";
    process.env.MESSENGER_FREE_MONTHLY_LIMIT = "20";
    process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = "Europe/Brussels";
    resetRedisClientForTests();
    redis = await getRedisClient();
    await redis.ping();
  });

  beforeEach(async () => {
    await flushDedicatedDatabase();
  });

  afterAll(async () => {
    await flushDedicatedDatabase();
    resetRedisClientForTests();
    restoreEnv("REDIS_URL", originalRedisUrl);
    restoreEnv("MESSENGER_FREE_DAILY_LIMIT", originalDailyLimit);
    restoreEnv("MESSENGER_FREE_MONTHLY_LIMIT", originalMonthlyLimit);
    restoreEnv("MESSENGER_IMAGE_QUOTA_TIME_ZONE", originalQuotaTimeZone);
  });

  it("atomically shares five slots across concurrent old and new bindings", async () => {
    const reconnectedIdentity = {
      ...baseIdentity,
      bindingEpoch: baseIdentity.bindingEpoch + 1,
    };
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        reserveAndCommitUntilTerminal(
          index % 2 === 0 ? baseIdentity : reconnectedIdentity,
          `concurrent-${index}-${randomUUID()}`
        )
      )
    );

    expect(outcomes.filter(outcome => outcome === "committed")).toHaveLength(5);
    expect(
      outcomes.filter(outcome => outcome === "daily_exhausted")
    ).toHaveLength(7);
    await expect(getMessengerImageQuotaStatus(baseIdentity)).resolves.toEqual({
      daily: { used: 5, limit: 5, remaining: 0 },
      monthly: { used: 5, limit: 20, remaining: 15 },
    });
  });

  it("keeps counters and a replay receipt across a binding reconnect", async () => {
    const requestId = `replay-${randomUUID()}`;
    await commitSuccess(baseIdentity, requestId);
    const reconnectedIdentity = {
      ...baseIdentity,
      bindingEpoch: baseIdentity.bindingEpoch + 1,
    };

    const replay = await reserveMessengerImageQuota(
      reconnectedIdentity,
      requestId
    );
    expect(replay).toMatchObject({ status: "already_committed" });
    if (replay.status !== "already_committed") {
      throw new Error(`Expected replay receipt, received ${replay.status}`);
    }

    await expect(
      commitMessengerImageQuotaSuccess(reconnectedIdentity, replay.reservation)
    ).resolves.toMatchObject({
      committed: true,
      alreadyCommitted: true,
      quotaStatus: {
        daily: { used: 1, remaining: 4 },
        monthly: { used: 1, remaining: 19 },
      },
    });
    await expect(
      getMessengerImageQuotaStatus(reconnectedIdentity)
    ).resolves.toMatchObject({
      daily: { used: 1 },
      monthly: { used: 1 },
    });
  });

  it("rejects an old reservation through a newer binding fence", async () => {
    const decision = await reserveMessengerImageQuota(
      baseIdentity,
      `stale-reservation-${randomUUID()}`
    );
    expect(decision.status).toBe("reserved");
    if (decision.status !== "reserved") {
      throw new Error(`Expected reservation, received ${decision.status}`);
    }
    const reconnectedIdentity = {
      ...baseIdentity,
      bindingEpoch: baseIdentity.bindingEpoch + 1,
    };

    await expect(
      commitMessengerImageQuotaSuccess(
        reconnectedIdentity,
        decision.reservation
      )
    ).resolves.toMatchObject({ committed: false, alreadyCommitted: false });
    await expect(
      getMessengerImageQuotaStatus(reconnectedIdentity)
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });
  });

  it("isolates tenant, connection, and privacy epoch scopes", async () => {
    await commitSuccess(baseIdentity, `base-${randomUUID()}`);
    const isolatedScopes: MessengerImageQuotaIdentity[] = [
      {
        ...baseIdentity,
        workspaceId: baseIdentity.workspaceId + 1,
        channelConnectionId: baseIdentity.channelConnectionId + 1,
      },
      {
        ...baseIdentity,
        channelConnectionId: baseIdentity.channelConnectionId + 2,
      },
      { ...baseIdentity, privacyEpoch: baseIdentity.privacyEpoch + 1 },
    ];

    for (const scope of isolatedScopes) {
      await expect(getMessengerImageQuotaStatus(scope)).resolves.toMatchObject({
        daily: { used: 0 },
        monthly: { used: 0 },
      });
      await commitSuccess(scope, `isolated-${randomUUID()}`);
    }

    for (const scope of [baseIdentity, ...isolatedScopes]) {
      await expect(getMessengerImageQuotaStatus(scope)).resolves.toMatchObject({
        daily: { used: 1 },
        monthly: { used: 1 },
      });
    }
  });

  it("scrubs every reconnect epoch without crossing the workspace boundary", async () => {
    const reactivatedScope = {
      ...baseIdentity,
      privacyEpoch: baseIdentity.privacyEpoch + 2,
    };
    const oldConnectionScope = {
      ...baseIdentity,
      channelConnectionId: baseIdentity.channelConnectionId + 1,
      bindingEpoch: 1,
      privacyEpoch: 2,
    };
    const otherWorkspaceScope = {
      ...baseIdentity,
      workspaceId: baseIdentity.workspaceId + 1,
      channelConnectionId: baseIdentity.channelConnectionId + 2,
    };
    await commitSuccess(baseIdentity, `delete-base-${randomUUID()}`);
    await commitSuccess(
      oldConnectionScope,
      `delete-old-connection-${randomUUID()}`
    );
    await commitSuccess(
      otherWorkspaceScope,
      `delete-other-workspace-${randomUUID()}`
    );
    const racingReservation = await reserveMessengerImageQuota(
      baseIdentity,
      `reserved-before-erasure-${randomUUID()}`
    );
    expect(racingReservation.status).toBe("reserved");
    if (racingReservation.status !== "reserved") {
      throw new Error("Expected a pre-erasure reservation");
    }
    await expect(
      renewMessengerImageQuotaReservation(baseIdentity, {
        ...racingReservation.reservation,
        token: "not-the-reservation-owner",
      })
    ).resolves.toBe(false);
    await expect(
      renewMessengerImageQuotaReservation(
        baseIdentity,
        racingReservation.reservation
      )
    ).resolves.toBe(true);

    await eraseMessengerImageQuotaForUser({
      workspaceId: baseIdentity.workspaceId,
      channelConnectionId: baseIdentity.channelConnectionId,
      privacyEpoch: baseIdentity.privacyEpoch + 1,
      userKey: baseIdentity.userKey,
    });

    await expect(
      getMessengerImageQuotaStatus(baseIdentity)
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      reserveMessengerImageQuota(baseIdentity, `late-${randomUUID()}`)
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      renewMessengerImageQuotaReservation(
        baseIdentity,
        racingReservation.reservation
      )
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      commitMessengerImageQuotaSuccess(
        baseIdentity,
        racingReservation.reservation
      )
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      getMessengerImageQuotaStatus(oldConnectionScope)
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      getMessengerImageQuotaStatus(reactivatedScope)
    ).resolves.toMatchObject({
      daily: { used: 0 },
      monthly: { used: 0 },
    });
    await expect(
      getMessengerImageQuotaStatus(otherWorkspaceScope)
    ).resolves.toMatchObject({
      daily: { used: 1 },
      monthly: { used: 1 },
    });

    const keys = await scanAllKeys();
    const tombstones = keys.filter(key => key.includes(":erased:"));
    expect(tombstones.length).toBeGreaterThanOrEqual(2);
    for (const key of tombstones) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(50 * 24 * 60 * 60);
    }
    const durableMetadata = [...keys, ...(await readRedisMetadata(keys))].join(
      "\n"
    );
    expect(durableMetadata).not.toContain(baseIdentity.userKey);
  });

  it("stores no raw or supplied identity in Redis keys or values", async () => {
    const requestId = `request-${rawIdentitySentinel}`;
    const result = await commitSuccess(baseIdentity, requestId);
    const keys = await scanAllKeys();
    const values = await readRedisMetadata(keys);
    const durablePayload = [...keys, ...values].join("\n");

    expect(keys.length).toBeGreaterThan(0);
    expect(durablePayload).not.toContain(rawIdentitySentinel);
    expect(durablePayload).not.toContain(requestId);
    expect(durablePayload).not.toContain(baseIdentity.userKey);
    expect(keys.join("\n")).not.toContain(String(baseIdentity.workspaceId));
    expect(keys.join("\n")).not.toContain(
      String(baseIdentity.channelConnectionId)
    );
    expect(durablePayload).not.toContain(result.reservationToken);
  });
});

type TerminalOutcome = "committed" | "daily_exhausted" | "monthly_exhausted";

async function reserveAndCommitUntilTerminal(
  identity: MessengerImageQuotaIdentity,
  requestId: string
): Promise<TerminalOutcome> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const decision = await reserveMessengerImageQuota(identity, requestId);
    if (decision.status === "busy") {
      await new Promise(resolve => setTimeout(resolve, 1));
      continue;
    }
    if (
      decision.status === "daily_exhausted" ||
      decision.status === "monthly_exhausted"
    ) {
      return decision.status;
    }
    if (decision.status === "already_committed") {
      return "committed";
    }
    if (!("reservation" in decision)) {
      throw new Error(`Unexpected Redis quota result: ${decision.status}`);
    }

    const committed = await commitMessengerImageQuotaSuccess(
      identity,
      decision.reservation
    );
    if (!committed.committed) {
      throw new Error("Redis quota reservation could not be committed");
    }
    return "committed";
  }
  throw new Error("Redis quota reservation stayed busy for too long");
}

async function commitSuccess(
  identity: MessengerImageQuotaIdentity,
  requestId: string
): Promise<{ reservationToken: string }> {
  const decision = await reserveMessengerImageQuota(identity, requestId);
  expect(decision).toMatchObject({ status: "reserved" });
  if (decision.status !== "reserved" || !("reservation" in decision)) {
    throw new Error(`Expected reservation, received ${decision.status}`);
  }
  const result = await commitMessengerImageQuotaSuccess(
    identity,
    decision.reservation
  );
  expect(result).toMatchObject({ committed: true, alreadyCommitted: false });
  return { reservationToken: decision.reservation.token };
}

async function scanAllKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, page] = await redis.scan(
      cursor,
      "MATCH",
      "*",
      "COUNT",
      100
    );
    cursor = nextCursor;
    keys.push(...page);
  } while (cursor !== "0");
  return keys.sort();
}

async function readRedisMetadata(keys: string[]): Promise<string[]> {
  const values = await Promise.all(
    keys.map(async key =>
      key.endsWith(":index")
        ? await redis.smembers(key)
        : ((await redis.get(key)) ?? [])
    )
  );
  return values.flat();
}

async function flushDedicatedDatabase(): Promise<void> {
  await redis.eval("return redis.call('flushdb')", 0);
}

function useDedicatedRedisDatabase(configuredUrl: string): string {
  const url = new URL(configuredUrl);
  url.pathname = `/${DEDICATED_REDIS_DATABASE}`;
  return url.toString();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
