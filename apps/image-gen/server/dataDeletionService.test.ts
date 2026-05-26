import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteUserData } from "./_core/dataDeletionService";
import { anonymizePsid, getOrCreateState, resetStateStore } from "./_core/messengerState";
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
});
