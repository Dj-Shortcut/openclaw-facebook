import { randomUUID } from "node:crypto";
import {
  deleteScopedState,
  deleteEphemeralKeyIfValue,
  readScopedState,
  setEphemeralKeyIfAbsent,
  writeScopedState,
  type MaybePromise,
} from "./stateStore";

const GENERATION_COMPLETION_SCOPE = "messenger-generation-completion";
const GENERATION_COMPLETION_USER_INDEX_SCOPE =
  "messenger-generation-completion:user";
const GENERATION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;
const USER_INDEX_LOCK_TTL_SECONDS = 5;
const USER_INDEX_LOCK_MAX_ATTEMPTS = 20;

export type MessengerGenerationCompletion = {
  reqId: string;
  imageUrl: string;
  completedAt: number;
  deliveredAt?: number;
  userKey?: string;
};

export function getMessengerGenerationCompletion(
  reqId: string
): MaybePromise<MessengerGenerationCompletion | null> {
  return readScopedState<MessengerGenerationCompletion>(
    GENERATION_COMPLETION_SCOPE,
    reqId
  );
}

function userIndexLockKey(userKey: string): string {
  return `lock:${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${userKey}`;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function withUserIndexLock(
  userKey: string,
  action: () => Promise<void>
): Promise<void> {
  const lockKey = userIndexLockKey(userKey);
  const token = randomUUID();

  for (let attempt = 0; attempt < USER_INDEX_LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (await setEphemeralKeyIfAbsent(lockKey, token, USER_INDEX_LOCK_TTL_SECONDS)) {
      try {
        await action();
        return;
      } finally {
        await deleteEphemeralKeyIfValue(lockKey, token);
      }
    }

    await wait(10);
  }

  throw new Error("Timed out waiting for messenger generation completion index lock");
}

export function markMessengerGenerationCompleted(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now()
): Promise<void> {
  return writeMessengerGenerationCompletion({
    reqId,
    imageUrl,
    completedAt: now,
    userKey,
  });
}

export async function markMessengerGenerationDelivered(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now()
): Promise<void> {
  const existing = await Promise.resolve(getMessengerGenerationCompletion(reqId));
  await writeMessengerGenerationCompletion({
    reqId,
    imageUrl,
    completedAt: existing?.completedAt ?? now,
    deliveredAt: now,
    userKey: userKey ?? existing?.userKey,
  });
}

function writeMessengerGenerationCompletion(
  completion: MessengerGenerationCompletion
): Promise<void> {
  return Promise.resolve(
    writeScopedState<MessengerGenerationCompletion>(
      GENERATION_COMPLETION_SCOPE,
      completion.reqId,
      completion,
      GENERATION_COMPLETION_TTL_SECONDS
    )
  ).then(async () => {
    const userKey = completion.userKey;
    if (!userKey) {
      return;
    }

    await withUserIndexLock(userKey, async () => {
      const currentIndex =
        (await Promise.resolve(
          readScopedState<string[]>(
            GENERATION_COMPLETION_USER_INDEX_SCOPE,
            userKey
          )
        )) ?? [];
      const nextIndex = Array.from(new Set([...currentIndex, completion.reqId]));
      await Promise.resolve(
        writeScopedState(
          GENERATION_COMPLETION_USER_INDEX_SCOPE,
          userKey,
          nextIndex,
          GENERATION_COMPLETION_TTL_SECONDS
        )
      );
    });
  });
}

export async function deleteMessengerGenerationCompletionsForUser(
  userKey: string
): Promise<void> {
  const completionReqIds =
    (await Promise.resolve(
      readScopedState<string[]>(
        GENERATION_COMPLETION_USER_INDEX_SCOPE,
        userKey
      )
    )) ?? [];

  await Promise.all(
    completionReqIds.map(reqId =>
      Promise.resolve(deleteScopedState(GENERATION_COMPLETION_SCOPE, reqId))
    )
  );
  await Promise.resolve(
    deleteScopedState(GENERATION_COMPLETION_USER_INDEX_SCOPE, userKey)
  );
}
