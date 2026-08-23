import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  getOrCreateState,
  getState,
  setConsentState,
  setLastGenerationContext,
} from "./_core/messengerState";
import {
  runWithMessengerRequestContext,
  setMessengerRequestErasurePrivacySubject,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  beginMessengerStatePrivacyErasure,
  deletePersistedStateForErasure,
  getPersistedStateForErasure,
} from "./_core/messengerStatePersistence";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const runRedis = process.env.RUN_REDIS_INTEGRATION === "1";
const suite = runRedis ? describe : describe.skip;

suite("Messenger state Redis privacy fence", () => {
  const originalPepper = process.env.PRIVACY_PEPPER;

  beforeEach(async () => {
    process.env.PRIVACY_PEPPER = "state-privacy-redis-test-pepper";
    resetRedisClientForTests();
    const redis = await getRedisClient();
    await redis.flushdb();
  });

  afterAll(() => {
    resetRedisClientForTests();
    if (originalPepper === undefined) delete process.env.PRIVACY_PEPPER;
    else process.env.PRIVACY_PEPPER = originalPepper;
  });

  it("atomically rejects stale state writes after the subject is erased", async () => {
    const psid = "state-privacy-user-a";
    const userKey = await withFence(psid, 42, 7, 3, 5, async () => {
      const state = await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentState(psid, true));
      return state.userKey;
    });

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey,
    });

    await expect(
      withFence(psid, 42, 7, 3, 5, async () => {
        await Promise.resolve(
          setLastGenerationContext(
            psid,
            { prompt: "must-not-survive" },
            Date.now()
          )
        );
      })
    ).rejects.toThrow("subject is erased");

    await expect(
      withFence(psid, 42, 7, 3, 5, async () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();

    await expect(
      withFence(psid, 42, 7, 3, 5, async () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toEqual(
      expect.objectContaining({
        userKey,
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
      })
    );
  });

  it("does not tombstone the same user key in another tenant scope", async () => {
    const psid = "state-privacy-shared-user";
    const first = await withFence(psid, 42, 7, 3, 1, async () =>
      Promise.resolve(getOrCreateState(psid))
    );
    await withFence(psid, 84, 9, 1, 1, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentState(psid, true));
    });

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 2,
      userKey: first.userKey,
    });

    await expect(
      withFence(psid, 84, 9, 1, 1, async () => {
        await Promise.resolve(
          setLastGenerationContext(
            psid,
            { prompt: "tenant-b-survives" },
            Date.now()
          )
        );
        return await Promise.resolve(getState(psid));
      })
    ).resolves.toEqual(
      expect.objectContaining({ lastPrompt: "tenant-b-survives" })
    );
  });

  it("lets an erasing epoch scrub only its immediately preceding data epoch", async () => {
    const psid = "state-privacy-erasure-retry";
    const oldState = await withFence(psid, 42, 7, 3, 5, async () => {
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "old-private-state" })
      );
      return await Promise.resolve(getState(psid));
    });
    expect(oldState).toEqual(expect.objectContaining({ privacyEpoch: 5 }));

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey: oldState!.userKey,
    });

    await expect(
      withErasureFence(psid, 42, 7, 3, 6, 5, async () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toEqual(
      expect.objectContaining({
        lastPrompt: "old-private-state",
        privacyEpoch: 5,
      })
    );

    await withFence(psid, 42, 7, 3, 7, async () => {
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "reactivated-private-state" })
      );
    });

    await withErasureFence(psid, 42, 7, 3, 6, 5, async () => {
      await Promise.resolve(deletePersistedStateForErasure(psid, oldState!));
    });

    await expect(
      withFence(psid, 42, 7, 3, 7, async () => Promise.resolve(getState(psid)))
    ).resolves.toEqual(
      expect.objectContaining({
        lastPrompt: "reactivated-private-state",
        privacyEpoch: 7,
      })
    );
  });
});

async function withFence<T>(
  psid: string,
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number,
  action: () => Promise<T>
): Promise<T> {
  return runWithMessengerRequestContext(
    `page-${workspaceId}`,
    async () => {
      const state = await Promise.resolve(getOrCreateStateForUserKey(psid));
      setMessengerRequestPrivacySubject({
        userKey: state.userKey,
        privacyEpoch,
      });
      return action();
    },
    { workspaceId, channelConnectionId, bindingEpoch }
  );
}

async function withErasureFence<T>(
  psid: string,
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number,
  dataPrivacyEpoch: number,
  action: () => Promise<T>
): Promise<T> {
  return runWithMessengerRequestContext(
    `page-${workspaceId}`,
    async () => {
      const { toUserKey } = await import("./_core/privacy");
      setMessengerRequestErasurePrivacySubject({
        userKey: toUserKey(psid),
        privacyEpoch,
        dataPrivacyEpoch,
      });
      return action();
    },
    { workspaceId, channelConnectionId, bindingEpoch }
  );
}

async function getOrCreateStateForUserKey(psid: string) {
  // The first state call needs the privacy subject in request context. Derive
  // the same privacy-safe key without persisting any raw identifier.
  const { toUserKey } = await import("./_core/privacy");
  const userKey = toUserKey(psid);
  setMessengerRequestPrivacySubject({ userKey, privacyEpoch: 1 });
  return { userKey };
}
