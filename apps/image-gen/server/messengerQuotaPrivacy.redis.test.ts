import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  commitImageGenerationSuccess,
  deleteMessengerQuotaReservationsForErasure,
  reserveImageGenerationForAttempt,
} from "./_core/messengerQuota";
import {
  clearUserState,
  getState,
  resetStateStore,
} from "./_core/messengerState";
import {
  beginMessengerStatePrivacyErasure,
  deleteLegacyMessengerQuotaShadow,
  deleteLegacyPersistedState,
  getMessengerStateOperationKey,
  mutatePersistedState,
} from "./_core/messengerStatePersistence";
import { toUserKey } from "./_core/privacy";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";
import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { writeState } from "./_core/stateStore";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const originalDailyLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;

suite("Messenger quota Redis privacy fence", () => {
  beforeAll(() => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/13";
    process.env.PRIVACY_PEPPER = "messenger-quota-redis-privacy-pepper";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "2";
    resetRedisClientForTests();
  });

  beforeEach(async () => {
    resetStateStore();
    const redis = await getRedisClient();
    await redis.eval("return redis.call('FLUSHDB')", 0);
  });

  afterAll(() => {
    resetStateStore();
    resetRedisClientForTests();
    restoreEnv("REDIS_URL", originalRedisUrl);
    restoreEnv("PRIVACY_PEPPER", originalPrivacyPepper);
    restoreEnv("MESSENGER_FREE_DAILY_LIMIT", originalDailyLimit);
  });

  it("atomically isolates reservation and commit state across tenant scopes without a raw PSID shadow", async () => {
    const psid = "redis-quota-same-sender";
    const userKey = toUserKey(psid);
    const tenantA = scope("page-a", 101, 11, 3, 5);
    const tenantB = scope("page-b", 202, 22, 7, 9);

    const [aResults, bResults] = await Promise.all([
      withFence(psid, tenantA, () =>
        Promise.all([
          reserveImageGenerationForAttempt(psid),
          reserveImageGenerationForAttempt(psid),
        ])
      ),
      withFence(psid, tenantB, () =>
        Promise.all([
          reserveImageGenerationForAttempt(psid),
          reserveImageGenerationForAttempt(psid),
        ])
      ),
    ]);
    expect(aResults.filter(Boolean)).toHaveLength(1);
    expect(bResults.filter(Boolean)).toHaveLength(1);
    const reservationA = aResults.find(Boolean)!;
    const reservationB = bResults.find(Boolean)!;

    const duplicateCommits = await withFence(psid, tenantA, () =>
      Promise.all([
        commitImageGenerationSuccess(psid, reservationA),
        commitImageGenerationSuccess(psid, reservationA),
      ])
    );
    expect(duplicateCommits.filter(Boolean)).toHaveLength(1);
    await expect(
      withFence(psid, tenantB, () =>
        commitImageGenerationSuccess(psid, reservationB)
      )
    ).resolves.toBe(true);

    await expect(
      withFence(psid, tenantA, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({ workspaceId: 101, quota: { count: 1 } });
    await expect(
      withFence(psid, tenantB, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({ workspaceId: 202, quota: { count: 1 } });

    const redis = await getRedisClient();
    await expect(redis.get(`psid:${psid}`)).resolves.toBeNull();
    await expect(redis.get(`psid:${userKey}`)).resolves.toBeNull();
    for (const key of await scanAllKeys()) {
      expect(key).not.toContain(psid);
    }
  });

  it("erases only the exact scoped state, quota lock, and proven legacy shadows", async () => {
    const psid = "redis-quota-erasure-sender";
    const otherPsid = "redis-quota-erasure-other-sender";
    const userKey = toUserKey(psid);
    const tenantA = scope("page-a", 301, 31, 4, 6);
    const tenantB = scope("page-b", 302, 32, 8, 6);

    const reservationA = await withFence(psid, tenantA, () =>
      reserveImageGenerationForAttempt(psid)
    );
    const reservationB = await withFence(psid, tenantB, () =>
      reserveImageGenerationForAttempt(psid)
    );
    expect(reservationA).not.toBeNull();
    expect(reservationB).not.toBeNull();

    const stateA = await withFence(psid, tenantA, () =>
      Promise.resolve(getState(psid))
    );
    const lockA = await withFence(psid, tenantA, async () =>
      getMessengerStateOperationKey(psid, "quota:image-generation")
    );
    const lockB = await withFence(psid, tenantB, async () =>
      getMessengerStateOperationKey(psid, "quota:image-generation")
    );
    expect(stateA).not.toBeNull();
    expect(lockA).not.toBe(lockB);

    // Reproduce both historical shadows. Erasure may remove the raw-PSID
    // quota record only when its complete ownership tuple matches stateA.
    await Promise.resolve(writeState(psid, stateA!));
    await Promise.resolve(writeState(userKey, stateA!));

    const redis = await getRedisClient();
    const legacyQuotaKeys = [
      `messenger:transcription-quota:${psid}`,
      `messenger:image-generation-quota:${psid}`,
      `messenger:video-generation-quota:${psid}`,
    ];
    const otherLegacyQuotaKeys = [
      `messenger:transcription-quota:${otherPsid}`,
      `messenger:image-generation-quota:${otherPsid}`,
      `messenger:video-generation-quota:${otherPsid}`,
    ];
    await Promise.all([
      ...legacyQuotaKeys.map(key => redis.set(key, "legacy-target-lock")),
      ...otherLegacyQuotaKeys.map(key => redis.set(key, "legacy-other-lock")),
    ]);
    await expect(redis.get(lockA)).resolves.toBe(reservationA!.token);
    await expect(redis.get(lockB)).resolves.toBe(reservationB!.token);

    await withFence(psid, tenantA, async () => {
      await beginMessengerStatePrivacyErasure({
        workspaceId: tenantA.workspaceId,
        channelConnectionId: tenantA.channelConnectionId,
        bindingEpoch: tenantA.bindingEpoch,
        privacyEpoch: tenantA.privacyEpoch + 1,
        userKey,
      });
      await expect(
        deleteLegacyMessengerQuotaShadow(psid, stateA!)
      ).resolves.toBe("deleted");
      await Promise.resolve(deleteLegacyPersistedState(userKey));
      await deleteMessengerQuotaReservationsForErasure(psid);
      await Promise.resolve(clearUserState(psid));
    });

    await expect(redis.get(lockA)).resolves.toBeNull();
    for (const key of legacyQuotaKeys) {
      await expect(redis.get(key)).resolves.toBeNull();
    }
    for (const key of otherLegacyQuotaKeys) {
      await expect(redis.get(key)).resolves.toBe("legacy-other-lock");
    }
    await expect(redis.get(`psid:${psid}`)).resolves.toBeNull();
    await expect(redis.get(`psid:${userKey}`)).resolves.toBeNull();
    await expect(
      withFence(psid, tenantA, () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();

    await expect(redis.get(lockB)).resolves.toBe(reservationB!.token);
    await expect(
      withFence(psid, tenantB, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({
      workspaceId: tenantB.workspaceId,
      imageGenerationQuotaReservation: { token: reservationB!.token },
    });
    await expect(
      withFence(psid, tenantB, () =>
        commitImageGenerationSuccess(psid, reservationB!)
      )
    ).resolves.toBe(true);

    await expect(
      withFence(psid, tenantA, () => reserveImageGenerationForAttempt(psid))
    ).rejects.toThrow("subject is erased");
    await expect(redis.get(lockA)).resolves.toBeNull();
    await expect(
      withFence(psid, tenantB, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({ quota: { count: 1 } });
  });

  it("rejects a mismatched ALS privacy subject before Redis state or lock creation", async () => {
    const psid = "redis-mismatched-privacy-subject";
    const tenant = scope("page-mismatch", 401, 41, 5, 7);

    await expect(
      runWithMessengerRequestContext(
        tenant.pageId,
        async () => {
          setMessengerRequestPrivacySubject({
            userKey: toUserKey("different-sender"),
            privacyEpoch: tenant.privacyEpoch,
          });
          await Promise.resolve(mutatePersistedState(psid, current => current));
        },
        tenant
      )
    ).rejects.toThrow("Messenger state privacy subject does not match sender");

    expect(await scanAllKeys()).toEqual([]);
  });
});

type Scope = ReturnType<typeof scope>;

function scope(
  pageId: string,
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number
) {
  return {
    pageId,
    workspaceId,
    channelConnectionId,
    bindingEpoch,
    privacyEpoch,
  };
}

async function withFence<T>(
  psid: string,
  input: Scope,
  action: () => Promise<T>
): Promise<T> {
  return runWithMessengerRequestContext(
    input.pageId,
    async () => {
      setMessengerRequestPrivacySubject({
        userKey: toUserKey(psid),
        privacyEpoch: input.privacyEpoch,
      });
      return action();
    },
    input
  );
}

async function scanAllKeys(): Promise<string[]> {
  const redis = await getRedisClient();
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "*", "COUNT", 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
