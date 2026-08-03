import { createHash } from "node:crypto";
import {
  deleteState,
  getOrCreateStoredState,
  isPromiseLike,
  isRedisStateStoreEnabled,
  readState,
  updateStoredState,
  writeState,
  type MaybePromise,
} from "./stateStore";
import {
  createDefaultState,
  normalizeState,
} from "./messengerStateNormalization";
import type { MessengerUserState } from "./messengerState";
import { getMessengerRequestPageId } from "./messengerRequestContext";

type PartialState = Partial<MessengerUserState>;
const MESSENGER_PAGE_STATE_KEY_PREFIX = "messenger-page-v2";

/**
 * Page-context state owns all customer content for that Page + sender pair.
 * The digest keeps raw Page ids and PSIDs out of Redis keys. A missing Page
 * context deliberately stays on the isolated legacy key for non-Messenger and
 * migration-only callers; Page reads never fall back to that unowned record.
 */
function getPersistedStateKey(psid: string): string {
  const pageId = getMessengerRequestPageId();
  if (!pageId) {
    return psid;
  }

  const digest = createHash("sha256")
    .update(pageId, "utf8")
    .update("\0", "utf8")
    .update(psid, "utf8")
    .digest("hex");
  return `${MESSENGER_PAGE_STATE_KEY_PREFIX}:${digest}`;
}

function saveState(
  psid: string,
  nextState: MessengerUserState
): MaybePromise<MessengerUserState> {
  const result = writeState(getPersistedStateKey(psid), nextState);
  if (isPromiseLike(result)) {
    return result.then(() => nextState);
  }

  return nextState;
}

function getStateFromMemory(psid: string): MessengerUserState | null {
  const direct = readState<PartialState>(getPersistedStateKey(psid));
  if (isPromiseLike(direct)) {
    throw new Error("Unexpected async state read in memory mode");
  }

  return direct ? normalizeState(psid, direct) : null;
}

function getStateFromRedis(psid: string): Promise<MessengerUserState | null> {
  return Promise.resolve(
    readState<PartialState>(getPersistedStateKey(psid))
  ).then(state => {
    return state ? normalizeState(psid, state) : null;
  });
}

export function getPersistedState(
  psid: string
): MaybePromise<MessengerUserState | null> {
  if (!isRedisStateStoreEnabled()) {
    return getStateFromMemory(psid);
  }

  return getStateFromRedis(psid);
}

export function getOrCreatePersistedState(
  psid: string
): MaybePromise<MessengerUserState> {
  if (!isRedisStateStoreEnabled()) {
    const state = getStateFromMemory(psid);
    if (state) {
      return state;
    }

    const createdState = createDefaultState(psid);
    return saveState(psid, createdState);
  }

  return Promise.resolve(
    getOrCreateStoredState(getPersistedStateKey(psid), () =>
      createDefaultState(psid)
    )
  ).then(state => normalizeState(psid, state));
}

function patchStateInMemory(
  psid: string,
  patch: PartialState,
  now = Date.now()
): MessengerUserState {
  const current = getStateFromMemory(psid) ?? createDefaultState(psid);

  const nextState = normalizeState(psid, {
    ...current,
    ...patch,
    updatedAt: now,
  });

  const saved = saveState(psid, nextState);
  if (isPromiseLike(saved)) {
    throw new Error("Unexpected async state save in memory mode");
  }

  return saved;
}

function patchStateInRedis(
  psid: string,
  patch: PartialState,
  now = Date.now()
): Promise<MessengerUserState> {
  return Promise.resolve(
    updateStoredState<PartialState>(
      getPersistedStateKey(psid),
      current =>
        normalizeState(psid, {
          ...normalizeState(psid, current),
          ...patch,
          updatedAt: now,
        })
    )
  ).then(state => normalizeState(psid, state));
}

export function patchState(
  psid: string,
  patch: PartialState,
  now = Date.now()
): MaybePromise<MessengerUserState> {
  if (!isRedisStateStoreEnabled()) {
    return patchStateInMemory(psid, patch, now);
  }

  return patchStateInRedis(psid, patch, now);
}

export function deletePersistedState(psid: string): MaybePromise<void> {
  return deleteState(getPersistedStateKey(psid));
}

/** Replaces only the state owned by the active Page + sender context. */
export function replacePersistedState(
  psid: string,
  state: PartialState
): MaybePromise<void> {
  return writeState(getPersistedStateKey(psid), state);
}

/** Deletes a pre-Page-scope legacy key regardless of the active Page context. */
export function deleteLegacyPersistedState(psid: string): MaybePromise<void> {
  return deleteState(psid);
}
