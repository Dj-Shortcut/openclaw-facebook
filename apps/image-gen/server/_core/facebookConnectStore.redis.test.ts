import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: string, ..._args: Array<string | number>) => {
        values.set(key, value);
        return "OK";
      }
    ),
    del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
  };
});

vi.mock("./redis", () => ({
  isRedisEnabled: () => true,
  getRedisClient: async () => redis,
}));

import {
  consumeFacebookPage,
  getStoredFacebookState,
  startFacebookConnect,
  storeFacebookAuthorizationCode,
  storeFacebookPages,
  validateStoredFacebookState,
} from "./facebookConnectStore";

const RAW_PAGE_TOKEN = "raw-facebook-page-token-sentinel";
const RAW_AUTHORIZATION_CODE = "raw-facebook-authorization-code-sentinel";
const SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
] as const;

async function storePage() {
  const state = await startFacebookConnect({
    workspaceId: 42,
    userId: 7,
    now: Date.now(),
  });
  await storeFacebookPages({
    state: state.state,
    pages: [
      {
        id: "page-42",
        name: "Tenant Page",
        grantedScopes: [...SCOPES],
        accessToken: RAW_PAGE_TOKEN,
      },
    ],
  });
  return state;
}

describe("Facebook connect state token storage", () => {
  beforeEach(() => {
    redis.values.clear();
    redis.get.mockClear();
    redis.set.mockClear();
    redis.del.mockClear();
    vi.stubEnv("JWT_SECRET", "a".repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores only an authenticated envelope and preserves the Redis TTL", async () => {
    await storePage();

    const serialized = redis.set.mock.calls.at(-1)?.[1] ?? "";
    expect(serialized).toBeTypeOf("string");
    expect(serialized).not.toContain(RAW_PAGE_TOKEN);
    expect(JSON.parse(serialized).pages[0].accessToken).toMatch(/^fc1:/);
    expect(redis.set.mock.calls).toHaveLength(2);
    for (const call of redis.set.mock.calls) {
      expect(call.slice(2)).toEqual(["EX", 600]);
    }
  });

  it("stores the authorization code only as a domain-separated envelope", async () => {
    const state = await startFacebookConnect({
      workspaceId: 42,
      userId: 7,
      now: Date.now(),
    });

    await expect(
      storeFacebookAuthorizationCode({
        state: state.state,
        code: RAW_AUTHORIZATION_CODE,
      })
    ).resolves.toBe(true);

    const serialized = redis.set.mock.calls.at(-1)?.[1] ?? "";
    expect(serialized).not.toContain(RAW_AUTHORIZATION_CODE);
    const stored = JSON.parse(serialized);
    expect(stored.authorizationCode).toBeUndefined();
    expect(stored.authorizationCodeEnvelope).toMatch(/^fca1:/);
    expect(redis.set.mock.calls.at(-1)?.slice(2)).toEqual(["EX", 600]);

    await expect(
      validateStoredFacebookState({
        state: state.state,
        workspaceId: 42,
        userId: 7,
      })
    ).resolves.toMatchObject({
      authorizationCode: RAW_AUTHORIZATION_CODE,
    });
    expect(
      JSON.stringify(await getStoredFacebookState(state.state))
    ).not.toContain(RAW_AUTHORIZATION_CODE);
  });

  it("fails closed for a tampered authorization-code envelope", async () => {
    const state = await startFacebookConnect({
      workspaceId: 42,
      userId: 7,
      now: Date.now(),
    });
    await storeFacebookAuthorizationCode({
      state: state.state,
      code: RAW_AUTHORIZATION_CODE,
    });
    const key = `portal:facebook_connect:${state.state}`;
    const stored = JSON.parse(redis.values.get(key) ?? "{}");
    const parts = String(stored.authorizationCodeEnvelope).split(":");
    parts[3] = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1)}`;
    stored.authorizationCodeEnvelope = parts.join(":");
    redis.values.set(key, JSON.stringify(stored));

    await expect(
      validateStoredFacebookState({
        state: state.state,
        workspaceId: 42,
        userId: 7,
      })
    ).rejects.toThrow("authorization code envelope could not be opened");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("validates code ownership before unsealing and fails with a wrong key", async () => {
    const state = await startFacebookConnect({
      workspaceId: 42,
      userId: 7,
      now: Date.now(),
    });
    await storeFacebookAuthorizationCode({
      state: state.state,
      code: RAW_AUTHORIZATION_CODE,
    });
    vi.stubEnv("JWT_SECRET", "b".repeat(32));

    await expect(
      validateStoredFacebookState({
        state: state.state,
        workspaceId: 99,
        userId: 7,
      })
    ).rejects.toThrow("does not match workspace");
    await expect(
      validateStoredFacebookState({
        state: state.state,
        workspaceId: 42,
        userId: 7,
      })
    ).rejects.toThrow("authorization code envelope could not be opened");
  });

  it("binds the authorization-code envelope to the stored tenant identity", async () => {
    const state = await startFacebookConnect({
      workspaceId: 42,
      userId: 7,
      now: Date.now(),
    });
    await storeFacebookAuthorizationCode({
      state: state.state,
      code: RAW_AUTHORIZATION_CODE,
    });
    const key = `portal:facebook_connect:${state.state}`;
    const stored = JSON.parse(redis.values.get(key) ?? "{}");
    stored.workspaceId = 99;
    redis.values.set(key, JSON.stringify(stored));

    await expect(
      validateStoredFacebookState({
        state: state.state,
        workspaceId: 99,
        userId: 7,
      })
    ).rejects.toThrow("authorization code envelope could not be opened");
  });

  it("opens the selected Page token after matching state ownership", async () => {
    const state = await storePage();

    await expect(
      consumeFacebookPage({
        state: state.state,
        workspaceId: 42,
        userId: 7,
        pageId: "page-42",
      })
    ).resolves.toMatchObject({
      id: "page-42",
      accessToken: RAW_PAGE_TOKEN,
    });
    expect(redis.del).toHaveBeenCalledWith(
      `portal:facebook_connect:${state.state}`
    );
  });

  it("fails closed when the envelope is tampered with", async () => {
    const state = await storePage();
    const key = `portal:facebook_connect:${state.state}`;
    const stored = JSON.parse(redis.values.get(key) ?? "{}");
    const envelope = String(stored.pages[0].accessToken);
    const parts = envelope.split(":");
    parts[3] = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1)}`;
    stored.pages[0].accessToken = parts.join(":");
    redis.values.set(key, JSON.stringify(stored));

    await expect(
      consumeFacebookPage({
        state: state.state,
        workspaceId: 42,
        userId: 7,
        pageId: "page-42",
      })
    ).rejects.toThrow("envelope could not be opened");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("fails closed with missing or different key material", async () => {
    const state = await storePage();

    vi.stubEnv("JWT_SECRET", "b".repeat(32));
    await expect(
      consumeFacebookPage({
        state: state.state,
        workspaceId: 42,
        userId: 7,
        pageId: "page-42",
      })
    ).rejects.toThrow("envelope could not be opened");

    vi.stubEnv("JWT_SECRET", "");
    await expect(
      consumeFacebookPage({
        state: state.state,
        workspaceId: 42,
        userId: 7,
        pageId: "page-42",
      })
    ).rejects.toThrow("envelope could not be opened");
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("validates tenant ownership before attempting to open the envelope", async () => {
    const state = await storePage();
    vi.stubEnv("JWT_SECRET", "b".repeat(32));

    await expect(
      consumeFacebookPage({
        state: state.state,
        workspaceId: 99,
        userId: 7,
        pageId: "page-42",
      })
    ).rejects.toThrow("does not match workspace");
  });

  it("deletes a legacy plaintext authorization code without refreshing its TTL", async () => {
    const state = "legacy-plaintext-authorization-state";
    const key = `portal:facebook_connect:${state}`;
    redis.values.set(
      key,
      JSON.stringify({
        state,
        workspaceId: 42,
        userId: 7,
        createdAt: Date.now(),
        authorizationCode: RAW_AUTHORIZATION_CODE,
      })
    );
    const writesBeforeRead = redis.set.mock.calls.length;

    await expect(
      validateStoredFacebookState({ state, workspaceId: 42, userId: 7 })
    ).rejects.toThrow("legacy plaintext facebook authorization code rejected");

    expect(redis.del).toHaveBeenCalledWith(key);
    expect(redis.values.has(key)).toBe(false);
    expect(redis.set.mock.calls).toHaveLength(writesBeforeRead);
  });

  it("deletes legacy plaintext Page tokens without refreshing their TTL", async () => {
    const state = "legacy-plaintext-page-state";
    const key = `portal:facebook_connect:${state}`;
    redis.values.set(
      key,
      JSON.stringify({
        state,
        workspaceId: 42,
        userId: 7,
        createdAt: Date.now(),
        pages: [
          {
            id: "page-42",
            name: "Legacy Tenant Page",
            grantedScopes: [...SCOPES],
            accessToken: RAW_PAGE_TOKEN,
          },
        ],
      })
    );
    const writesBeforeRead = redis.set.mock.calls.length;

    await expect(
      consumeFacebookPage({
        state,
        workspaceId: 42,
        userId: 7,
        pageId: "page-42",
      })
    ).rejects.toThrow("legacy plaintext facebook page token rejected");

    expect(redis.del).toHaveBeenCalledWith(key);
    expect(redis.values.has(key)).toBe(false);
    expect(redis.set.mock.calls).toHaveLength(writesBeforeRead);
  });

  it("deletes an unknown persisted shape instead of carrying it forward", async () => {
    const state = "unknown-shape-state";
    const key = `portal:facebook_connect:${state}`;
    redis.values.set(
      key,
      JSON.stringify({
        state,
        workspaceId: 42,
        userId: 7,
        createdAt: Date.now(),
        unexpectedLegacyField: "must-not-survive",
      })
    );

    await expect(
      validateStoredFacebookState({ state, workspaceId: 42, userId: 7 })
    ).rejects.toThrow("invalid facebook connect state storage");

    expect(redis.del).toHaveBeenCalledWith(key);
    expect(redis.values.has(key)).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
