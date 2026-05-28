import {
  readScopedState,
  writeScopedState,
  type MaybePromise,
} from "./stateStore";

const GENERATION_COMPLETION_SCOPE = "messenger-generation-completion";
const GENERATION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type MessengerGenerationCompletion = {
  reqId: string;
  imageUrl: string;
  completedAt: number;
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
  now = Date.now()
): MaybePromise<void> {
  return writeScopedState<MessengerGenerationCompletion>(
    GENERATION_COMPLETION_SCOPE,
    reqId,
    {
      reqId,
      imageUrl,
      completedAt: now,
    },
    GENERATION_COMPLETION_TTL_SECONDS
  );
}
