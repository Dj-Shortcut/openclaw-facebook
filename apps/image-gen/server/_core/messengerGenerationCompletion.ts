import {
  deleteScopedState,
  readScopedState,
  writeScopedState,
  type MaybePromise,
} from "./stateStore";

const GENERATION_COMPLETION_SCOPE = "messenger-generation-completion";
const GENERATION_COMPLETION_USER_INDEX_SCOPE =
  "messenger-generation-completion:user";
const GENERATION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type MessengerGenerationCompletion = {
  reqId: string;
  imageUrl: string;
  completedAt: number;
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

export function markMessengerGenerationCompleted(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now()
): Promise<void> {
  return Promise.resolve(
    writeScopedState<MessengerGenerationCompletion>(
      GENERATION_COMPLETION_SCOPE,
      reqId,
      {
        reqId,
        imageUrl,
        completedAt: now,
        userKey,
      },
      GENERATION_COMPLETION_TTL_SECONDS
    )
  ).then(async () => {
    if (!userKey) {
      return;
    }

    const currentIndex =
      (await Promise.resolve(
        readScopedState<string[]>(
          GENERATION_COMPLETION_USER_INDEX_SCOPE,
          userKey
        )
      )) ?? [];
    const nextIndex = Array.from(new Set([...currentIndex, reqId]));
    await Promise.resolve(
      writeScopedState(
        GENERATION_COMPLETION_USER_INDEX_SCOPE,
        userKey,
        nextIndex,
        GENERATION_COMPLETION_TTL_SECONDS
      )
    );
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
