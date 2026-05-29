import {
  findInMemoryState,
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
  getUserKey,
  normalizeState,
} from "./messengerStateNormalization";
import type { MessengerUserState } from "./messengerState";

type PartialState = Partial<MessengerUserState>;

export function saveState(
  psid: string,
  nextState: MessengerUserState
): MaybePromise<MessengerUserState> {
  const result = writeState(psid, nextState);
  if (isPromiseLike(result)) {
    return result.then(() => nextState);
  }

  return nextState;
}

function getStateFromMemory(psid: string): MessengerUserState | null {
  const direct = readState<PartialState>(psid);
  if (isPromiseLike(direct)) {
    throw new Error("Unexpected async state read in memory mode");
  }

  if (direct) {
    return normalizeState(psid, direct);
  }

  const userKey = getUserKey(psid);
  const legacyState = findInMemoryState<PartialState>(
    state => state.userKey === userKey
  );
  return legacyState
    ? normalizeState(legacyState.psid ?? psid, legacyState)
    : null;
}

function getStateFromRedis(psid: string): Promise<MessengerUserState | null> {
  return Promise.resolve(readState<PartialState>(psid)).then(state => {
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
    getOrCreateStoredState(psid, () => createDefaultState(psid))
  ).then(state => {
    return normalizeState(psid, state);
  });
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
    updateStoredState<PartialState>(psid, current => {
      const nextState = normalizeState(psid, {
        ...normalizeState(psid, current),
        ...patch,
        updatedAt: now,
      });
      return nextState;
    })
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
