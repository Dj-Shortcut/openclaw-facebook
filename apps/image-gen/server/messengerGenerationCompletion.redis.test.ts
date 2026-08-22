import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  storageKeyFromPublicUrl: (url: string) =>
    `generated/${url.split("/").at(-1)}`,
  storageDelete: storageDeleteMock,
}));

import {
  deleteMessengerGenerationCompletionsForUser,
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDelivered,
  runDueMessengerGenerationArtifactCleanup,
  type MessengerGenerationCompletionFence,
} from "./_core/messengerGenerationCompletion";
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

  beforeAll(async () => {
    await (await getRedisClient()).ping();
  });
  afterAll(async () => {
    await Promise.all(
      [fence("a"), fence("b")].map(scope =>
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
      runDueMessengerGenerationArtifactCleanup(Date.now())
    ).resolves.toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/replayed.jpg");
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
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/a.jpg");

    storageDeleteMock.mockClear();
    await expect(
      markMessengerGenerationCompleted(
        `req-after-erase-${run}`,
        "https://assets.example/late-after-erase.jpg",
        first.userKey,
        Date.now(),
        first
      )
    ).rejects.toThrow("subject is erased");
    await expect(
      runDueMessengerGenerationArtifactCleanup(Date.now())
    ).resolves.toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/late-after-erase.jpg"
    );
  });
});
