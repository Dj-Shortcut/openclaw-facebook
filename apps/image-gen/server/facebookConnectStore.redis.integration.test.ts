import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  consumeFacebookPage,
  startFacebookConnect,
  storeFacebookAuthorizationCode,
  storeFacebookPages,
  validateStoredFacebookState,
} from "./_core/facebookConnectStore";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const originalJwtSecret = process.env.JWT_SECRET;
const redisKeysToDelete = new Set<string>();

const RAW_PAGE_TOKEN =
  "redis-facebook-page-token-sentinel-that-must-never-be-stored";
const RAW_AUTHORIZATION_CODE =
  "redis-facebook-authorization-code-sentinel-that-must-never-be-stored";
const REDIS_TEST_JWT_SECRET =
  "facebook-connect-real-redis-test-secret-with-adequate-length";
const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
] as const;

function connectStateKey(state: string) {
  return `portal:facebook_connect:${state}`;
}

async function storePageInRedis() {
  const connectState = await startFacebookConnect({
    workspaceId: 7401,
    userId: 7402,
    now: Date.now(),
  });
  const key = connectStateKey(connectState.state);
  redisKeysToDelete.add(key);

  await storeFacebookPages({
    state: connectState.state,
    pages: [
      {
        id: "redis-page-7403",
        name: "Redis Integration Page",
        grantedScopes: [...FACEBOOK_SCOPES],
        accessToken: RAW_PAGE_TOKEN,
      },
    ],
  });

  return { connectState, key };
}

