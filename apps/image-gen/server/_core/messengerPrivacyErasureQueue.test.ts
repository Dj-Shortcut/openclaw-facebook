import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeRedis = vi.hoisted(() => {
  const values = new Map<string, string>();
  const pending = new Map<string, number>();
  return {
    values,
    pending,
    reset() {
      values.clear();
      pending.clear();
    },
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(
      async (
        key: string,
        value: string,
        ...options: Array<string | number>
      ) => {
        if (options.includes("NX") && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }
    ),
    eval: vi.fn(
      async (script: string, keyCount: number, ...parameters: unknown[]) => {
        const keys = parameters.slice(0, keyCount).map(String);
        const argv = parameters.slice(keyCount).map(String);
        if (script.includes("privacy erasure job key has invalid type")) {
          const current = values.get(keys[0]!) ?? argv[0]!;
          values.set(keys[0]!, current);
          pending.set(argv[2]!, Number(argv[1]));
          return current;
        }
        if (script.includes('local result = {"jobs", tostring(count)}')) {
          const entries = [...pending.entries()].sort(
            (left, right) => left[1] - right[1]
          );
          const limit = Number(argv[0]);
          if (entries.length > limit) {
            return ["backlog", String(entries.length)];
          }
          return [
            "jobs",
            String(entries.length),
            ...entries.flatMap(([jobId, score]) => [
              jobId,
              values.get(`${argv[1]}${jobId}`) ?? "",
              String(score),
            ]),
          ];
        }
        if (script.includes("privacy erasure heartbeat key has invalid type")) {
          const oldest = [...pending.values()].sort(
            (left, right) => left - right
          )[0];
          return [
            values.get(keys[0]!) ?? "",
            String(pending.size),
            oldest === undefined ? "" : String(oldest),
          ];
        }
        if (script.includes('redis.call("ZSCORE", KEYS[3], ARGV[1])')) {
          return [
            values.get(keys[0]!) ?? "",
            values.get(keys[1]!) ?? "",
            pending.has(argv[0]!) ? String(pending.get(argv[0]!)) : "",
          ];
        }
        if (
          script.includes('redis.call("SET", KEYS[2], ARGV[2])') &&
          script.includes('redis.call("ZADD", KEYS[3]')
        ) {
          if (values.get(keys[0]!) !== argv[0]) return 0;
          values.set(keys[1]!, argv[1]!);
          pending.set(argv[3]!, Number(argv[2]));
          return 1;
        }
        if (
          script.includes('return redis.call("DEL", KEYS[1])') &&
          keyCount === 1
        ) {
          if (values.get(keys[0]!) !== argv[0]) return 0;
          values.delete(keys[0]!);
          return 1;
        }
        throw new Error("Unexpected Redis script in privacy erasure unit test");
      }
    ),
  };
});

vi.mock("./redis", () => ({
  isRedisEnabled: () => true,
  getRedisClient: async () => fakeRedis,
}));

const KEY_1 = Buffer.alloc(32, 0x31).toString("base64url");
const KEY_2 = Buffer.alloc(32, 0x32).toString("base64url");
const SCOPE = {
  workspaceId: 91,
  channelConnectionId: 27,
  pageId: "page-mocked-key-rotation",
  bindingEpoch: 4,
  userKey: "privacy_user_key_mock_rotation_1",
  oldPrivacyEpoch: 8,
};

describe("Messenger privacy erasure encryption keyring", () => {
  beforeEach(() => {
    fakeRedis.reset();
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "mock-privacy-erasure-jwt-secret".repeat(2));
    configureKeys("key-1", [{ id: "key-1", key: KEY_1 }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rewraps under the active key after a module restart while retaining job identity", async () => {
    const firstRuntime = await import("./messengerPrivacyErasureQueue");
    const jobId = await firstRuntime.enqueueMessengerPrivacyErasureJob({
      psid: "mock-rotation-private-subject",
      scope: SCOPE,
      now: 1_000,
    });
    const before = readStoredJob(jobId);
    expect(before.sealedPsid).toMatch(/^v2:key-1:/);

    configureKeys("key-2", [
      { id: "key-1", key: KEY_1 },
      { id: "key-2", key: KEY_2 },
    ]);
    vi.resetModules();
    const restartedRuntime = await import("./messengerPrivacyErasureQueue");
    const claim = await restartedRuntime.claimMessengerPrivacyErasureJob(
      jobId,
      1_000
    );

    expect(claim?.psid).toBe("mock-rotation-private-subject");
    expect(claim?.job.jobId).toBe(jobId);
    expect(claim?.job.sealedPsid).toMatch(/^v2:key-2:/);
    expect(readStoredJob(jobId).sealedPsid).toMatch(/^v2:key-2:/);
  });

  it("keeps Facebook and WhatsApp erasure jobs in distinct channel scopes", async () => {
    const runtime = await import("./messengerPrivacyErasureQueue");
    const psid = "mock-cross-channel-private-subject";
    const facebookJobId = await runtime.enqueueMessengerPrivacyErasureJob({
      psid,
      scope: { ...SCOPE, channel: "facebook_messenger" },
      now: 1_500,
    });
    const whatsappJobId = await runtime.enqueueMessengerPrivacyErasureJob({
      psid,
      scope: { ...SCOPE, channel: "whatsapp" },
      now: 1_500,
    });

    expect(whatsappJobId).not.toBe(facebookJobId);
    expect(readStoredJob(facebookJobId)).toMatchObject({
      channel: "facebook_messenger",
    });
    expect(readStoredJob(whatsappJobId)).toMatchObject({
      channel: "whatsapp",
    });
  });

  it("fails closed without the retired decryption key and releases the lease", async () => {
    const firstRuntime = await import("./messengerPrivacyErasureQueue");
    const jobId = await firstRuntime.enqueueMessengerPrivacyErasureJob({
      psid: "mock-retired-key-private-subject",
      scope: SCOPE,
      now: 2_000,
    });

    configureKeys("key-2", [{ id: "key-2", key: KEY_2 }]);
    vi.resetModules();
    const missingKeyRuntime = await import("./messengerPrivacyErasureQueue");
    await expect(
      missingKeyRuntime.claimMessengerPrivacyErasureJob(jobId, 2_000)
    ).rejects.toThrow("envelope key is unavailable");
    expect(
      [...fakeRedis.values.keys()].some(key => key.includes(":lease:"))
    ).toBe(false);

    configureKeys("key-2", [
      { id: "key-1", key: KEY_1 },
      { id: "key-2", key: KEY_2 },
    ]);
    await expect(
      missingKeyRuntime.claimMessengerPrivacyErasureJob(jobId, 2_000)
    ).resolves.toMatchObject({ psid: "mock-retired-key-private-subject" });
  });

  it("fails readiness before an old key is retired while a pending job still needs it", async () => {
    const firstRuntime = await import("./messengerPrivacyErasureQueue");
    const jobId = await firstRuntime.enqueueMessengerPrivacyErasureJob({
      psid: "mock-readiness-private-subject",
      scope: SCOPE,
      now: 2_500,
    });

    configureKeys("key-2", [{ id: "key-2", key: KEY_2 }]);
    vi.resetModules();
    const missingKeyRuntime = await import("./messengerPrivacyErasureQueue");
    await expect(
      missingKeyRuntime.ensureMessengerPrivacyErasureQueueReadable()
    ).rejects.toThrow("envelope key is unavailable");

    configureKeys("key-2", [
      { id: "key-1", key: KEY_1 },
      { id: "key-2", key: KEY_2 },
    ]);
    const claim = await missingKeyRuntime.claimMessengerPrivacyErasureJob(
      jobId,
      2_500
    );
    expect(claim?.job.sealedPsid).toMatch(/^v2:key-2:/);
    await expect(
      missingKeyRuntime.ensureMessengerPrivacyErasureQueueReadable()
    ).resolves.toBeUndefined();
  });

  it("rejects malformed, duplicate, non-canonical, and inactive keyrings", async () => {
    const runtime = await import("./messengerPrivacyErasureQueue");

    vi.stubEnv("MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON", "not-json");
    expect(() =>
      runtime.assertMessengerPrivacyErasureEncryptionConfig()
    ).toThrow("valid JSON");

    configureKeys("key-1", [
      { id: "key-1", key: KEY_1 },
      { id: "key-1", key: KEY_2 },
    ]);
    expect(() =>
      runtime.assertMessengerPrivacyErasureEncryptionConfig()
    ).toThrow("duplicate key id");

    configureKeys("key-1", [{ id: "key-1", key: `${KEY_1}=` }]);
    expect(() =>
      runtime.assertMessengerPrivacyErasureEncryptionConfig()
    ).toThrow("encryption key is invalid");

    configureKeys("missing-active", [{ id: "key-1", key: KEY_1 }]);
    expect(() =>
      runtime.assertMessengerPrivacyErasureEncryptionConfig()
    ).toThrow("is not present");
  });

  it("fails readiness instead of sampling an oversized pending backlog", async () => {
    const runtime = await import("./messengerPrivacyErasureQueue");
    for (let index = 0; index < 501; index += 1) {
      fakeRedis.pending.set(index.toString(16).padStart(64, "0"), index);
    }
    await expect(
      runtime.ensureMessengerPrivacyErasureQueueReadable()
    ).rejects.toThrow("readiness backlog exceeded");
  });

  it("rejects a pending score that no longer matches the durable job", async () => {
    const runtime = await import("./messengerPrivacyErasureQueue");
    const now = Date.now();
    const jobId = await runtime.enqueueMessengerPrivacyErasureJob({
      psid: "mock-score-mismatch-private-subject",
      scope: SCOPE,
      now,
    });
    fakeRedis.pending.set(jobId, now + 1);

    await expect(
      runtime.ensureMessengerPrivacyErasureQueueReadable()
    ).rejects.toThrow("pending score mismatch");
  });

  it("keeps an idle worker ready and rejects failed or overdue polls", async () => {
    const runtime = await import("./messengerPrivacyErasureQueue");
    const now = Date.now();

    await runtime.recordMessengerPrivacyErasureWorkerPollSuccess(0, now);
    await expect(
      runtime.ensureMessengerPrivacyErasureWorkerReady(now + 1)
    ).resolves.toBeUndefined();
    await expect(
      runtime.ensureMessengerPrivacyErasureWorkerReady(now + 30_001)
    ).rejects.toThrow("heartbeat is stale");

    await runtime.recordMessengerPrivacyErasureWorkerPollFailure(
      new TypeError("redis claim failed"),
      now + 2
    );
    await expect(
      runtime.ensureMessengerPrivacyErasureWorkerReady(now + 3)
    ).rejects.toThrow("last poll failed");

    await runtime.recordMessengerPrivacyErasureWorkerPollSuccess(0, now + 4);
    fakeRedis.pending.set("f".repeat(64), now - 60_001);
    await expect(
      runtime.ensureMessengerPrivacyErasureWorkerReady(now + 4)
    ).rejects.toThrow("backlog is overdue");
  });

  it("proves a pending job retry was durably stored and unlocked", async () => {
    const runtime = await import("./messengerPrivacyErasureQueue");
    const now = Date.now();
    const jobId = await runtime.enqueueMessengerPrivacyErasureJob({
      psid: "mock-retry-store-private-subject",
      scope: SCOPE,
      now,
    });
    const claim = await runtime.claimMessengerPrivacyErasureJob(jobId, now);
    expect(claim).not.toBeNull();
    await runtime.rescheduleMessengerPrivacyErasureJob({
      claim: claim!,
      errorCode: "RetryableFailure",
      now,
    });

    await expect(
      runtime.assertMessengerPrivacyErasureRetryStored(claim!)
    ).resolves.toBeUndefined();
  });
});

function configureKeys(
  activeKeyId: string,
  keys: Array<{ id: string; key: string }>
): void {
  vi.stubEnv("MESSENGER_PRIVACY_ERASURE_ENCRYPTION_ACTIVE_KEY_ID", activeKeyId);
  vi.stubEnv(
    "MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON",
    JSON.stringify(keys)
  );
}

function readStoredJob(jobId: string): {
  sealedPsid: string;
  channel?: "facebook_messenger" | "whatsapp";
} {
  const entry = [...fakeRedis.values.entries()].find(([key]) =>
    key.endsWith(`:job:${jobId}`)
  );
  if (!entry) throw new Error("privacy erasure job is missing from fake Redis");
  return JSON.parse(entry[1]) as {
    sealedPsid: string;
    channel?: "facebook_messenger" | "whatsapp";
  };
}
