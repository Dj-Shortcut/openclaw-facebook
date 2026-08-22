import { createHash } from "node:crypto";
import {
  deleteState,
  deleteStateIfValue,
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
  getMessengerRequestChannel,
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import { toUserKey } from "./privacy";
import { registerMessengerPrivacyOwnership } from "./messengerPrivacyOwnershipHistory";

type PartialState = Partial<MessengerUserState>;
const MESSENGER_PAGE_STATE_KEY_PREFIX = "messenger-page-v2";
const MESSENGER_USER_PAGE_INDEX_SCOPE = "messenger-user-page-v1";
const MESSENGER_STATE_SUBJECT_ROOT_PREFIX = "messenger-state-subject-v1";
const MAX_MESSENGER_STATE_SUBJECT_KEYS = 1_024;

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

function assertRequestPrivacySubject(
  psid: string
): ReturnType<typeof getMessengerRequestPrivacySubject> {
  const subject = getMessengerRequestPrivacySubject();
  if (subject && subject.userKey !== toUserKey(psid)) {
    throw new Error("Messenger state privacy subject does not match sender");
  }
  return subject;
}

function requestStateFence(psid: string): MessengerStateFence | undefined {
  const ownership = getMessengerRequestOwnership();
  const subject = assertRequestPrivacySubject(psid);
  return ownership && subject
    ? { ...ownership, privacyEpoch: subject.privacyEpoch }
    : undefined;
}

function assertFencedStateUserKey(
  psid: string,
  state: Pick<MessengerUserState, "psid" | "userKey">
): void {
  const userKey = toUserKey(psid);
  if (state.psid !== psid || state.userKey !== userKey) {
    throw new Error("Messenger state user identity is inconsistent");
  }
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
  assertRequestPrivacySubject(psid);
  const pageId = explicitPageId?.trim() || getMessengerRequestPageId();
  if (!pageId) {
    return psid;
  }

  const fence =
    explicitFence ??
    (!explicitPageId || pageId === getMessengerRequestPageId()
      ? requestStateFence(psid)
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
  fence: Pick<MessengerStateFence, "workspaceId" | "channelConnectionId">
): string {
  return `messenger-state-privacy:${getStateSubjectTag(userKey, fence)}:erased`;
}

function getStatePrivacyScrubbedKey(
  userKey: string,
  fence: Pick<MessengerStateFence, "workspaceId" | "channelConnectionId">
): string {
  return `messenger-state-privacy:${getStateSubjectTag(userKey, fence)}:scrubbed`;
}

function getStateSubjectRootKey(
  userKey: string,
  fence: Pick<MessengerStateFence, "workspaceId" | "channelConnectionId">
): string {
  return `${MESSENGER_STATE_SUBJECT_ROOT_PREFIX}:${getStateSubjectTag(userKey, fence)}:states`;
}

export function getMessengerStateOperationKey(
  psid: string,
  purpose: string
): string {
  const normalizedPurpose = purpose.trim();
  if (!normalizedPurpose) {
    throw new Error("Messenger state operation purpose is required");
  }

  const pageId = getMessengerRequestPageId()?.trim() ?? "";
  const fence = requestStateFence(psid);
  if (pageId && !fence && process.env.NODE_ENV === "production") {
    throw new Error("Messenger state privacy fence is required");
  }

  const userKey = toUserKey(psid);
  const ownership = fence
    ? `${fence.workspaceId}\0${fence.channelConnectionId}\0${fence.bindingEpoch}\0${fence.privacyEpoch}`
    : pageId
      ? `legacy-page\0${pageId}`
      : "legacy-channel";
  const subjectTag = fence
    ? getStateSubjectTag(userKey, fence)
    : `{messenger-state-operation-${createHash("sha256")
        .update(ownership)
        .update("\0")
        .update(userKey)
        .digest("hex")}}`;
  const digest = createHash("sha256")
    .update(normalizedPurpose)
    .update("\0")
    .update(pageId)
    .update("\0")
    .update(ownership)
    .update("\0")
    .update(psid)
    .digest("hex");
  return `messenger-state-operation-v1:${subjectTag}:${digest}`;
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
  redis.call("SADD", KEYS[4], KEYS[1])
  local rootTtl = redis.call("TTL", KEYS[4])
  if rootTtl < tonumber(ARGV[3]) then
    redis.call("EXPIRE", KEYS[4], ARGV[3])
  end
  return 1
`;

async function writeFencedState(
  psid: string,
  nextState: MessengerUserState,
  expectedRaw?: string | null
): Promise<"stored" | "conflict"> {
  const fence = stateFenceFromState(nextState);
  const requestFence = requestStateFence(psid);
  if (fence || requestFence) assertFencedStateUserKey(psid, nextState);
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
  await registerMessengerPrivacyOwnership({
    pageId: nextState.pageId,
    userKey: nextState.userKey,
    workspaceId: fence.workspaceId,
    channelConnectionId: fence.channelConnectionId,
    bindingEpoch: fence.bindingEpoch,
    privacyEpoch: fence.privacyEpoch,
    channel: getMessengerRequestChannel() ?? "facebook_messenger",
  });
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
      4,
      getStateStorageKey(stateKey),
      getScopedStateStorageKey(MESSENGER_USER_PAGE_INDEX_SCOPE, indexKey),
      getStatePrivacyTombstoneKey(nextState.userKey, fence),
      getStateSubjectRootKey(nextState.userKey, fence),
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
  const fence = stateFenceFromState(nextState);
  const requestFence = requestStateFence(psid);
  if (fence || requestFence) assertFencedStateUserKey(psid, nextState);
  if (isRedisStateStoreEnabled() && fence) {
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
  const fence = requestStateFence(psid);
  const direct = readState<PartialState>(getPersistedStateKey(psid));
  if (isPromiseLike(direct)) {
    throw new Error("Unexpected async state read in memory mode");
  }

  if (!direct) return null;
  const state = normalizeState(psid, direct);
  if (fence) assertFencedStateUserKey(psid, state);
  return state;
}

function getStateFromRedis(psid: string): Promise<MessengerUserState | null> {
  const fence = requestStateFence(psid);
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
    const normalized = normalizeState(psid, state);
    if (fence) assertFencedStateUserKey(psid, normalized);
    return normalized;
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
  const fence = requestStateFence(psid);
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
    assertFencedStateUserKey(psid, state);
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
    if (fence) assertFencedStateUserKey(psid, state);
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
    toUserKey(state.psid) !== userKey ||
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

function createOwnedDefaultState(psid: string): MessengerUserState {
  const created = createDefaultState(psid);
  const ownership = getMessengerRequestOwnership();
  const subject = assertRequestPrivacySubject(psid);
  const pageId = getMessengerRequestPageId();
  if (ownership && subject && pageId) {
    Object.assign(created, ownership, {
      userKey: toUserKey(psid),
      privacyEpoch: subject.privacyEpoch,
      pageId,
    });
  }
  return created;
}

export function getOrCreatePersistedState(
  psid: string
): MaybePromise<MessengerUserState> {
  if (!isRedisStateStoreEnabled()) {
    const state = getStateFromMemory(psid);
    if (state) {
      return state;
    }

    const createdState = createOwnedDefaultState(psid);
    return saveState(psid, createdState);
  }

  return getStateFromRedis(psid).then(async state => {
    if (state) return state;
    const created = createOwnedDefaultState(psid);
    const stored = await writeFencedState(psid, created, null);
    if (stored === "stored") return created;
    const raced = await getStateFromRedis(psid);
    if (!raced) throw new Error("Messenger state creation race was lost");
    return raced;
  });
}

type PersistedStateUpdater = (
  current: MessengerUserState
) => MessengerUserState;

function normalizeMutationResult(
  psid: string,
  current: MessengerUserState,
  updater: PersistedStateUpdater
): MessengerUserState {
  if (stateFenceFromState(current) || requestStateFence(psid)) {
    assertFencedStateUserKey(psid, current);
  }
  const next = normalizeState(psid, updater(current));
  if (
    next.psid !== current.psid ||
    next.userKey !== current.userKey ||
    next.pageId !== current.pageId ||
    next.workspaceId !== current.workspaceId ||
    next.channelConnectionId !== current.channelConnectionId ||
    next.bindingEpoch !== current.bindingEpoch ||
    next.privacyEpoch !== current.privacyEpoch
  ) {
    throw new Error("Messenger state mutation cannot change ownership");
  }
  return next;
}

function mutatePersistedStateInMemory(
  psid: string,
  updater: PersistedStateUpdater,
  existingOnly: boolean
): MessengerUserState | null {
  const stored = getStateFromMemory(psid);
  if (!stored && existingOnly) return null;
  const current = stored ?? createOwnedDefaultState(psid);
  const next = normalizeMutationResult(psid, current, updater);
  const saved = saveState(psid, next);
  if (isPromiseLike(saved)) {
    throw new Error("Unexpected async state save in memory mode");
  }
  return saved;
}

async function mutatePersistedStateInRedis(
  psid: string,
  updater: PersistedStateUpdater,
  existingOnly: boolean
): Promise<MessengerUserState | null> {
  const stateKey = getPersistedStateKey(psid);
  const redis = await getRedisClient();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = await redis.get(getStateStorageKey(stateKey));
    if (!raw && existingOnly) return null;
    const current = raw
      ? normalizeState(psid, JSON.parse(raw) as PartialState)
      : createOwnedDefaultState(psid);
    const next = normalizeMutationResult(psid, current, updater);
    const stored = await writeFencedState(psid, next, raw);
    if (stored === "stored") return next;
  }
  throw new Error("Messenger state mutation contention exceeded retry limit");
}

export function mutatePersistedState(
  psid: string,
  updater: PersistedStateUpdater
): MaybePromise<MessengerUserState> {
  if (!isRedisStateStoreEnabled()) {
    return mutatePersistedStateInMemory(psid, updater, false)!;
  }
  return mutatePersistedStateInRedis(psid, updater, false).then(
    state => state!
  );
}

export function mutateExistingPersistedState(
  psid: string,
  updater: PersistedStateUpdater
): MaybePromise<MessengerUserState | null> {
  if (!isRedisStateStoreEnabled()) {
    return mutatePersistedStateInMemory(psid, updater, true);
  }
  return mutatePersistedStateInRedis(psid, updater, true);
}

function patchStateInMemory(
  psid: string,
  patch: PartialState,
  now = Date.now()
): MessengerUserState {
  const current = getStateFromMemory(psid) ?? createOwnedDefaultState(psid);

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
    const fence = requestStateFence(psid);
    const stateKey = getPersistedStateKey(psid);
    const redis = await getRedisClient();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raw = await redis.get(getStateStorageKey(stateKey));
      const current = raw ? (JSON.parse(raw) as PartialState) : null;
      const normalized = normalizeState(psid, {
        ...(current
          ? normalizeState(psid, current)
          : createOwnedDefaultState(psid)),
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
    const fence = stored
      ? stateFenceFromState(stored)
      : requestStateFence(psid);
    const pageId = stored?.pageId?.trim() || getMessengerRequestPageId();
    const computedUserKey = toUserKey(psid);
    if (fence && stored) {
      assertFencedStateUserKey(psid, normalizeState(psid, stored));
    }
    const userKey = fence
      ? computedUserKey
      : stored?.userKey?.trim() || computedUserKey;
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
            redis.call("SREM", KEYS[3], KEYS[1])
            if redis.call("SCARD", KEYS[3]) == 0 then
              redis.call("DEL", KEYS[3])
            end
            return 1
          `,
          3,
          getStateStorageKey(stateKey),
          getScopedStateStorageKey(MESSENGER_USER_PAGE_INDEX_SCOPE, indexKey),
          getStateSubjectRootKey(userKey, fence),
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
  const requestFence = requestStateFence(psid);
  if (stateFenceFromState(normalized) || requestFence) {
    assertFencedStateUserKey(psid, normalized);
  }
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

export type MessengerStateErasureScope = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
  privacyEpoch: number;
}>;

type IndexedMessengerState = Readonly<{
  stateStorageKey: string;
  logicalStateKey: string;
  indexStorageKey: string;
  raw: string;
  state: MessengerUserState;
}>;

async function getStateSubjectRootMembers(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  rootKey: string
): Promise<string[]> {
  const members = new Set<string>();
  const visitedCursors = new Set<string>();
  let cursor = "0";
  do {
    if (visitedCursors.has(cursor)) {
      throw new Error("Messenger state subject index cursor did not progress");
    }
    visitedCursors.add(cursor);
    const scanResult = await redis.eval(
      "return redis.call('SSCAN', KEYS[1], ARGV[1], 'COUNT', ARGV[2])",
      1,
      rootKey,
      cursor,
      100
    );
    if (!Array.isArray(scanResult) || !Array.isArray(scanResult[1])) {
      throw new Error("Messenger state subject index scan failed");
    }
    const nextCursor = String(scanResult[0]);
    const batch = scanResult[1].map(String);
    for (const member of batch) {
      members.add(member);
      if (members.size > MAX_MESSENGER_STATE_SUBJECT_KEYS) {
        throw new Error("Messenger state subject index exceeds safety bound");
      }
    }
    cursor = nextCursor;
  } while (cursor !== "0");
  return [...members];
}

function parseIndexedMessengerState(
  psid: string,
  scope: MessengerStateErasureScope,
  stateStorageKey: string,
  raw: string
): IndexedMessengerState {
  let parsed: PartialState;
  try {
    parsed = JSON.parse(raw) as PartialState;
  } catch {
    throw new Error("Messenger state subject index contains invalid state");
  }
  const state = normalizeState(psid, parsed);
  const fence = stateFenceFromState(state);
  if (
    !fence ||
    !state.pageId ||
    state.psid !== psid ||
    state.userKey !== scope.userKey ||
    toUserKey(psid) !== scope.userKey ||
    fence.workspaceId !== scope.workspaceId ||
    fence.channelConnectionId !== scope.channelConnectionId
  ) {
    throw new Error("Messenger state subject index ownership is inconsistent");
  }
  const logicalStateKey = getPersistedStateKey(psid, state.pageId, fence);
  if (getStateStorageKey(logicalStateKey) !== stateStorageKey) {
    throw new Error("Messenger state subject index key is inconsistent");
  }
  return {
    stateStorageKey,
    logicalStateKey,
    indexStorageKey: getScopedStateStorageKey(
      MESSENGER_USER_PAGE_INDEX_SCOPE,
      getUserPageIndexKey(scope.userKey, state.pageId, fence)
    ),
    raw,
    state,
  };
}

async function readIndexedMessengerStatesForErasure(
  psid: string,
  scope: MessengerStateErasureScope
): Promise<{
  redis: Awaited<ReturnType<typeof getRedisClient>>;
  rootKey: string;
  missingStateKeys: string[];
  records: IndexedMessengerState[];
}> {
  if (toUserKey(psid) !== scope.userKey) {
    throw new Error("Messenger state erasure subject does not match sender");
  }
  const redis = await getRedisClient();
  const rootKey = getStateSubjectRootKey(scope.userKey, scope);
  const tombstoneEpoch = Number(
    (await redis.get(getStatePrivacyTombstoneKey(scope.userKey, scope))) ?? "0"
  );
  if (
    !Number.isSafeInteger(tombstoneEpoch) ||
    tombstoneEpoch < scope.privacyEpoch
  ) {
    throw new Error("Messenger state privacy tombstone is required");
  }
  const members = await getStateSubjectRootMembers(redis, rootKey);
  const missingStateKeys: string[] = [];
  const records: IndexedMessengerState[] = [];
  for (const stateStorageKey of members) {
    const raw = await redis.get(stateStorageKey);
    if (!raw) {
      missingStateKeys.push(stateStorageKey);
      continue;
    }
    const record = parseIndexedMessengerState(
      psid,
      scope,
      stateStorageKey,
      raw
    );
    if ((record.state.privacyEpoch ?? 0) <= scope.privacyEpoch) {
      records.push(record);
    }
  }
  return { redis, rootKey, missingStateKeys, records };
}

/**
 * Reads only this exact tenant/connection/user subject's historical state.
 * The monotone tombstone must be installed first so the returned object
 * inventory cannot be extended by a stale writer while deletion is running.
 */
export async function getPersistedStateHistoryForErasure(
  psid: string,
  scope: MessengerStateErasureScope
): Promise<MessengerUserState[]> {
  if (!isRedisStateStoreEnabled()) return [];
  const { records } = await readIndexedMessengerStatesForErasure(psid, scope);
  return records.map(record => record.state);
}

/**
 * Returns true only after the durable erasure saga has deleted every indexed
 * state at or below this privacy epoch. This marker lets a crashed saga finish
 * the DB subject transition without recreating already-scrubbed state.
 */
export async function isPersistedStateHistoryErased(
  psid: string,
  scope: MessengerStateErasureScope
): Promise<boolean> {
  if (toUserKey(psid) !== scope.userKey) return false;
  if (!isRedisStateStoreEnabled()) return false;
  const redis = await getRedisClient();
  const scrubbedEpoch = Number(
    (await redis.get(getStatePrivacyScrubbedKey(scope.userKey, scope))) ?? "0"
  );
  return (
    Number.isSafeInteger(scrubbedEpoch) && scrubbedEpoch >= scope.privacyEpoch
  );
}

const DELETE_INDEXED_MESSENGER_STATE_SCRIPT = `
  local current = redis.call("GET", KEYS[1])
  if not current then
    redis.call("SREM", KEYS[3], KEYS[1])
    if redis.call("SCARD", KEYS[3]) == 0 then redis.call("DEL", KEYS[3]) end
    return 1
  end
  if current ~= ARGV[1] then return 0 end
  local index = redis.call("GET", KEYS[2])
  if index then
    local ok, decoded = pcall(cjson.decode, index)
    if not ok then return -1 end
    if decoded["stateKey"] == ARGV[2] then redis.call("DEL", KEYS[2]) end
  end
  redis.call("DEL", KEYS[1])
  redis.call("SREM", KEYS[3], KEYS[1])
  if redis.call("SCARD", KEYS[3]) == 0 then redis.call("DEL", KEYS[3]) end
  return 1
`;

/** Deletes every indexed historical binding at or below the erased epoch. */
export async function deletePersistedStateHistoryForErasure(
  psid: string,
  scope: MessengerStateErasureScope
): Promise<void> {
  if (!isRedisStateStoreEnabled()) return;
  const { redis, rootKey, missingStateKeys, records } =
    await readIndexedMessengerStatesForErasure(psid, scope);
  for (const missingStateKey of missingStateKeys) {
    await redis.srem(rootKey, missingStateKey);
  }
  for (const record of records) {
    const result = Number(
      await redis.eval(
        DELETE_INDEXED_MESSENGER_STATE_SCRIPT,
        3,
        record.stateStorageKey,
        record.indexStorageKey,
        rootKey,
        record.raw,
        record.logicalStateKey
      )
    );
    if (result !== 1) {
      throw new Error("Messenger historical state deletion CAS failed");
    }
  }

  // The stable tombstone makes old-epoch writes impossible. Re-read the root
  // before publishing the durable scrub marker so a corrupt or unindexed
  // record can never be mistaken for a completed state scrub. A strictly
  // newer privacy epoch is a separate lifecycle and remains indexed.
  const remaining = await readIndexedMessengerStatesForErasure(psid, scope);
  if (remaining.missingStateKeys.length || remaining.records.length) {
    throw new Error("Messenger historical state scrub is incomplete");
  }
  const scrubbedEpoch = Number(
    await redis.eval(
      `
        local tombstone = tonumber(redis.call("GET", KEYS[1]) or "0")
        local requested = tonumber(ARGV[1])
        if tombstone < requested then return -1 end
        local current = tonumber(redis.call("GET", KEYS[2]) or "0")
        if current < requested then
          redis.call("SET", KEYS[2], ARGV[1])
          return requested
        end
        return current
      `,
      2,
      getStatePrivacyTombstoneKey(scope.userKey, scope),
      getStatePrivacyScrubbedKey(scope.userKey, scope),
      scope.privacyEpoch
    )
  );
  if (
    !Number.isSafeInteger(scrubbedEpoch) ||
    scrubbedEpoch < scope.privacyEpoch
  ) {
    throw new Error("Messenger state scrub marker update failed");
  }
}

function hasLegacyQuotaShape(state: PartialState): boolean {
  return (
    typeof state.quota?.dayKey === "string" &&
    Number.isSafeInteger(state.quota.count) &&
    state.quota.count >= 0
  );
}

/**
 * Deletes only the exact raw-PSID record proven to be a quota shadow of the
 * Page-owned state being erased. This intentionally performs no keyspace scan
 * and preserves raw records whose Page or ownership fence does not match.
 */
export async function deleteLegacyMessengerQuotaShadow(
  psid: string,
  ownedState: MessengerUserState
): Promise<"absent" | "deleted" | "unowned" | "conflict"> {
  if (!ownedState.pageId?.trim() || !hasLegacyQuotaShape(ownedState)) {
    return "unowned";
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = await Promise.resolve(readState<PartialState>(psid));
    if (!candidate) return "absent";
    if (!candidate.pageId?.trim() || !hasLegacyQuotaShape(candidate)) {
      return "unowned";
    }
    const normalized = normalizeState(psid, candidate);
    if (
      normalized.psid !== ownedState.psid ||
      normalized.userKey !== ownedState.userKey ||
      normalized.pageId !== ownedState.pageId ||
      normalized.workspaceId !== ownedState.workspaceId ||
      normalized.channelConnectionId !== ownedState.channelConnectionId ||
      normalized.bindingEpoch !== ownedState.bindingEpoch ||
      normalized.privacyEpoch !== ownedState.privacyEpoch
    ) {
      return "unowned";
    }

    if (await Promise.resolve(deleteStateIfValue(psid, candidate))) {
      return "deleted";
    }
  }

  return "conflict";
}

/** Deletes a pre-Page-scope legacy key regardless of the active Page context. */
export function deleteLegacyPersistedState(psid: string): MaybePromise<void> {
  return deleteState(psid);
}
