import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  commitImageGenerationSuccess,
  releaseImageGenerationReservation,
  reserveImageGenerationForAttempt,
} from "./_core/messengerQuota";
import { getState, resetStateStore } from "./_core/messengerState";
import {
  getMessengerStateOperationKey,
  mutatePersistedState,
  replacePersistedState,
} from "./_core/messengerStatePersistence";
import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";
import { readState } from "./_core/stateStore";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("Messenger quota privacy scope", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "messenger-quota-privacy-test-pepper";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "2";
    resetStateStore();
  });

  afterAll(() => {
    resetStateStore();
    delete process.env.MESSENGER_FREE_DAILY_LIMIT;
    if (originalPrivacyPepper === undefined) delete process.env.PRIVACY_PEPPER;
    else process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("isolates the same sender id by Page and workspace without a raw shadow", async () => {
    const psid = "same-sender-across-pages";
    const firstScope = scope(101, 11, 1, 1);
    const secondScope = scope(202, 22, 1, 1);

    const [firstReservation, secondReservation] = await Promise.all([
      withFence(psid, firstScope, () => reserveImageGenerationForAttempt(psid)),
      withFence(psid, secondScope, () =>
        reserveImageGenerationForAttempt(psid)
      ),
    ]);
    expect(firstReservation).not.toBeNull();
    expect(secondReservation).not.toBeNull();

    await withFence(psid, firstScope, () =>
      commitImageGenerationSuccess(psid, firstReservation!)
    );
    await withFence(psid, secondScope, () =>
      commitImageGenerationSuccess(psid, secondReservation!)
    );

    await expect(
      withFence(psid, firstScope, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({ workspaceId: 101, quota: { count: 1 } });
    await expect(
      withFence(psid, secondScope, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({ workspaceId: 202, quota: { count: 1 } });
    expect(await Promise.resolve(readState(psid))).toBeNull();
  });

  it("keeps reserve, commit, and release atomic within one privacy fence", async () => {
    const psid = "quota-cas-user";
    const ownership = scope(303, 33, 4, 7);
    const reservations = await withFence(psid, ownership, () =>
      Promise.all([
        reserveImageGenerationForAttempt(psid),
        reserveImageGenerationForAttempt(psid),
      ])
    );
    const reservation = reservations.find(Boolean);
    expect(reservations.filter(Boolean)).toHaveLength(1);

    const commits = await withFence(psid, ownership, () =>
      Promise.all([
        commitImageGenerationSuccess(psid, reservation!),
        commitImageGenerationSuccess(psid, reservation!),
      ])
    );
    expect(commits.filter(Boolean)).toHaveLength(1);
    await withFence(psid, ownership, () =>
      releaseImageGenerationReservation(psid, reservation!)
    );

    await expect(
      withFence(psid, ownership, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({
      quota: { count: 1 },
      imageGenerationQuotaReservation: null,
    });
    expect(await Promise.resolve(readState(psid))).toBeNull();
  });

  it("rejects a privacy subject that does not match the sender before any fenced state effect", async () => {
    const psid = "mismatched-privacy-subject";
    const ownership = scope(404, 44, 5, 8);

    await runWithMessengerRequestContext(
      `page-${ownership.workspaceId}`,
      async () => {
        setMessengerRequestPrivacySubject({
          userKey: toUserKey("different-sender"),
          privacyEpoch: ownership.privacyEpoch,
        });

        expect(() => getState(psid)).toThrow(
          "Messenger state privacy subject does not match sender"
        );
        expect(() =>
          getMessengerStateOperationKey(psid, "quota:image-generation")
        ).toThrow("Messenger state privacy subject does not match sender");
        expect(() => mutatePersistedState(psid, current => current)).toThrow(
          "Messenger state privacy subject does not match sender"
        );
      },
      ownership
    );

    expect(await Promise.resolve(readState(psid))).toBeNull();
  });

  it("rejects a fenced write whose state user identity differs from the sender", async () => {
    const psid = "mismatched-fenced-state";
    const ownership = scope(505, 55, 6, 9);

    await expect(
      withFence(psid, ownership, async () => {
        const current = await Promise.resolve(
          mutatePersistedState(psid, state => state)
        );
        await Promise.resolve(
          replacePersistedState(psid, {
            ...current,
            userKey: toUserKey("different-sender"),
          })
        );
      })
    ).rejects.toThrow("Messenger state user identity is inconsistent");

    await expect(
      withFence(psid, ownership, () => Promise.resolve(getState(psid)))
    ).resolves.toMatchObject({ userKey: toUserKey(psid) });
  });
});

function scope(
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number
) {
  return { workspaceId, channelConnectionId, bindingEpoch, privacyEpoch };
}

async function withFence<T>(
  psid: string,
  input: ReturnType<typeof scope>,
  action: () => Promise<T>
): Promise<T> {
  return runWithMessengerRequestContext(
    `page-${input.workspaceId}`,
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
