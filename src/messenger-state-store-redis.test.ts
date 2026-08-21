import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import {
  buildRedisMessengerStateKeys,
  createRedisMessengerEphemeralStateStore,
  RedisMessengerEphemeralStateStore,
} from "./messenger-state-store-redis.js";

describe("Redis Messenger ephemeral state store", () => {
  it("derives versioned keys without raw tenant or event identifiers", () => {
    const keys = buildRedisMessengerStateKeys(
      { hmacSecret: Buffer.alloc(32, 7), keyId: "test" },
      {
        scope: { accountId: "raw-account", pageId: "raw-page" },
        eventIdentity: "raw-mid-and-sender",
        kind: "image_forward",
        dayKey: "2026-08-21",
      },
    );
    const serialized = JSON.stringify(keys);

    expect(keys.claim).toContain("ocfb:shared:v1:test:dedupe");
    expect(keys.counter).toContain(`{${keys.partition}}`);
    expect(keys.reservation).toContain(`{${keys.partition}}`);
    expect(serialized).not.toContain("raw-account");
    expect(serialized).not.toContain("raw-page");
    expect(serialized).not.toContain("raw-mid-and-sender");
  });

  it("rejects missing or malformed Redis secrets before connecting", () => {
    const originalUrl = process.env.MESSENGER_SHARED_STATE_REDIS_URL;
    const originalSecret = process.env.MESSENGER_SHARED_STATE_HMAC_SECRET;
    try {
      process.env.MESSENGER_SHARED_STATE_REDIS_URL = "redis://127.0.0.1:6379";
      delete process.env.MESSENGER_SHARED_STATE_HMAC_SECRET;
      expect(() => createRedisMessengerEphemeralStateStore()).toThrow(
        "must be 64 lowercase hex characters",
      );

      process.env.MESSENGER_SHARED_STATE_HMAC_SECRET = "A".repeat(64);
      expect(() => createRedisMessengerEphemeralStateStore()).toThrow(
        "must be 64 lowercase hex characters",
      );
    } finally {
      if (originalUrl === undefined) delete process.env.MESSENGER_SHARED_STATE_REDIS_URL;
      else process.env.MESSENGER_SHARED_STATE_REDIS_URL = originalUrl;
      if (originalSecret === undefined) delete process.env.MESSENGER_SHARED_STATE_HMAC_SECRET;
      else process.env.MESSENGER_SHARED_STATE_HMAC_SECRET = originalSecret;
    }
  });

  it("coalesces concurrent readiness checks", async () => {
    const client = {
      status: "wait",
      connect: vi.fn(async function (this: { status: string }) {
        await Promise.resolve();
        this.status = "ready";
      }),
      ping: vi.fn(async () => "PONG"),
      eval: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK"),
      disconnect: vi.fn(),
    };
    const store = new RedisMessengerEphemeralStateStore(client as never, {
      hmacSecret: Buffer.alloc(32, 9),
      keyId: "test",
    });

    await Promise.all(Array.from({ length: 20 }, () => store.ensureReady()));

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledTimes(1);
  });

  const redisUrl = process.env.TEST_MESSENGER_REDIS_URL;
  const integrationTest = redisUrl ? it : it.skip;

  integrationTest("atomically shares dedupe and daily caps across clients", async () => {
    const keyId = `ci_${randomBytes(4).toString("hex")}`;
    const config = { hmacSecret: randomBytes(32), keyId };
    const clientA = new Redis(redisUrl!, { lazyConnect: true });
    const clientB = new Redis(redisUrl!, { lazyConnect: true });
    const storeA = new RedisMessengerEphemeralStateStore(clientA, config);
    const storeB = new RedisMessengerEphemeralStateStore(clientB, config);
    await Promise.all([storeA.ensureReady(), storeB.ensureReady()]);

    try {
      const claimResults = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          (index % 2 === 0 ? storeA : storeB).claimMessage({
            scope: { accountId: "account-ci", pageId: "page-ci" },
            eventIdentity: "mid-ci",
            ownerToken: `owner-${index}`,
            ttlMs: 60_000,
          }),
        ),
      );
      expect(claimResults.filter(Boolean)).toHaveLength(1);

      const expiresAtMs = Date.now() + 60_000;
      const budgetResults = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          (index % 2 === 0 ? storeA : storeB).reserveDaily({
            scope: { accountId: "account-ci", pageId: "page-ci" },
            kind: "image_forward",
            dayKey: "2026-08-21",
            eventIdentity: `event-${index}`,
            cap: 20,
            expiresAtMs,
          }),
        ),
      );
      expect(budgetResults.filter((result) => result.ok)).toHaveLength(20);
      expect(Math.max(...budgetResults.map((result) => result.count))).toBe(20);

      await expect(storeA.reserveDaily({
        scope: { accountId: "account-ci", pageId: "page-ci-b" },
        kind: "image_forward",
        dayKey: "2026-08-21",
        eventIdentity: "event-page-b",
        cap: 20,
        expiresAtMs,
      })).resolves.toMatchObject({ ok: true, count: 1 });

      const keys = await clientA.keys(`ocfb:shared:v1:${keyId}:*`);
      const serializedKeys = JSON.stringify(keys);
      expect(keys.length).toBeGreaterThan(0);
      expect(serializedKeys).not.toContain("account-ci");
      expect(serializedKeys).not.toContain("page-ci");
      expect(serializedKeys).not.toContain("mid-ci");
      const pageAPartition = buildRedisMessengerStateKeys(config, {
        scope: { accountId: "account-ci", pageId: "page-ci" },
        eventIdentity: "unused",
        kind: "image_forward",
        dayKey: "2026-08-21",
      }).partition;
      expect(
        keys.filter((key) => key.includes(`:budget-request:{${pageAPartition}}:`)),
      ).toHaveLength(20);
      await Promise.all(keys.map(async (key) => {
        expect(await clientA.pttl(key)).toBeGreaterThan(0);
      }));
    } finally {
      const keys = await clientA.keys(`ocfb:shared:v1:${keyId}:*`);
      if (keys.length > 0) await clientA.del(...keys);
      await Promise.all([storeA.close(), storeB.close()]);
    }
  });

  integrationTest("rejects an ACL that allows ping but not the write probe", async () => {
    const admin = new Redis(redisUrl!, { lazyConnect: true });
    await admin.connect();
    const username = `ocfb_ci_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(16).toString("hex");
    let restricted: Redis | undefined;
    try {
      await admin.call(
        "ACL",
        "SETUSER",
        username,
        "reset",
        "on",
        `>${password}`,
        "~ocfb:shared:*",
        "+ping",
      );
      const restrictedUrl = new URL(redisUrl!);
      restrictedUrl.username = username;
      restrictedUrl.password = password;
      restricted = new Redis(restrictedUrl.toString(), { lazyConnect: true });
      const store = new RedisMessengerEphemeralStateStore(restricted, {
        hmacSecret: randomBytes(32),
        keyId: "acl_test",
      });

      await expect(store.ensureReady()).rejects.toMatchObject({ code: "connect" });
      await store.close();
      restricted = undefined;
    } finally {
      restricted?.disconnect();
      await admin.call("ACL", "DELUSER", username);
      await admin.quit();
    }
  });
});