suite("Facebook connect token sealing with Redis", () => {
  beforeAll(async () => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/13";
    process.env.JWT_SECRET = REDIS_TEST_JWT_SECRET;
    resetRedisClientForTests();
    await (await getRedisClient()).ping();
  });

  afterEach(async () => {
    const redis = await getRedisClient();
    for (const key of redisKeysToDelete) {
      await redis.del(key);
    }
    redisKeysToDelete.clear();
    process.env.JWT_SECRET = REDIS_TEST_JWT_SECRET;
  });

  afterAll(() => {
    resetRedisClientForTests();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  it("stores only an fc1 envelope with a bounded TTL and consumes it once", async () => {
    const { connectState, key } = await storePageInRedis();
    const redis = await getRedisClient();
    const serialized = await redis.get(key);

    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain(RAW_PAGE_TOKEN);
    const stored = JSON.parse(serialized ?? "{}") as {
      pages?: Array<{ accessToken?: string }>;
    };
    expect(stored.pages?.[0]?.accessToken).toMatch(/^fc1:/);
    await expect(redis.ttl(key)).resolves.toBeGreaterThan(0);
    await expect(redis.ttl(key)).resolves.toBeLessThanOrEqual(600);

    await expect(
      consumeFacebookPage({
        state: connectState.state,
        workspaceId: 7401,
        userId: 7402,
        pageId: "redis-page-7403",
      })
    ).resolves.toMatchObject({
      id: "redis-page-7403",
      accessToken: RAW_PAGE_TOKEN,
    });
    await expect(redis.get(key)).resolves.toBeNull();
  });

  it("seals the authorization code and opens it only after scope validation", async () => {
    const connectState = await startFacebookConnect({
      workspaceId: 7401,
      userId: 7402,
      now: Date.now(),
    });
    const key = connectStateKey(connectState.state);
    redisKeysToDelete.add(key);
    await expect(
      storeFacebookAuthorizationCode({
        state: connectState.state,
        code: RAW_AUTHORIZATION_CODE,
      })
    ).resolves.toBe(true);

    const redis = await getRedisClient();
    const serialized = await redis.get(key);
    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain(RAW_AUTHORIZATION_CODE);
    const stored = JSON.parse(serialized ?? "{}");
    expect(stored.authorizationCode).toBeUndefined();
    expect(stored.authorizationCodeEnvelope).toMatch(/^fca1:/);
    await expect(redis.ttl(key)).resolves.toBeGreaterThan(0);
    await expect(redis.ttl(key)).resolves.toBeLessThanOrEqual(600);

    await expect(
      validateStoredFacebookState({
        state: connectState.state,
        workspaceId: 7401,
        userId: 7402,
      })
    ).resolves.toMatchObject({
      authorizationCode: RAW_AUTHORIZATION_CODE,
    });
    expect(await redis.get(key)).not.toContain(RAW_AUTHORIZATION_CODE);
  });

  it("retains a tampered authorization-code envelope without exposing it", async () => {
    const connectState = await startFacebookConnect({
      workspaceId: 7401,
      userId: 7402,
      now: Date.now(),
    });
    const key = connectStateKey(connectState.state);
    redisKeysToDelete.add(key);
    await storeFacebookAuthorizationCode({
      state: connectState.state,
      code: RAW_AUTHORIZATION_CODE,
    });

    const redis = await getRedisClient();
    const serialized = await redis.get(key);
    const stored = JSON.parse(serialized ?? "{}");
    const parts = String(stored.authorizationCodeEnvelope).split(":");
    const encrypted = parts[3] ?? "";
    parts[3] = `${encrypted.startsWith("A") ? "B" : "A"}${encrypted.slice(1)}`;
    stored.authorizationCodeEnvelope = parts.join(":");
    await redis.set(key, JSON.stringify(stored), "KEEPTTL");

    await expect(
      validateStoredFacebookState({
        state: connectState.state,
        workspaceId: 7401,
        userId: 7402,
      })
    ).rejects.toThrow("authorization code envelope could not be opened");
    expect(await redis.get(key)).not.toContain(RAW_AUTHORIZATION_CODE);
  });

  it("rejects the code envelope under different key material", async () => {
    const connectState = await startFacebookConnect({
      workspaceId: 7401,
      userId: 7402,
      now: Date.now(),
    });
    const key = connectStateKey(connectState.state);
    redisKeysToDelete.add(key);
    await storeFacebookAuthorizationCode({
      state: connectState.state,
      code: RAW_AUTHORIZATION_CODE,
    });

    try {
      process.env.JWT_SECRET =
        "different-facebook-connect-real-redis-test-secret-value";
      await expect(
        validateStoredFacebookState({
          state: connectState.state,
          workspaceId: 7401,
          userId: 7402,
        })
      ).rejects.toThrow("authorization code envelope could not be opened");
      expect(await (await getRedisClient()).get(key)).not.toContain(
        RAW_AUTHORIZATION_CODE
      );
    } finally {
      process.env.JWT_SECRET = REDIS_TEST_JWT_SECRET;
    }
  });

  it("fails closed and retains state when the stored envelope is tampered", async () => {
    const { connectState, key } = await storePageInRedis();
    const redis = await getRedisClient();
    const serialized = await redis.get(key);
    const stored = JSON.parse(serialized ?? "{}") as {
      pages: Array<{ accessToken: string }>;
    };
    const envelopeParts = stored.pages[0]!.accessToken.split(":");
    const encrypted = envelopeParts[3]!;
    envelopeParts[3] = `${encrypted.startsWith("A") ? "B" : "A"}${encrypted.slice(1)}`;
    stored.pages[0]!.accessToken = envelopeParts.join(":");
    await redis.set(key, JSON.stringify(stored), "KEEPTTL");

    await expect(
      consumeFacebookPage({
        state: connectState.state,
        workspaceId: 7401,
        userId: 7402,
        pageId: "redis-page-7403",
      })
    ).rejects.toThrow("envelope could not be opened");
    await expect(redis.get(key)).resolves.not.toBeNull();
    expect(await redis.get(key)).not.toContain(RAW_PAGE_TOKEN);
  });

  it("deletes legacy plaintext OAuth records without extending their TTL", async () => {
    const redis = await getRedisClient();
    const state = "redis-legacy-plaintext-oauth-state";
    const key = connectStateKey(state);
    redisKeysToDelete.add(key);
    await redis.set(
      key,
      JSON.stringify({
        state,
        workspaceId: 7401,
        userId: 7402,
        createdAt: Date.now(),
        authorizationCode: RAW_AUTHORIZATION_CODE,
      }),
      "EX",
      600
    );

    await expect(
      validateStoredFacebookState({
        state,
        workspaceId: 7401,
        userId: 7402,
      })
    ).rejects.toThrow("legacy plaintext facebook authorization code rejected");
    await expect(redis.get(key)).resolves.toBeNull();
  });

  it("deletes legacy plaintext Page-token records instead of refreshing them", async () => {
    const redis = await getRedisClient();
    const state = "redis-legacy-plaintext-page-state";
    const key = connectStateKey(state);
    redisKeysToDelete.add(key);
    await redis.set(
      key,
      JSON.stringify({
        state,
        workspaceId: 7401,
        userId: 7402,
        createdAt: Date.now(),
        pages: [
          {
            id: "redis-page-7403",
            name: "Legacy Redis Page",
            grantedScopes: [...FACEBOOK_SCOPES],
            accessToken: RAW_PAGE_TOKEN,
          },
        ],
      }),
      "EX",
      600
    );

    await expect(
      consumeFacebookPage({
        state,
        workspaceId: 7401,
        userId: 7402,
        pageId: "redis-page-7403",
      })
    ).rejects.toThrow("legacy plaintext facebook page token rejected");
    await expect(redis.get(key)).resolves.toBeNull();
  });
});
