import { createHash } from "node:crypto";
import {
  deleteState,
  deleteScopedState,
  getOrCreateStoredState,
  isPromiseLike,
  isRedisStateStoreEnabled,
  readState,
  readScopedState,
  updateStoredState,
  writeState,
  writeScopedState,
  type MaybePromise,
} from "./stateStore";
import {
  createDefaultState,
  normalizeState,
} from "./messengerStateNormalization";
import type { MessengerUserState } from "./messengerState";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./messengerRequestContext";

type PartialState = Partial<MessengerUserState>;
const MESSENGER_PAGE_STATE_KEY_PREFIX = "messenger-page-v2";
const MESSENGER_USER_PAGE_INDEX_SCOPE = "messenger-user-page-v1";

type MessengerUserPageIndex = {
  stateKey: string | null;
  userKey: string;
  pageId: string;
  ambiguous: boolean;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  privacyEpoch?: number;
};

export type MessengerStateFence = {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
};

function requestStateFence(): MessengerStateFence | undefined {
  const ownership = getMessengerRequestOwnership();
  const subject = getMessengerRequestPrivacySubject();
  return ownership && subject
    ? { ...ownership, privacyEpoch: subject.privacyEpoch }
    : undefined;
}

/**
 * Page-context state owns all customer content for that Page + sender pair.
 * The digest keeps raw Page ids and PSIDs out of Redis keys. A missing Page
 * context deliberately stays on the isolated legacy key for non-Messenger and
 * migration-only callers; Page reads never fall back to that unowned record.
 */
function getPersistedStateKey(
  psid: string,
  explicitPageId?: string | null,
  explicitFence?: MessengerStateFence
): string {
  const pageId = explicitPageId?.trim() || getMessengerRequestPageId();
  if (!pageId) {
    return psid;
  }

  const fence =
    explicitFence ??
    (!explicitPageId || pageId === getMessengerRequestPageId()
      ? requestStateFence()
      : undefined);
  const scopedOwnership = fence
    ? `${fence.workspaceId}\0${fence.channelConnectionId}\0${fence.bindingEpoch}\0${fence.privacyEpoch}`
    : "legacy-page-scope";
  const digest = createHash("sha256")
    .update(pageId, "utf8")
    .update("\0", "utf8")
    .update(scopedOwnership, "utf8")
    .update("\0", "utf8")
    .update(psid, "utf8")
    .digest("hex");
  return `${MESSENGER_PAGE_STATE_KEY_PREFIX}:${digest}`;
}

function getUserPageIndexKey(
  userKey: string,
  pageId: string,
  fence?: MessengerStateFence
): string {
  return createHash("sha256")
    .update("messenger-user-page-v1", "utf8")
    .update("\0", "utf8")
    .update(pageId, "utf8")
    .update("\0", "utf8")
    .update(userKey, "utf8")
    .update("\0", "utf8")
    .update(
      fence
        ? `${fence.workspaceId}\0${fence.channelConnectionId}\0${fence.bindingEpoch}\0${fence.privacyEpoch}`
        : "legacy-page-scope",
      "utf8"
    )
    .digest("hex");
}

function writeUserPageIndex(
  stateKey: string,
  state: MessengerUserState
): MaybePromise<void> {
  const pageId = state.pageId?.trim();
  if (!pageId || !state.userKey) return;
  const fence =
    state.workspaceId &&
    state.channelConnectionId &&
    state.bindingEpoch &&
    state.privacyEpoch
      ? {
          workspaceId: state.workspaceId,
          channelConnectionId: state.channelConnectionId,
          bindingEpoch: state.bindingEpoch,
          privacyEpoch: state.privacyEpoch,
        }
      : undefined;
  const indexKey = getUserPageIndexKey(state.userKey, pageId, fence);
  const existing = readScopedState<MessengerUserPageIndex>(
    MESSENGER_USER_PAGE_INDEX_SCOPE,
    indexKey
  );
  const write = (current: MessengerUserPageIndex | null) =>
    writeScopedState(MESSENGER_USER_PAGE_INDEX_SCOPE, indexKey, {
      stateKey: current && current.stateKey !== stateKey ? null : stateKey,
      userKey: state.userKey,
      pageId,
      ambiguous: Boolean(current && current.stateKey !== stateKey),
      ...fence,
    } satisfies MessengerUserPageIndex);
  return isPromiseLike(existing)
    ? existing.then(current => Promise.resolve(write(current)))
    : write(existing);
}

