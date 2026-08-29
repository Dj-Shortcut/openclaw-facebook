import { createHash, randomUUID } from "node:crypto";
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
const { storageDeleteMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: vi.fn(async () => undefined),
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: vi.fn(async () => undefined),
}));
vi.mock("./storage", () => ({
  storageKeyFromPublicUrl: (url: string) => {
    const path = new URL(url).pathname.replace(/^\/+/, "");
    return path.startsWith("generated/images/v1/")
      ? path
      : `generated/images/${url.split("/").at(-1)}`;
  },
  storageDelete: storageDeleteMock,
}));

import {
  confirmMessengerGenerationDeliveryReceipts,
  deleteMessengerGenerationCompletionsForUser,
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDeliveryAccepted,
  markMessengerGenerationDeliveryRetryable,
  markMessengerGenerationDeliveryStarted,
  markMessengerGenerationDelivered,
  markMessengerGenerationQuotaCommitted,
  registerMessengerObjectForPrivacyCleanup,
  type MessengerGenerationCompletionFence,
  unregisterMessengerObjectFromPrivacyCleanup,
} from "./_core/messengerGenerationCompletion";
import { buildMessengerStorageObjectKey } from "./_core/messengerStorageObject";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

describe.skipIf(!enabled)("messenger completion Redis CAS", () => {
  const run = randomUUID();
  const fence = (suffix: string): MessengerGenerationCompletionFence => ({
    workspaceId: 42001,
    channelConnectionId: suffix === "a" ? 701 : 702,
    bindingEpoch: 3,
    privacyEpoch: 5,
    userKey: `redis-completion-${run}`,
    pageId: `page-${suffix}`,
  });
  const deliveryFence = {
    ...fence("a"),
    userKey: `redis-completion-delivery-${run}`,
  };
  const quotaFence = {
    ...fence("a"),
    userKey: `redis-completion-quota-${run}`,
  };
  const receiptRaceFence = {
    ...fence("a"),
    userKey: createHash("sha256")
      .update(`redis-completion-receipt-race-${run}`)
      .digest("hex"),
    channel: "facebook_messenger" as const,
  };
  const receiptOldFence = {
    ...fence("a"),
    bindingEpoch: 30,
    privacyEpoch: 31,
    userKey: createHash("sha256")
      .update(`redis-completion-receipt-erasure-${run}`)
      .digest("hex"),
    pageId: "page-redis-receipt-old",
    channel: "facebook_messenger" as const,
  };
  const receiptCurrentFence = {
    ...receiptOldFence,
    bindingEpoch: 31,
    pageId: "page-redis-receipt-current",
  };
  const malformedReceiptFence = {
    ...fence("a"),
    bindingEpoch: 32,
    privacyEpoch: 33,
    userKey: createHash("sha256")
      .update(`redis-completion-receipt-malformed-${run}`)
      .digest("hex"),
    pageId: "page-redis-receipt-malformed",
    channel: "facebook_messenger" as const,
  };

  beforeAll(async () => {
    await (await getRedisClient()).ping();
  });
  beforeEach(() => {
    storageDeleteMock.mockReset();
    storageDeleteMock.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await Promise.all(
      [
        fence("a"),
        { ...fence("a"), privacyEpoch: 6 },
        fence("b"),
        deliveryFence,
        quotaFence,
        receiptRaceFence,
        receiptOldFence,
        receiptCurrentFence,
        malformedReceiptFence,
      ].map(scope =>
        deleteMessengerGenerationCompletionsForUser(scope.userKey, scope)
      )
    );
    resetRedisClientForTests();
  });

  it("isolates same reqId, keeps delivered monotone, and scrubs objects", async () => {
    const first = fence("a");
    const second = fence("b");
    const reqId = `req-${run}`;
    await Promise.all([
      markMessengerGenerationCompleted(
        reqId,
        "https://assets.example/a.jpg",
        first.userKey,
        Date.now(),
        first
      ),
      markMessengerGenerationCompleted(
        reqId,
        "https://assets.example/b.jpg",
        second.userKey,
        Date.now(),
        second
      ),
    ]);
    await markMessengerGenerationDelivered(
      reqId,
      "https://assets.example/a.jpg",
      first.userKey,
      Date.now(),
      first
    );
    await markMessengerGenerationCompleted(
      reqId,
      "https://assets.example/replayed.jpg",
      first.userKey,
      Date.now(),
      first
    );
    await expect(
      registerMessengerObjectForPrivacyCleanup(
        "inbound-source/source-upload.jpg",
        first
      )
    ).resolves.toBe(true);
    await expect(
      registerMessengerObjectForPrivacyCleanup(
        "inbound-source/already-cleaned.jpg",
        first
      )
    ).resolves.toBe(true);
    await expect(
      unregisterMessengerObjectFromPrivacyCleanup(
        "inbound-source/already-cleaned.jpg",
        first
      )
    ).resolves.toBe(true);
    await expect(
      getMessengerGenerationCompletion(reqId, first)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      imageUrl: "https://assets.example/a.jpg",
    });
    await expect(
      getMessengerGenerationCompletion(reqId, second)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/b.jpg",
    });

    await deleteMessengerGenerationCompletionsForUser(first.userKey, first);
    await expect(
      getMessengerGenerationCompletion(reqId, first)
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(reqId, second)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/b.jpg",
    });
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/images/a.jpg");
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/source-upload.jpg"
    );
    expect(storageDeleteMock).not.toHaveBeenCalledWith(
      "inbound-source/already-cleaned.jpg"
    );

    storageDeleteMock.mockClear();
    await expect(
      registerMessengerObjectForPrivacyCleanup(
        "inbound-source/late-after-erase.jpg",
        first
      )
    ).resolves.toBe(false);
    await expect(
      markMessengerGenerationCompleted(
        `req-after-erase-${run}`,
        "https://assets.example/late-after-erase.jpg",
        first.userKey,
        Date.now(),
        first
      )
    ).rejects.toThrow("subject is erased");
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/late-after-erase.jpg"
    );

    const reactivated = {
      ...first,
      privacyEpoch: first.privacyEpoch + 1,
    };
    const reactivatedReqId = `req-after-reactivation-${run}`;
    await expect(
      markMessengerGenerationCompleted(
        reactivatedReqId,
        "https://assets.example/reactivated.jpg",
        reactivated.userKey,
        Date.now(),
        reactivated
      )
    ).resolves.toBeUndefined();
    await expect(
      getMessengerGenerationCompletion(reactivatedReqId, reactivated)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/reactivated.jpg",
      privacyEpoch: reactivated.privacyEpoch,
    });

    await expect(
      markMessengerGenerationCompleted(
        `req-old-epoch-after-reactivation-${run}`,
        "https://assets.example/old-epoch.jpg",
        first.userKey,
        Date.now(),
        first
      )
    ).rejects.toThrow("subject is erased");
  });

  it("rejects foreign scoped keys and never deletes one from poisoned Redis inventory", async () => {
    const scope = {
      ...fence("a"),
      userKey: createHash("sha256")
        .update(`redis-poisoned-storage-${run}`)
        .digest("hex"),
    };
    const validCompletionKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope,
      fileName: "1787461200100-123e4567-e89b-42d3-a456-426614174010.png",
    });
    const validInventoryKey = buildMessengerStorageObjectKey({
      kind: "inbound_source",
      scope,
      fileName: "1787461200101-123e4567-e89b-42d3-a456-426614174011.png",
    });
    const foreignKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: { ...scope, workspaceId: scope.workspaceId + 1 },
      fileName: "1787461200102-123e4567-e89b-42d3-a456-426614174012.png",
    });

    await expect(
      registerMessengerObjectForPrivacyCleanup(foreignKey, scope)
    ).rejects.toThrow("does not match completion privacy fence");
    await expect(
      unregisterMessengerObjectFromPrivacyCleanup(foreignKey, scope)
    ).rejects.toThrow("does not match completion privacy fence");
    await expect(
      markMessengerGenerationCompleted(
        `req-foreign-write-${run}`,
        `https://assets.example/${foreignKey}`,
        scope.userKey,
        Date.now(),
        scope
      )
    ).rejects.toThrow("does not match completion privacy fence");
    await expect(
      getMessengerGenerationCompletion(`req-foreign-write-${run}`, scope)
    ).resolves.toBeNull();

    const subjectDigest = createHash("sha256")
      .update(String(scope.workspaceId))
      .update("\0")
      .update(String(scope.channelConnectionId))
      .update("\0")
      .update(scope.userKey)
      .digest("hex");
    const tag = `{mgc:${subjectDigest}}`;
    const completionIndex = `messenger-generation-completion:user:${tag}:epoch:${scope.privacyEpoch}:index`;
    const objectIndex = `messenger-generation-completion:user:${tag}:epoch:${scope.privacyEpoch}:objects`;
    const epochRegistry = `messenger-generation-completion:user:${tag}:epochs`;
    const validRecordKey = `messenger-generation-completion:${tag}:valid-${run}`;
    const poisonedRecordKey = `messenger-generation-completion:${tag}:poisoned-${run}`;
    const redis = await getRedisClient();
    await redis.set(
      validRecordKey,
      JSON.stringify({
        reqId: `req-valid-record-${run}`,
        imageUrl: `https://assets.example/${validCompletionKey}`,
        completedAt: Date.now(),
        ...scope,
      }),
      "EX",
      60
    );
    await redis.set(
      poisonedRecordKey,
      JSON.stringify({
        reqId: `req-poisoned-record-${run}`,
        imageUrl: `https://assets.example/${foreignKey}`,
        completedAt: Date.now(),
        ...scope,
      }),
      "EX",
      60
    );
    await redis.sadd(completionIndex, validRecordKey);
    await redis.sadd(completionIndex, poisonedRecordKey);
    await redis.sadd(objectIndex, validInventoryKey);
    await redis.sadd(objectIndex, foreignKey);
    await redis.sadd(epochRegistry, String(scope.privacyEpoch));

    storageDeleteMock.mockClear();
    await deleteMessengerGenerationCompletionsForUser(scope.userKey, scope);

    expect(storageDeleteMock).toHaveBeenCalledWith(validCompletionKey);
    expect(storageDeleteMock).toHaveBeenCalledWith(validInventoryKey);
    expect(storageDeleteMock).not.toHaveBeenCalledWith(foreignKey);
    await expect(redis.get(validRecordKey)).resolves.toBeNull();
    await expect(redis.get(poisonedRecordKey)).resolves.toBeNull();
  });

  it("atomically claims one image transport and never reopens delivered state", async () => {
    const scope = deliveryFence;
    const reqId = `req-delivery-claim-${run}`;
    const imageUrl = "https://assets.example/delivery-claim.jpg";
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      Date.now(),
      scope
    );

    const claims = await Promise.all([
      markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        scope.userKey,
        Date.now(),
        scope
      ),
      markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        scope.userKey,
        Date.now(),
        scope
      ),
    ]);
    expect(claims.sort()).toEqual(["already_started", "started"]);

    await markMessengerGenerationDeliveryRetryable(
      reqId,
      imageUrl,
      scope.userKey,
      Date.now(),
      scope
    );
    await expect(
      markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        scope.userKey,
        Date.now(),
        scope
      )
    ).resolves.toBe("started");
    await markMessengerGenerationDelivered(
      reqId,
      imageUrl,
      scope.userKey,
      Date.now(),
      scope
    );
    await markMessengerGenerationDeliveryRetryable(
      reqId,
      imageUrl,
      scope.userKey,
      Date.now(),
      scope
    );
    await expect(
      getMessengerGenerationCompletion(reqId, scope)
    ).resolves.toMatchObject({ deliveryStatus: "delivered" });
  });

  it("atomically consumes a receipt-first MID and rejects a duplicate exact-scope claim", async () => {
    const scope = receiptRaceFence;
    const messageId = `mid-receipt-first-${run}`;
    const firstReqId = `req-receipt-first-${run}`;
    const secondReqId = `req-receipt-conflict-${run}`;
    const urls = [0, 1].map(index => {
      const objectKey = buildMessengerStorageObjectKey({
        kind: "generated_image",
        scope,
        fileName: `178746120020${index}-123e4567-e89b-42d3-a456-42661417420${index}.png`,
      });
      return `https://assets.example/${objectKey}`;
    });

    await markMessengerGenerationCompleted(
      firstReqId,
      urls[0],
      scope.userKey,
      Date.now(),
      scope,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      firstReqId,
      urls[0],
      scope.userKey,
      Date.now(),
      scope
    );
    await expect(
      confirmMessengerGenerationDeliveryReceipts([messageId], scope)
    ).resolves.toEqual([]);
    await expect(
      markMessengerGenerationDeliveryAccepted(
        firstReqId,
        urls[0],
        messageId,
        scope.userKey,
        Date.now(),
        scope
      )
    ).resolves.toBe("delivered");

    await markMessengerGenerationCompleted(
      secondReqId,
      urls[1],
      scope.userKey,
      Date.now(),
      scope,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      secondReqId,
      urls[1],
      scope.userKey,
      Date.now(),
      scope
    );
    await expect(
      markMessengerGenerationDeliveryAccepted(
        secondReqId,
        urls[1],
        messageId,
        scope.userKey,
        Date.now(),
        scope
      )
    ).rejects.toThrow("message claim conflict");
    await expect(
      getMessengerGenerationCompletion(firstReqId, scope)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveryProof: "meta_delivery_receipt_v1",
    });
  });

  it("erases old-binding pending receipt and MID-claim keys through the current binding", async () => {
    const oldScope = receiptOldFence;
    const currentScope = receiptCurrentFence;
    const reqId = `req-receipt-old-binding-${run}`;
    const objectKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: oldScope,
      fileName: "1787461200210-123e4567-e89b-42d3-a456-426614174210.png",
    });
    const imageUrl = `https://assets.example/${objectKey}`;
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      oldScope.userKey,
      Date.now(),
      oldScope,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      reqId,
      imageUrl,
      oldScope.userKey,
      Date.now(),
      oldScope
    );
    await expect(
      markMessengerGenerationDeliveryAccepted(
        reqId,
        imageUrl,
        `mid-old-claim-${run}`,
        oldScope.userKey,
        Date.now(),
        oldScope
      )
    ).resolves.toBe("receipt_pending");
    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        [`mid-old-pending-${run}`],
        oldScope
      )
    ).resolves.toEqual([]);

    const subjectDigest = createHash("sha256")
      .update(String(oldScope.workspaceId))
      .update("\0")
      .update(String(oldScope.channelConnectionId))
      .update("\0")
      .update(oldScope.userKey)
      .digest("hex");
    const tag = `{mgc:${subjectDigest}}`;
    const receiptScopeDigest = createHash("sha256")
      .update("leaderbot.messenger-delivery-scope.v1\0", "utf8")
      .update(String(oldScope.workspaceId))
      .update("\0")
      .update(String(oldScope.channelConnectionId))
      .update("\0")
      .update(String(oldScope.bindingEpoch))
      .update("\0")
      .update(String(oldScope.privacyEpoch))
      .update("\0")
      .update(oldScope.userKey)
      .update("\0")
      .update(oldScope.pageId)
      .update("\0")
      .update(oldScope.channel)
      .digest("hex");
    const receiptKey = `messenger-generation-completion:user:${tag}:receipt:${receiptScopeDigest}`;
    const claimKey = `messenger-generation-completion:user:${tag}:message-claim:${receiptScopeDigest}`;
    const scopeRegistryKey = `messenger-generation-completion:user:${tag}:epoch:${oldScope.privacyEpoch}:receipt-scopes`;
    const redis = await getRedisClient();
    await expect(redis.exists(receiptKey)).resolves.toBe(1);
    await expect(redis.exists(claimKey)).resolves.toBe(1);
    await expect(redis.smembers(scopeRegistryKey)).resolves.toContain(
      receiptScopeDigest
    );

    await deleteMessengerGenerationCompletionsForUser(
      currentScope.userKey,
      currentScope
    );

    await expect(redis.exists(receiptKey)).resolves.toBe(0);
    await expect(redis.exists(claimKey)).resolves.toBe(0);
    await expect(redis.exists(scopeRegistryKey)).resolves.toBe(0);
    await expect(
      getMessengerGenerationCompletion(reqId, oldScope)
    ).resolves.toBeNull();
  });

  it("retains malformed indexed metadata through a receipt and erases it", async () => {
    const scope = malformedReceiptFence;
    const subjectDigest = createHash("sha256")
      .update(String(scope.workspaceId))
      .update("\0")
      .update(String(scope.channelConnectionId))
      .update("\0")
      .update(scope.userKey)
      .digest("hex");
    const tag = `{mgc:${subjectDigest}}`;
    const malformedKey = `messenger-generation-completion:${tag}:malformed:${run}`;
    const epochIndexKey = `messenger-generation-completion:user:${tag}:epoch:${scope.privacyEpoch}:index`;
    const redis = await getRedisClient();
    await redis.set(malformedKey, "{not-json");
    await redis.sadd(epochIndexKey, malformedKey);

    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        [`mid-malformed-index-${run}`],
        scope
      )
    ).resolves.toEqual([]);
    await expect(redis.sismember(epochIndexKey, malformedKey)).resolves.toBe(1);

    await deleteMessengerGenerationCompletionsForUser(scope.userKey, scope);

    await expect(redis.exists(malformedKey)).resolves.toBe(0);
    await expect(redis.exists(epochIndexKey)).resolves.toBe(0);
  });

  it("refreshes a pending quota snapshot without moving its commit time", async () => {
    const scope = quotaFence;
    const reqId = `req-quota-refresh-${run}`;
    const imageUrl = "https://assets.example/quota-refresh.jpg";
    const committedAt = Date.now();
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      scope.userKey,
      committedAt - 1,
      scope
    );
    await markMessengerGenerationQuotaCommitted(
      reqId,
      imageUrl,
      scope.userKey,
      {
        daily: { used: 1, limit: 5, remaining: 4 },
        monthly: { used: 1, limit: 20, remaining: 19 },
      },
      committedAt,
      scope
    );
    await markMessengerGenerationQuotaCommitted(
      reqId,
      imageUrl,
      scope.userKey,
      {
        daily: { used: 2, limit: 5, remaining: 3 },
        monthly: { used: 2, limit: 20, remaining: 18 },
      },
      committedAt + 100,
      scope
    );

    await expect(
      getMessengerGenerationCompletion(reqId, scope)
    ).resolves.toMatchObject({
      quotaCommittedAt: committedAt,
      quotaStatus: {
        daily: { used: 2, remaining: 3 },
        monthly: { used: 2, remaining: 18 },
      },
      successNoticeStatus: "pending",
    });
  });

  it("keeps a reactivated epoch intact when an older erasure retry finishes late", async () => {
    const first = {
      ...fence("a"),
      userKey: `redis-completion-erasure-race-${run}`,
    };
    const reactivated = {
      ...first,
      privacyEpoch: first.privacyEpoch + 1,
    };
    const oldReqId = `req-erasure-race-old-${run}`;
    const newReqId = `req-erasure-race-new-${run}`;
    const oldGeneratedKey = "generated/images/erasure-race-old.jpg";
    const oldSourceKey = `inbound-source/erasure-race-old-${run}.jpg`;
    const newGeneratedKey = "generated/images/erasure-race-new.jpg";
    const newSourceKey = `inbound-source/erasure-race-new-${run}.jpg`;

    await markMessengerGenerationCompleted(
      oldReqId,
      "https://assets.example/erasure-race-old.jpg",
      first.userKey,
      Date.now(),
      first
    );
    await registerMessengerObjectForPrivacyCleanup(oldSourceKey, first);

    let signalFirstDeleteStarted: (() => void) | undefined;
    const firstDeleteStarted = new Promise<void>(resolve => {
      signalFirstDeleteStarted = resolve;
    });
    let resumeFirstDelete: (() => void) | undefined;
    const firstDeletePaused = new Promise<void>(resolve => {
      resumeFirstDelete = resolve;
    });
    storageDeleteMock.mockImplementationOnce(async () => {
      signalFirstDeleteStarted?.();
      await firstDeletePaused;
    });

    // A has taken its old-epoch snapshot, then pauses on the first object.
    const erasureA = deleteMessengerGenerationCompletionsForUser(
      first.userKey,
      first
    );
    await firstDeleteStarted;

    // Retry B completes the same erasure while A is still paused.
    await deleteMessengerGenerationCompletionsForUser(first.userKey, first);

    // The user then starts again under a strictly newer privacy epoch.
    await markMessengerGenerationCompleted(
      newReqId,
      "https://assets.example/erasure-race-new.jpg",
      reactivated.userKey,
      Date.now(),
      reactivated
    );
    await registerMessengerObjectForPrivacyCleanup(newSourceKey, reactivated);

    resumeFirstDelete?.();
    await erasureA;

    await expect(
      getMessengerGenerationCompletion(newReqId, reactivated)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/erasure-race-new.jpg",
      privacyEpoch: reactivated.privacyEpoch,
    });
    expect(storageDeleteMock).toHaveBeenCalledWith(oldGeneratedKey);
    expect(storageDeleteMock).toHaveBeenCalledWith(oldSourceKey);
    expect(storageDeleteMock).not.toHaveBeenCalledWith(newGeneratedKey);
    expect(storageDeleteMock).not.toHaveBeenCalledWith(newSourceKey);

    // A later erasure of the new epoch proves its object inventory survived A.
    storageDeleteMock.mockClear();
    await deleteMessengerGenerationCompletionsForUser(
      reactivated.userKey,
      reactivated
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(newGeneratedKey);
    expect(storageDeleteMock).toHaveBeenCalledWith(newSourceKey);
  });

  it("erases every indexed privacy epoch up to the requested epoch", async () => {
    const older = {
      ...fence("a"),
      userKey: `redis-completion-older-epochs-${run}`,
      privacyEpoch: 4,
    };
    const current = { ...older, privacyEpoch: 6 };
    const olderSourceKey = `inbound-source/older-epoch-${run}.jpg`;
    const currentSourceKey = `inbound-source/current-epoch-${run}.jpg`;

    await markMessengerGenerationCompleted(
      `req-older-epoch-${run}`,
      "https://assets.example/older-epoch.jpg",
      older.userKey,
      Date.now(),
      older
    );
    await registerMessengerObjectForPrivacyCleanup(olderSourceKey, older);
    await markMessengerGenerationCompleted(
      `req-current-epoch-${run}`,
      "https://assets.example/current-epoch.jpg",
      current.userKey,
      Date.now(),
      current
    );
    await registerMessengerObjectForPrivacyCleanup(currentSourceKey, current);

    await deleteMessengerGenerationCompletionsForUser(current.userKey, current);

    await expect(
      getMessengerGenerationCompletion(`req-older-epoch-${run}`, older)
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(`req-current-epoch-${run}`, current)
    ).resolves.toBeNull();
    expect(storageDeleteMock).toHaveBeenCalledWith(olderSourceKey);
    expect(storageDeleteMock).toHaveBeenCalledWith(currentSourceKey);
  });

  it("erases a pre-PUT generated key without completion and never sweeps reactivated E7", async () => {
    const dataEpoch = {
      ...fence("a"),
      userKey: createHash("sha256")
        .update(`redis-pre-put-generated-${run}`)
        .digest("hex"),
      privacyEpoch: 5,
    };
    // E6 is the erasing control epoch; newly admitted customer data starts at
    // E7 and must not enter the older E5 snapshot.
    const reactivatedE7 = { ...dataEpoch, privacyEpoch: 7 };
    const oldGeneratedKey = `generated/images/v1/workspace-42001/connection-701/binding-3/privacy-5/user-${dataEpoch.userKey}/1787461200000-123e4567-e89b-42d3-a456-426614174000.png`;
    const newGeneratedKey = oldGeneratedKey
      .replace("privacy-5", "privacy-7")
      .replace("1787461200000", "1787461200001");

    // This is the generated-image crash window: inventory exists before PUT,
    // while no completion record exists yet.
    await expect(
      registerMessengerObjectForPrivacyCleanup(oldGeneratedKey, dataEpoch)
    ).resolves.toBe(true);

    let signalDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>(resolve => {
      signalDeleteStarted = resolve;
    });
    let resumeDelete: (() => void) | undefined;
    const deletePaused = new Promise<void>(resolve => {
      resumeDelete = resolve;
    });
    storageDeleteMock.mockImplementationOnce(async key => {
      expect(key).toBe(oldGeneratedKey);
      signalDeleteStarted?.();
      await deletePaused;
    });

    const oldErasure = deleteMessengerGenerationCompletionsForUser(
      dataEpoch.userKey,
      dataEpoch
    );
    await deleteStarted;
    await expect(
      registerMessengerObjectForPrivacyCleanup(newGeneratedKey, reactivatedE7)
    ).resolves.toBe(true);
    resumeDelete?.();
    await oldErasure;

    expect(storageDeleteMock).toHaveBeenCalledWith(oldGeneratedKey);
    expect(storageDeleteMock).not.toHaveBeenCalledWith(newGeneratedKey);

    storageDeleteMock.mockClear();
    await deleteMessengerGenerationCompletionsForUser(
      reactivatedE7.userKey,
      reactivatedE7
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(newGeneratedKey);
  });

  it("scrubs the shared pre-epoch completion and object indexes", async () => {
    const legacyFence = {
      ...fence("a"),
      userKey: `redis-completion-legacy-${run}`,
    };
    const subjectDigest = createHash("sha256")
      .update(String(legacyFence.workspaceId))
      .update("\0")
      .update(String(legacyFence.channelConnectionId))
      .update("\0")
      .update(legacyFence.userKey)
      .digest("hex");
    const tag = `{mgc:${subjectDigest}}`;
    const completionKey = `messenger-generation-completion:${tag}:legacy-${run}`;
    const higherCompletionKey = `${completionKey}-higher`;
    const completionIndex = `messenger-generation-completion:user:${tag}:index`;
    const objectIndex = `messenger-generation-completion:user:${tag}:objects`;
    const sourceKey = `inbound-source/legacy-${run}.jpg`;
    const higherGeneratedKey = "generated/images/legacy-higher.jpg";
    const higherFence = {
      ...legacyFence,
      privacyEpoch: legacyFence.privacyEpoch + 1,
    };
    const redis = await getRedisClient();
    await redis.set(
      completionKey,
      JSON.stringify({
        reqId: `req-legacy-${run}`,
        imageUrl: "https://assets.example/legacy.jpg",
        completedAt: Date.now(),
        ...legacyFence,
      }),
      "EX",
      60
    );
    await redis.set(
      higherCompletionKey,
      JSON.stringify({
        reqId: `req-legacy-higher-${run}`,
        imageUrl: "https://assets.example/legacy-higher.jpg",
        completedAt: Date.now(),
        ...higherFence,
      }),
      "EX",
      60
    );
    await redis.sadd(completionIndex, completionKey);
    await redis.sadd(completionIndex, higherCompletionKey);
    await redis.sadd(objectIndex, sourceKey);
    await redis.sadd(objectIndex, higherGeneratedKey);

    await deleteMessengerGenerationCompletionsForUser(
      legacyFence.userKey,
      { ...legacyFence, channel: "whatsapp" },
      { includeLegacyUnqualifiedWhatsAppIndexes: true }
    );

    await expect(redis.get(completionKey)).resolves.toBeNull();
    await expect(redis.get(higherCompletionKey)).resolves.not.toBeNull();
    await expect(redis.smembers(completionIndex)).resolves.toEqual([
      higherCompletionKey,
    ]);
    await expect(redis.smembers(objectIndex)).resolves.toEqual([
      higherGeneratedKey,
    ]);
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/legacy.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(sourceKey);
    expect(storageDeleteMock).not.toHaveBeenCalledWith(higherGeneratedKey);

    storageDeleteMock.mockClear();
    await deleteMessengerGenerationCompletionsForUser(
      higherFence.userKey,
      higherFence
    );
    await expect(redis.get(higherCompletionKey)).resolves.toBeNull();
    await expect(redis.smembers(completionIndex)).resolves.toEqual([]);
    await expect(redis.smembers(objectIndex)).resolves.toEqual([]);
    expect(storageDeleteMock).toHaveBeenCalledWith(higherGeneratedKey);
  });

  it("scrubs current and legacy WhatsApp epoch indexes without touching another scope", async () => {
    const currentFence: MessengerGenerationCompletionFence = {
      ...fence("a"),
      userKey: createHash("sha256")
        .update(`redis-completion-whatsapp-bridge-${run}`)
        .digest("hex"),
      channel: "whatsapp",
    };
    const legacyFence: MessengerGenerationCompletionFence = {
      ...currentFence,
      channel: undefined,
    };
    const foreignFence: MessengerGenerationCompletionFence = {
      ...currentFence,
      workspaceId: currentFence.workspaceId + 1,
      channelConnectionId: currentFence.channelConnectionId + 100,
      pageId: "foreign-facebook-page",
      channel: "facebook_messenger",
    };
    const currentObjectKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: currentFence,
      fileName: "1771000000100-00000000-0000-4000-8000-000000000100.jpg",
    });
    const legacyObjectKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: legacyFence,
      fileName: "1771000000101-00000000-0000-4000-8000-000000000101.jpg",
    });
    const foreignObjectKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: foreignFence,
      fileName: "1771000000102-00000000-0000-4000-8000-000000000102.jpg",
    });

    await markMessengerGenerationCompleted(
      `req-whatsapp-current-${run}`,
      `https://assets.example/${currentObjectKey}`,
      currentFence.userKey,
      Date.now(),
      currentFence
    );
    await markMessengerGenerationCompleted(
      `req-whatsapp-legacy-${run}`,
      `https://assets.example/${legacyObjectKey}`,
      legacyFence.userKey,
      Date.now(),
      legacyFence
    );
    await markMessengerGenerationCompleted(
      `req-facebook-foreign-${run}`,
      `https://assets.example/${foreignObjectKey}`,
      foreignFence.userKey,
      Date.now(),
      foreignFence
    );
    await Promise.all([
      registerMessengerObjectForPrivacyCleanup(currentObjectKey, currentFence),
      registerMessengerObjectForPrivacyCleanup(legacyObjectKey, legacyFence),
      registerMessengerObjectForPrivacyCleanup(foreignObjectKey, foreignFence),
    ]);

    storageDeleteMock.mockClear();
    await deleteMessengerGenerationCompletionsForUser(
      currentFence.userKey,
      currentFence,
      { includeLegacyUnqualifiedWhatsAppIndexes: true }
    );

    await expect(
      getMessengerGenerationCompletion(
        `req-whatsapp-current-${run}`,
        currentFence
      )
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(
        `req-whatsapp-legacy-${run}`,
        legacyFence
      )
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(
        `req-facebook-foreign-${run}`,
        foreignFence
      )
    ).resolves.toEqual(
      expect.objectContaining({ reqId: `req-facebook-foreign-${run}` })
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(currentObjectKey);
    expect(storageDeleteMock).toHaveBeenCalledWith(legacyObjectKey);
    expect(storageDeleteMock).not.toHaveBeenCalledWith(foreignObjectKey);

    await deleteMessengerGenerationCompletionsForUser(
      foreignFence.userKey,
      foreignFence
    );
  });
});
