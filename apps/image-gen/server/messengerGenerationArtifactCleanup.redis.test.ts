import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const enabled = process.env.RUN_REDIS_INTEGRATION === "1";
const { assertPrivacyMock, storageDeleteMock } = vi.hoisted(() => ({
  assertPrivacyMock: vi.fn(async () => undefined),
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: assertPrivacyMock,
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: vi.fn(async () => undefined),
}));
vi.mock("./storage", () => ({
  storageKeyFromPublicUrl: (url: string) =>
    `generated/${url.split("/").at(-1)}`,
  storageDelete: storageDeleteMock,
}));

import {
  createMessengerGenerationPublishHooks,
  deleteMessengerGenerationCompletionsForUser,
  ensureMessengerGenerationCompletionReady,
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDelivered,
  runDueMessengerGenerationArtifactCleanup,
  scheduleMessengerGenerationArtifactCleanup,
  type MessengerGenerationCompletionFence,
} from "./_core/messengerGenerationCompletion";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

describe.skipIf(!enabled)("messenger artifact cleanup Redis queue", () => {
  const run = randomUUID();

  function fence(suffix: string): MessengerGenerationCompletionFence {
    return {
      workspaceId: 52_001,
      channelConnectionId: 810 + suffix.charCodeAt(0),
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: `artifact-cleanup-user-${run}`,
      pageId: `artifact-page-${suffix}`,
      channel: "whatsapp",
    };
  }

  async function clearCleanupKeys(): Promise<void> {
    const redis = await getRedisClient();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "messenger-generation-artifact-cleanup:*",
        "COUNT",
        200
      );
      for (const key of keys) await redis.del(key);
      cursor = next;
    } while (cursor !== "0");
  }

  beforeAll(async () => {
    await (await getRedisClient()).ping();
    await clearCleanupKeys();
  });

  beforeEach(() => {
    assertPrivacyMock.mockReset();
    assertPrivacyMock.mockResolvedValue(undefined);
    storageDeleteMock.mockReset();
    storageDeleteMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await clearCleanupKeys();
    resetRedisClientForTests();
  });

  it("lets confirmed delivery cancel pending cleanup without deleting the object", async () => {
    const scope = fence("delivered");
    const reqId = `artifact-delivered-${run}`;
    const imageUrl = "https://assets.example/artifact-delivered.jpg";
    const now = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      now,
      scope
    );
    await scheduleMessengerGenerationArtifactCleanup({
      reqId,
      imageUrl,
      userKey: scope.userKey,
      fence: scope,
      reason: "pre_transport_rejected",
      now,
    });
    await markMessengerGenerationDelivered(
      reqId,
      imageUrl,
      scope.userKey,
      now + 1,
      scope
    );

    await expect(
      runDueMessengerGenerationArtifactCleanup(now + 2)
    ).resolves.toBe(0);
    expect(storageDeleteMock).not.toHaveBeenCalled();
    await expect(
      getMessengerGenerationCompletion(reqId, scope)
    ).resolves.toMatchObject({ deliveryStatus: "delivered", imageUrl });
  });

  it("claims one exact cleanup across replicas and completes idempotently", async () => {
    const scope = fence("replicas");
    const reqId = `artifact-replicas-${run}`;
    const imageUrl = "https://assets.example/artifact-replicas.jpg";
    const now = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      now,
      scope
    );
    await scheduleMessengerGenerationArtifactCleanup({
      reqId,
      imageUrl,
      userKey: scope.userKey,
      fence: scope,
      reason: "ownership_rejected",
      now,
    });

    const results = await Promise.all([
      runDueMessengerGenerationArtifactCleanup(now + 1),
      runDueMessengerGenerationArtifactCleanup(now + 1),
    ]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledTimes(1);
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/artifact-replicas.jpg"
    );
    await expect(
      getMessengerGenerationCompletion(reqId, scope)
    ).resolves.toBeNull();
    await expect(
      runDueMessengerGenerationArtifactCleanup(now + 2)
    ).resolves.toBe(0);
  });

  it("rejects a tampered cleanup object key without deleting anything", async () => {
    const scope = fence("tamper");
    const reqId = `artifact-tamper-${run}`;
    const imageUrl = "https://assets.example/artifact-tamper.jpg";
    const now = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      now,
      scope
    );
    await scheduleMessengerGenerationArtifactCleanup({
      reqId,
      imageUrl,
      userKey: scope.userKey,
      fence: scope,
      reason: "pre_transport_rejected",
      now,
    });
    const redis = await getRedisClient();
    let cursor = "0";
    let payloadKey: string | null = null;
    let payload: Record<string, unknown> | null = null;
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        "messenger-generation-artifact-cleanup:*:job:*",
        "COUNT",
        200
      );
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const candidate = JSON.parse(raw) as Record<string, unknown>;
        if (candidate.reqId === reqId) {
          payloadKey = key;
          payload = candidate;
          break;
        }
      }
      cursor = next;
    } while (!payloadKey && cursor !== "0");
    expect(payloadKey).not.toBeNull();
    expect(payload).not.toBeNull();
    payload!.objectKey = "generated/images/unrelated-tenant-object.jpg";
    await redis.set(
      payloadKey!,
      JSON.stringify(payload),
      "PXAT",
      Number(payload!.expiresAt)
    );

    await expect(ensureMessengerGenerationCompletionReady()).rejects.toThrow(
      "pending payload is invalid"
    );
    await expect(runDueMessengerGenerationArtifactCleanup(now)).rejects.toThrow(
      "payload is invalid"
    );
    expect(storageDeleteMock).not.toHaveBeenCalled();
    await clearCleanupKeys();
  });

  it("durably schedules cleanup when a privacy rejection follows inventory", async () => {
    const scope = fence("fallback");
    const reqId = `artifact-fallback-${run}`;
    const imageUrl = "https://assets.example/artifact-fallback.jpg";
    const now = Date.now();
    assertPrivacyMock.mockRejectedValueOnce(new Error("privacy tombstoned"));

    await expect(
      markMessengerGenerationCompleted(
        reqId,
        imageUrl,
        scope.userKey,
        now,
        scope
      )
    ).rejects.toThrow("privacy tombstoned");
    expect(storageDeleteMock).not.toHaveBeenCalled();

    await expect(
      runDueMessengerGenerationArtifactCleanup(Date.now() + 1)
    ).resolves.toBe(1);
    expect(storageDeleteMock).toHaveBeenLastCalledWith(
      "generated/artifact-fallback.jpg"
    );
  });

  it("never deletes an already delivered object when a stale replay loses ownership", async () => {
    const scope = fence("delivered-replay");
    const reqId = `artifact-delivered-replay-${run}`;
    const imageUrl = "https://assets.example/artifact-delivered-replay.jpg";
    const now = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      now,
      scope
    );
    await markMessengerGenerationDelivered(
      reqId,
      imageUrl,
      scope.userKey,
      now + 1,
      scope
    );
    assertPrivacyMock.mockRejectedValueOnce(new Error("ownership changed"));

    await expect(
      markMessengerGenerationCompleted(
        reqId,
        imageUrl,
        scope.userKey,
        now + 2,
        scope
      )
    ).rejects.toThrow("ownership changed");

    expect(storageDeleteMock).not.toHaveBeenCalled();
    await expect(
      runDueMessengerGenerationArtifactCleanup(now + 3)
    ).resolves.toBe(0);
    await expect(
      getMessengerGenerationCompletion(reqId, scope)
    ).resolves.toMatchObject({ deliveryStatus: "delivered", imageUrl });
  });

  it("blocks a late delivery marker once cleanup has acquired its lease", async () => {
    const scope = fence("race");
    const reqId = `artifact-race-${run}`;
    const imageUrl = "https://assets.example/artifact-race.jpg";
    const now = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      now,
      scope
    );
    await scheduleMessengerGenerationArtifactCleanup({
      reqId,
      imageUrl,
      userKey: scope.userKey,
      fence: scope,
      reason: "privacy_tombstone",
      now,
    });
    let releaseDelete: (() => void) | undefined;
    storageDeleteMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseDelete = resolve;
        })
    );

    const cleanup = runDueMessengerGenerationArtifactCleanup(now + 1);
    await vi.waitFor(() => expect(storageDeleteMock).toHaveBeenCalledOnce());
    await expect(
      markMessengerGenerationDelivered(
        reqId,
        imageUrl,
        scope.userKey,
        now + 2,
        scope
      )
    ).rejects.toThrow("cleanup_started");
    releaseDelete?.();
    await expect(cleanup).resolves.toBe(1);
  });

  it("dead-letters bounded storage failures and makes readiness fail closed", async () => {
    const scope = fence("dead");
    const reqId = `artifact-dead-${run}`;
    const imageUrl = "https://assets.example/artifact-dead.jpg";
    let now = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      now,
      scope
    );
    await scheduleMessengerGenerationArtifactCleanup({
      reqId,
      imageUrl,
      userKey: scope.userKey,
      fence: scope,
      reason: "pre_transport_rejected",
      now,
    });
    storageDeleteMock.mockRejectedValue(new Error("storage unavailable"));

    for (let attempt = 0; attempt < 8; attempt += 1) {
      now += 60 * 60 * 1_000 + 1;
      if (attempt === 7) {
        await expect(
          runDueMessengerGenerationArtifactCleanup(now)
        ).rejects.toThrow("dead-letter");
      } else {
        await runDueMessengerGenerationArtifactCleanup(now);
      }
    }
    await expect(ensureMessengerGenerationCompletionReady()).rejects.toThrow(
      "dead-letter"
    );

    storageDeleteMock.mockResolvedValue(undefined);
    await clearCleanupKeys();
  });

  it("scrubs more than one cursor batch without an unbounded Redis read", async () => {
    const scope = fence("batch");
    const reqIds = Array.from(
      { length: 205 },
      (_, index) => `artifact-batch-${run}-${index}`
    );
    await Promise.all(
      reqIds.map((reqId, index) =>
        markMessengerGenerationCompleted(
          reqId,
          `https://assets.example/artifact-batch-${index}.jpg`,
          scope.userKey,
          Date.now(),
          scope
        )
      )
    );
    storageDeleteMock.mockClear();

    await deleteMessengerGenerationCompletionsForUser(scope.userKey, scope);

    expect(storageDeleteMock).toHaveBeenCalledTimes(205);
    await expect(
      Promise.all(
        [reqIds[0], reqIds[100], reqIds[204]].map(reqId =>
          getMessengerGenerationCompletion(reqId, scope)
        )
      )
    ).resolves.toEqual([null, null, null]);
  });

  it("scrubs an object uploaded after pre-publish inventory but before completion", async () => {
    const exactFence = fence("prepublish-crash");
    const hooks = createMessengerGenerationPublishHooks(exactFence);
    const objectKey = `generated/images/prepublish-${run}.jpg`;
    const now = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      await hooks.beforeStore(objectKey);
      // Simulate process loss immediately after storagePut: no completion row
      // is written. Erasure waits for the bounded ambiguous-upload window,
      // then the durable subject inventory remains authoritative.
      vi.setSystemTime(now + 5 * 60_000 + 1);
      await deleteMessengerGenerationCompletionsForUser(
        exactFence.userKey,
        exactFence
      );
      expect(storageDeleteMock).toHaveBeenCalledWith(objectKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot finish erasure while an object upload is still in flight", async () => {
    const exactFence = fence("upload-race");
    const hooks = createMessengerGenerationPublishHooks(exactFence);
    const objectKey = `generated/images/upload-race-${run}.jpg`;
    const imageUrl = `https://assets.example/upload-race-${run}.jpg`;
    const now = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      await hooks.beforeStore(objectKey);

      await expect(
        deleteMessengerGenerationCompletionsForUser(
          exactFence.userKey,
          exactFence
        )
      ).rejects.toThrow("upload is still settling");
      expect(storageDeleteMock).not.toHaveBeenCalled();

      // The upload completes after the privacy tombstone was committed. The
      // publisher is rejected and the subsequent saga retry deletes the exact
      // inventoried object before erasure can finish.
      await expect(
        hooks.afterStoreSuccess(objectKey, imageUrl)
      ).rejects.toThrow("was erased during upload");
      await deleteMessengerGenerationCompletionsForUser(
        exactFence.userKey,
        exactFence
      );
      expect(storageDeleteMock).toHaveBeenCalledWith(objectKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains ambiguous upload inventory until the settle deadline", async () => {
    const exactFence = fence("ambiguous-upload");
    const hooks = createMessengerGenerationPublishHooks(exactFence);
    const objectKey = `generated/images/upload-ambiguous-${run}.jpg`;
    const now = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      await hooks.beforeStore(objectKey);
      await hooks.afterStoreFailure(objectKey);

      await expect(
        deleteMessengerGenerationCompletionsForUser(
          exactFence.userKey,
          exactFence
        )
      ).rejects.toThrow("upload is still settling");
      expect(storageDeleteMock).not.toHaveBeenCalled();

      vi.setSystemTime(now + 5 * 60_000 + 1);
      await deleteMessengerGenerationCompletionsForUser(
        exactFence.userKey,
        exactFence
      );
      expect(storageDeleteMock).toHaveBeenCalledWith(objectKey);
    } finally {
      vi.useRealTimers();
    }
  });
});