function saveState(
  psid: string,
  nextState: MessengerUserState
): MaybePromise<MessengerUserState> {
  const stateKey = getPersistedStateKey(psid, nextState.pageId);
  const result = writeState(stateKey, nextState);
  if (isPromiseLike(result)) {
    return result
      .then(() => Promise.resolve(writeUserPageIndex(stateKey, nextState)))
      .then(() => nextState);
  }

  const indexed = writeUserPageIndex(stateKey, nextState);
  if (isPromiseLike(indexed)) return indexed.then(() => nextState);

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

/** Reads Page-scoped Messenger state without relying on request AsyncLocalStorage. */
export function getPersistedStateForPage(
  psid: string,
  pageId: string,
  fence?: MessengerStateFence
): MaybePromise<MessengerUserState | null> {
  const key = getPersistedStateKey(psid, pageId, fence);
  const normalizeOwnedState = (direct: PartialState | null) => {
    if (!direct) return null;
    const state = normalizeState(psid, direct);
    if (
      fence &&
      (state.workspaceId !== fence.workspaceId ||
        state.channelConnectionId !== fence.channelConnectionId ||
        state.bindingEpoch !== fence.bindingEpoch ||
        state.privacyEpoch !== fence.privacyEpoch)
    ) {
      return null;
    }
    return state;
  };
  if (!isRedisStateStoreEnabled()) {
    const direct = readState<PartialState>(key);
    if (isPromiseLike(direct))
      throw new Error("Unexpected async state read in memory mode");
    return normalizeOwnedState(direct);
  }
  return Promise.resolve(readState<PartialState>(key)).then(
    normalizeOwnedState
  );
}

export async function findPersistedStateByUserKeyForPage(
  userKey: string,
  pageId: string,
  fence?: MessengerStateFence
): Promise<MessengerUserState | null> {
  const normalizedPageId = pageId.trim();
  if (!normalizedPageId || !userKey.trim()) return null;
  const index = await Promise.resolve(
    readScopedState<MessengerUserPageIndex>(
      MESSENGER_USER_PAGE_INDEX_SCOPE,
      getUserPageIndexKey(userKey, normalizedPageId, fence)
    )
  );
  if (
    !index ||
    index.ambiguous ||
    !index.stateKey ||
    index.userKey !== userKey ||
    index.pageId !== normalizedPageId ||
    (fence &&
      (index.workspaceId !== fence.workspaceId ||
        index.channelConnectionId !== fence.channelConnectionId ||
        index.bindingEpoch !== fence.bindingEpoch ||
        index.privacyEpoch !== fence.privacyEpoch))
  ) {
    return null;
  }
  const stored = await Promise.resolve(readState<PartialState>(index.stateKey));
  if (!stored) return null;
  const state = normalizeState(stored.psid ?? "", stored);
  if (
    !state.psid ||
    state.userKey !== userKey ||
    state.pageId !== normalizedPageId ||
    (fence &&
      (state.workspaceId !== fence.workspaceId ||
        state.channelConnectionId !== fence.channelConnectionId ||
        state.bindingEpoch !== fence.bindingEpoch ||
        state.privacyEpoch !== fence.privacyEpoch)) ||
    getPersistedStateKey(state.psid, normalizedPageId, fence) !== index.stateKey
  ) {
    return null;
  }
  return state;
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
  const stateKey = getPersistedStateKey(psid);
  return Promise.resolve(
    updateStoredState<PartialState>(stateKey, current =>
      normalizeState(psid, {
        ...normalizeState(psid, current),
        ...patch,
        updatedAt: now,
      })
    )
  ).then(async state => {
    const normalized = normalizeState(psid, state);
    await Promise.resolve(writeUserPageIndex(stateKey, normalized));
    return normalized;
  });
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
  const stateKey = getPersistedStateKey(psid);
  const current = readState<PartialState>(stateKey);
  const remove = (stored: PartialState | null): MaybePromise<void> => {
    const deleted = deleteState(stateKey);
    const deleteIndex = () => {
      const pageId = stored?.pageId?.trim();
      const userKey = stored?.userKey?.trim();
      const fence =
        stored?.workspaceId &&
        stored.channelConnectionId &&
        stored.bindingEpoch &&
        stored.privacyEpoch
          ? {
              workspaceId: stored.workspaceId,
              channelConnectionId: stored.channelConnectionId,
              bindingEpoch: stored.bindingEpoch,
              privacyEpoch: stored.privacyEpoch,
            }
          : undefined;
      return pageId && userKey
        ? deleteScopedState(
            MESSENGER_USER_PAGE_INDEX_SCOPE,
            getUserPageIndexKey(userKey, pageId, fence)
          )
        : undefined;
    };
    return isPromiseLike(deleted)
      ? deleted.then(() => Promise.resolve(deleteIndex()))
      : deleteIndex();
  };
  return isPromiseLike(current) ? current.then(remove) : remove(current);
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
