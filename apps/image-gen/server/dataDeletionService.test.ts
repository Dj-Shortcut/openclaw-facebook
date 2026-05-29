import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storageDeleteMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    storageDelete: storageDeleteMock,
  };
});
import { deleteUserData } from "./_core/dataDeletionService";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./_core/messengerGenerationCompletion";
import {
  anonymizePsid,
  getOrCreateState,
  getState,
  resetStateStore,
  setPendingImage,
} from "./_core/messengerState";
import { readScopedState, writeScopedState } from "./_core/stateStore";

describe("data deletion service", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    process.env.PRIVACY_PEPPER = "data-deletion-test-pepper";
    resetStateStore();
  });

  afterEach(() => {
    resetStateStore();
    storageDeleteMock.mockReset();
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }

    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("deletes legacy Messenger chat history during user erasure", async () => {
    const psid = "delete-chat-history-user";
    const userKey = anonymizePsid(psid);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(
      writeScopedState(
        "chat:history",
        userKey,
        [{ role: "user", text: "old chat", ts: Date.now() }],
        60
      )
    );

    expect(await Promise.resolve(readScopedState("chat:history", userKey))).toEqual([
      expect.objectContaining({ text: "old chat" }),
    ]);

    await deleteUserData(psid);

    expect(await Promise.resolve(readScopedState("chat:history", userKey))).toBeNull();
  });

  it("deletes Messenger generation completion markers during user erasure", async () => {
    const psid = "delete-generation-completion-user";
    const userKey = anonymizePsid(psid);

    await Promise.resolve(getOrCreateState(psid));
    await markMessengerGenerationCompleted(
      "req-delete-completion",
      "https://assets.example/generated/delete-completion.jpg",
      userKey,
      1_771_000_000_000
    );

    expect(
      await Promise.resolve(
        getMessengerGenerationCompletion("req-delete-completion")
      )
    ).toEqual(expect.objectContaining({ userKey }));

    await deleteUserData(psid);

    expect(
      await Promise.resolve(
        getMessengerGenerationCompletion("req-delete-completion")
      )
    ).toBeNull();
  });

  it("keeps a pending deletion marker when object storage deletion fails", async () => {
    const psid = "delete-storage-failure-user";
    storageDeleteMock.mockRejectedValueOnce(new Error("delete failed"));

    await Promise.resolve(
      setPendingImage(
        psid,
        "https://assets.example/inbound-source/delete-me.jpg",
        Date.now(),
        "stored"
      )
    );

    await deleteUserData(psid);

    expect((await Promise.resolve(getState(psid)))?.pendingSourceImageDeleteUrl).toBe(
      "https://assets.example/inbound-source/delete-me.jpg"
    );
  });
});
