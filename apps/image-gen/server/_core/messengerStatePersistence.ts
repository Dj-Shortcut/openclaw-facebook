import { createHash } from "node:crypto";
import {
  deleteState,
  deleteScopedState,
  getScopedStateStorageKey,
  getStateStorageKey,
  getStateTtlSeconds,
  isPromiseLike,
  isRedisStateStoreEnabled,
  readState,
  readScopedState,
  writeState,
  writeScopedState,
  type MaybePromise,
} from "./stateStore";
import { getRedisClient } from "./redis";
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
import { toUserKey } from "./privacy";

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
  const userKey = toUserKey(psid);
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
  return fence
    ? `${MESSENGER_PAGE_STATE_KEY_PREFIX}:${getStateSubjectTag(userKey, fence)}:${digest}`
    : `${MESSENGER_PAGE_STATE_KEY_PREFIX}:${digest}`;
}

function getUserPageIndexKey(
  userKey: string,
  pageId: string,
  fence?: MessengerStateFence
): string {
  const digest = createHash("sha256")
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
  return fence ? `${getStateSubjectTag(userKey, fence)}:${digest}` : digest;
}

function getStateSubjectTag(
  userKey: string,
  fence: Pick<MessengerStateFence, "workspaceId" | "channelConnectionId">
): string {
  const subjectId = createHash("sha256")
    .update(String(fence.workspaceId))
    .update("\0")
    .update(String(fence.channelConnectionId))
    .update("\0")
    .update(userKey)
    .digest("hex");
  return `{messenger-state-${subjectId}}`;
}

function getStatePrivacyTombstoneKey(
  userKey: string,
  fence: MessengerStateFence
): string {
  return `messenger-state-privacy:${getStateSubjectTag(userKey, fence)}:erased`;
}

const FENCED_STATE_WRITE_SCRIPT = `
  local tombstone = tonumber(redis.call("GET", KEYS[3]) or "0")
  local privacyEpoch = tonumber(ARGV[5])
  if tombstone >= privacyEpoch then return -1 end

  local current = redis.call("GET", KEYS[1])
  if ARGV[6] == "missing" and current then return 0 end
  if ARGV[6] == "exact" and current ~= ARGV[7] then return 0 end

  local currentIndex = redis.call("GET", KEYS[2])
  if currentIndex then
    local ok, decoded = pcall(cjson.decode, currentIndex)
    if not ok or decoded["stateKey"] ~= ARGV[4] then return -2 end
  end

  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[3])
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
  return 1
`;

async function writeFencedState(
  psid: string,
  nextState: MessengerUserState,
  expectedRaw?: string | null
): Promise<"stored" | "conflict"> {
  const fence = stateFenceFromState(nextState);
  if (!fence || !nextState.pageId || !nextState.userKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger state privacy fence is required");
    }
    await Promise.resolve(
      writeState(getPersistedStateKey(psid, nextState.pageId), nextState)
    );
    await Promise.resolve(
      writeUserPageIndex(
        getPersistedStateKey(psid, nextState.pageId),
        nextState
      )
    );
    return "stored";
  }
  const stateKey = getPersistedStateKey(psid, nextState.pageId, fence);
  const indexKey = getUserPageIndexKey(
    nextState.userKey,
    nextState.pageId,
    fence
  );
  const index = {
    stateKey,
    userKey: nextState.userKey,
    pageId: nextState.pageId,
    ambiguous: false,
    ...fence,
  } satisfies MessengerUserPageIndex;
  const redis = await getRedisClient();
  const mode =
    expectedRaw === undefined
      ? "any"
      : expectedRaw === null
        ? "missing"
        : "exact";
  const result = Number(
    await redis.eval(
      FENCED_STATE_WRITE_SCRIPT,
      3,
      getStateStorageKey(stateKey),
      getScopedStateStorageKey(MESSENGER_USER_PAGE_INDEX_SCOPE, indexKey),
      getStatePrivacyTombstoneKey(nextState.userKey, fence),
      JSON.stringify(nextState),
      JSON.stringify(index),
      getStateTtlSeconds(nextState),
      stateKey,
      fence.privacyEpoch,
      mode,
      expectedRaw ?? ""
    )
  );
  if (result === 1) return "stored";
  if (result === 0) return "conflict";
  if (result === -1) throw new Error("Messenger state subject is erased");
  throw new Error("Messenger state index ownership is inconsistent");
}

function stateFenceFromState(
  state: PartialState
): MessengerStateFence | undefined {
  return state.workspaceId &&
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
  if (isRedisStateStoreEnabled() && stateFenceFromState(nextState)) {
    return writeFencedState(psid, nextState).then(() => nextState);
  }
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
  const fence = requestStateFence();
  const userKey = toUserKey(psid);
  return Promise.resolve(
    readState<PartialState>(getPersistedStateKey(psid))
  ).then(async state => {
    if (!state) return null;
    if (fence) {
      const redis = await getRedisClient();
      const erasedEpoch = Number(
        (await redis.get(getStatePrivacyTombstoneKey(userKey, fence))) ?? "0"
      );
      if (erasedEpoch >= fence.privacyEpoch) return null;
    }
    return normalizeState(psid, state);
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

/**
 * Reads the already-owned state while an erasure tombstone is active. This is
 * deliberately restricted to the verified request fence so deletion retries
 * can finish scrubbing the old epoch without reopening normal state access.
 */
export function getPersistedStateForErasure(
  psid: string
): MaybePromise<MessengerUserState | null> {
  const fence = requestStateFence();
  const pageId = getMessengerRequestPageId();
  if (!fence || !pageId) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger erasure state fence is required");
    }
    return getPersistedState(psid);
  }
  const key = getPersistedStateKey(psid, pageId, fence);
  const normalizeOwned = (raw: PartialState | null) => {
    if (!raw) return null;
    const state = normalizeState(psid, raw);
    return state.workspaceId === fence.workspaceId &&
      state.channelConnectionId === fence.channelConnectionId &&
      state.bindingEpoch === fence.bindingEpoch &&
      state.privacyEpoch === fence.privacyEpoch &&
      state.pageId === pageId &&
      state.userKey === toUserKey(psid)
      ? state
      : null;
  };
  const raw = readState<PartialState>(key);
  return isPromiseLike(raw) ? raw.then(normalizeOwned) : normalizeOwned(raw);
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
  return Promise.resolve(readState<PartialState>(key)).then(async direct => {
    if (fence) {
      const redis = await getRedisClient();
      const erasedEpoch = Number(
        (await redis.get(
          getStatePrivacyTombstoneKey(toUserKey(psid), fence)
        )) ?? "0"
      );
      if (erasedEpoch >= fence.privacyEpoch) return null;
    }
    return normalizeOwnedState(direct);
  });
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
  if (fence && isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    const erasedEpoch = Number(
      (await redis.get(getStatePrivacyTombstoneKey(userKey, fence))) ?? "0"
    );
    if (erasedEpoch >= fence.privacyEpoch) return null;
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
  const createOwnedDefaultState = () => {
    const created = createDefaultState(psid);
    const ownership = getMessengerRequestOwnership();
    const subject = getMessengerRequestPrivacySubject();
    const pageId = getMessengerRequestPageId();
    if (ownership && subject && pageId) {
      Object.assign(created, ownership, subject, { pageId });
    }
    return created;
  };
  if (!isRedisStateStoreEnabled()) {
    const state = getStateFromMemory(psid);
    if (state) {
      return state;
    }

    const createdState = createOwnedDefaultState();
    return saveState(psid, createdState);
  }

  return getStateFromRedis(psid).then(async state => {
    if (state) return state;
    const created = createOwnedDefaultState();
    const stored = await writeFencedState(psid, created, null);
    if (stored === "stored") return created;
    const raced = await getStateFromRedis(psid);
    if (!raced) throw new Error("Messenger state creation race was lost");
    return raced;
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
  return (async () => {
    const fence = requestStateFence();
    const stateKey = getPersistedStateKey(psid);
    const redis = await getRedisClient();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raw = await redis.get(getStateStorageKey(stateKey));
      const current = raw ? (JSON.parse(raw) as PartialState) : null;
      const normalized = normalizeState(psid, {
        ...normalizeState(psid, current),
        ...patch,
        updatedAt: now,
      });
      if (!fence && process.env.NODE_ENV === "production") {
        throw new Error("Messenger state privacy fence is required");
      }
      const stored = await writeFencedState(psid, normalized, raw);
      if (stored === "stored") return normalized;
    }
    throw new Error("Messenger state update contention exceeded retry limit");
  })();
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
    const fence = stored ? stateFenceFromState(stored) : requestStateFence();
    const pageId = stored?.pageId?.trim() || getMessengerRequestPageId();
    const userKey = stored?.userKey?.trim() || toUserKey(psid);
    if (isRedisStateStoreEnabled() && fence && pageId && userKey) {
      const indexKey = getUserPageIndexKey(userKey, pageId, fence);
      return getRedisClient().then(async redis => {
        await redis.eval(
          `
            redis.call("DEL", KEYS[1])
            local index = redis.call("GET", KEYS[2])
            if index then
              local ok, decoded = pcall(cjson.decode, index)
              if ok and decoded["stateKey"] == ARGV[1] then
                redis.call("DEL", KEYS[2])
              end
            end
            return 1
          `,
          2,
          getStateStorageKey(stateKey),
          getScopedStateStorageKey(MESSENGER_USER_PAGE_INDEX_SCOPE, indexKey),
          stateKey
        );
      });
    }
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
  const normalized = normalizeState(psid, state);
  if (isRedisStateStoreEnabled() && stateFenceFromState(normalized)) {
    return writeFencedState(psid, normalized).then(() => undefined);
  }
  return writeState(getPersistedStateKey(psid), normalized);
}

/**
 * Sets the durable state tombstone before any deletion scrub begins. The
 * marker is monotone per workspace/connection/user and permits only a future,
 * strictly higher privacy epoch to write state again.
 */
export async function beginMessengerStatePrivacyErasure(input: {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
}): Promise<void> {
  if (!isRedisStateStoreEnabled()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Redis state store is required for privacy erasure");
    }
    return;
  }
  const redis = await getRedisClient();
  const fence: MessengerStateFence = input;
  const result = Number(
    await redis.eval(
      `
        local current = tonumber(redis.call("GET", KEYS[1]) or "0")
        local requested = tonumber(ARGV[1])
        if current < requested then
          redis.call("SET", KEYS[1], ARGV[1])
          return requested
        end
        return current
      `,
      1,
      getStatePrivacyTombstoneKey(input.userKey, fence),
      input.privacyEpoch
    )
  );
  if (!Number.isSafeInteger(result) || result < input.privacyEpoch) {
    throw new Error("Messenger state privacy tombstone update failed");
  }
}

/** Deletes a pre-Page-scope legacy key regardless of the active Page context. */
export function deleteLegacyPersistedState(psid: string): MaybePromise<void> {
  return deleteState(psid);
}
