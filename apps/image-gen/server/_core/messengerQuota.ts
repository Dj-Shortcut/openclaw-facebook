import { randomUUID } from "node:crypto";
import { getDayKey } from "./messengerStateNormalization";
import { getOrCreateState, type MessengerUserState } from "./messengerState";
import {
  deleteEphemeralKeyIfValue,
  hasEphemeralKeyValue,
  setEphemeralKeyIfAbsent,
  updateExistingStoredState,
  updateStoredState,
} from "./stateStore";

const DEFAULT_FREE_DAILY_LIMIT = 3;
const DEFAULT_DAILY_AUDIO_TRANSCRIPTION_LIMIT = 3;
const DEFAULT_DAILY_VIDEO_GENERATION_LIMIT = 1;
const IMAGE_GENERATION_QUOTA_LOCK_MS = 240_000;
const VIDEO_GENERATION_QUOTA_LOCK_MS = 600_000;
const TRANSCRIPTION_QUOTA_LOCK_MS = 90_000;
const TRANSCRIPTION_QUOTA_LOCK_MAX_RETRIES = 20;
const TRANSCRIPTION_QUOTA_LOCK_RETRY_MS = 25;

export type ImageGenerationQuotaReservation = {
  token: string;
};

export type VideoGenerationQuotaReservation = {
  token: string;
};

export type TranscriptionQuotaReservation = {
  token: string;
};

export class MessengerQuotaReservationCommitError extends Error {
  constructor(message = "Messenger quota reservation could not be committed") {
    super(message);
    this.name = "MessengerQuotaReservationCommitError";
  }
}

export function getFreeDailyLimit(): number {
  const configured = Number(process.env.MESSENGER_FREE_DAILY_LIMIT);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return DEFAULT_FREE_DAILY_LIMIT;
}

function getTranscriptionLimit(): number {
  const configured = Number(process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return DEFAULT_DAILY_AUDIO_TRANSCRIPTION_LIMIT;
}

function getVideoGenerationLimit(): number {
  const configured = Number(process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return DEFAULT_DAILY_VIDEO_GENERATION_LIMIT;
}

function toSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function transcriptionQuotaLockKey(psid: string): string {
  return `messenger:transcription-quota:${psid}`;
}

function imageGenerationQuotaLockKey(psid: string): string {
  return `messenger:image-generation-quota:${psid}`;
}

function videoGenerationQuotaLockKey(psid: string): string {
  return `messenger:video-generation-quota:${psid}`;
}

function imageGenerationReservationExpiresAt(now = Date.now()): number {
  return now + IMAGE_GENERATION_QUOTA_LOCK_MS;
}

function videoGenerationReservationExpiresAt(now = Date.now()): number {
  return now + VIDEO_GENERATION_QUOTA_LOCK_MS;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

async function reserveTranscriptionSlot(psid: string): Promise<string | null> {
  const lockKey = transcriptionQuotaLockKey(psid);
  const ttlSeconds = toSeconds(TRANSCRIPTION_QUOTA_LOCK_MS);

  for (let attempt = 0; attempt < TRANSCRIPTION_QUOTA_LOCK_MAX_RETRIES; attempt += 1) {
    const token = randomUUID();
    if (await setEphemeralKeyIfAbsent(lockKey, token, ttlSeconds)) {
      return token;
    }

    if (attempt < TRANSCRIPTION_QUOTA_LOCK_MAX_RETRIES - 1) {
      await wait(TRANSCRIPTION_QUOTA_LOCK_RETRY_MS);
    }
  }

  return null;
}

async function reserveImageGenerationSlot(psid: string): Promise<string | null> {
  const lockKey = imageGenerationQuotaLockKey(psid);
  const ttlSeconds = toSeconds(IMAGE_GENERATION_QUOTA_LOCK_MS);
  const token = randomUUID();

  if (await setEphemeralKeyIfAbsent(lockKey, token, ttlSeconds)) {
    return token;
  }

  return null;
}

async function reserveVideoGenerationSlot(psid: string): Promise<string | null> {
  const lockKey = videoGenerationQuotaLockKey(psid);
  const ttlSeconds = toSeconds(VIDEO_GENERATION_QUOTA_LOCK_MS);
  const token = randomUUID();

  if (await setEphemeralKeyIfAbsent(lockKey, token, ttlSeconds)) {
    return token;
  }

  return null;
}

/** Returns whether a Messenger PSID or tenant-safe user key has exact quota bypass access. */
export function hasQuotaBypass(psid: string, userKey: string): boolean {
  const raw = process.env.MESSENGER_QUOTA_BYPASS_IDS ?? "";
  if (!raw.trim()) {
    return false;
  }

  const ids = new Set(
    raw
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
  );
  return ids.has(psid) || ids.has(userKey);
}

function withSyncedQuota(
  state: MessengerUserState,
  now = Date.now()
): MessengerUserState {
  const dayKey = getDayKey(now);

  if (state.quota.dayKey === dayKey) {
    return state;
  }

  return {
    ...state,
    quota: {
      dayKey,
      count: 0,
    },
    updatedAt: now,
  };
}

function withSyncedTranscriptionQuota(
  state: MessengerUserState,
  now = Date.now()
): MessengerUserState {
  const dayKey = getDayKey(now);
  if (state.transcriptionQuota?.dayKey === dayKey) {
    return state;
  }

  return {
    ...state,
    transcriptionQuota: {
      dayKey,
      count: 0,
    },
    updatedAt: now,
  };
}

function withSyncedVideoGenerationQuota(
  state: MessengerUserState,
  now = Date.now()
): MessengerUserState {
  const dayKey = getDayKey(now);
  if (state.videoGenerationQuota?.dayKey === dayKey) {
    return state;
  }

  return {
    ...state,
    videoGenerationQuota: {
      dayKey,
      count: 0,
    },
    updatedAt: now,
  };
}

async function syncQuotaState(
  psid: string,
  now = Date.now()
): Promise<MessengerUserState> {
  const current = withSyncedQuota(
    await Promise.resolve(getOrCreateState(psid)),
    now
  );

  return Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      if (!storedState) {
        return current;
      }

      return withSyncedQuota(storedState, now);
    })
  );
}

async function syncTranscriptionQuotaState(
  psid: string,
  now = Date.now()
): Promise<MessengerUserState> {
  const current = withSyncedTranscriptionQuota(
    await Promise.resolve(getOrCreateState(psid)),
    now
  );

  return Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      if (!storedState) {
        return withSyncedTranscriptionQuota(current, now);
      }

      return withSyncedTranscriptionQuota(withSyncedQuota(storedState, now), now);
    })
  );
}

export async function canGenerate(psid: string): Promise<boolean> {
  const state = await syncQuotaState(psid);
  if (hasQuotaBypass(psid, state.userKey)) {
    return true;
  }

  return state.quota.count < getFreeDailyLimit();
}

export async function reserveImageGenerationForAttempt(
  psid: string
): Promise<ImageGenerationQuotaReservation | null> {
  const lockToken = await reserveImageGenerationSlot(psid);
  if (!lockToken) {
    return null;
  }

  try {
    const now = Date.now();
    const fallbackState = await Promise.resolve(getOrCreateState(psid));
    const limit = getFreeDailyLimit();
    let allowed = false;
    const reservationState = {
      token: lockToken,
      expiresAt: imageGenerationReservationExpiresAt(now),
    };

    await Promise.resolve(
      updateStoredState<MessengerUserState>(psid, storedState => {
        const baseState = withSyncedQuota(storedState ?? fallbackState, now);

        if (hasQuotaBypass(psid, baseState.userKey)) {
          allowed = true;
          return {
            ...baseState,
            imageGenerationQuotaReservation: reservationState,
            updatedAt: now,
          };
        }

        if (baseState.quota.count >= limit) {
          return baseState;
        }

        allowed = true;
        return {
          ...baseState,
          imageGenerationQuotaReservation: reservationState,
          updatedAt: now,
        };
      })
    );

    if (!allowed) {
      await deleteEphemeralKeyIfValue(
        imageGenerationQuotaLockKey(psid),
        lockToken
      );
      return null;
    }

    return { token: lockToken };
  } catch (error) {
    await deleteEphemeralKeyIfValue(imageGenerationQuotaLockKey(psid), lockToken);
    throw error;
  }
}

export async function commitImageGenerationSuccess(
  psid: string,
  reservation: ImageGenerationQuotaReservation
): Promise<boolean> {
  let committed = false;
  try {
    const now = Date.now();
    const limit = getFreeDailyLimit();

    await Promise.resolve(
      updateExistingStoredState<MessengerUserState>(psid, storedState => {
        const baseState = withSyncedQuota(storedState, now);
        const storedReservation = baseState.imageGenerationQuotaReservation;
        const hasValidStoredReservation =
          storedReservation?.token === reservation.token &&
          storedReservation.expiresAt > now;

        if (!hasValidStoredReservation) {
          return baseState;
        }

        if (hasQuotaBypass(psid, baseState.userKey)) {
          committed = true;
          return {
            ...baseState,
            imageGenerationQuotaReservation: null,
            updatedAt: now,
          };
        }

        if (baseState.quota.count >= limit) {
          return baseState;
        }

        committed = true;
        return {
          ...baseState,
          imageGenerationQuotaReservation: null,
          quota: {
            ...baseState.quota,
            count: baseState.quota.count + 1,
          },
          updatedAt: now,
        };
      })
    );
    return committed;
  } finally {
    await releaseImageGenerationReservation(psid, reservation);
  }
}

export async function releaseImageGenerationReservation(
  psid: string,
  reservation: ImageGenerationQuotaReservation
): Promise<void> {
  await deleteEphemeralKeyIfValue(
    imageGenerationQuotaLockKey(psid),
    reservation.token
  );

  const now = Date.now();
  await Promise.resolve(
    updateExistingStoredState<MessengerUserState>(psid, storedState => {
      const baseState = withSyncedQuota(storedState, now);
      if (baseState.imageGenerationQuotaReservation?.token !== reservation.token) {
        return baseState;
      }

      return {
        ...baseState,
        imageGenerationQuotaReservation: null,
        updatedAt: now,
      };
    })
  );
}

export async function canGenerateVideo(psid: string): Promise<boolean> {
  const now = Date.now();
  const current = withSyncedVideoGenerationQuota(
    withSyncedQuota(await Promise.resolve(getOrCreateState(psid)), now),
    now
  );

  const state = await Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      if (!storedState) {
        return current;
      }

      return withSyncedVideoGenerationQuota(
        withSyncedQuota(storedState, now),
        now
      );
    })
  );

  if (hasQuotaBypass(psid, state.userKey)) {
    return true;
  }

  return state.videoGenerationQuota.count < getVideoGenerationLimit();
}

export async function reserveVideoGenerationForAttempt(
  psid: string
): Promise<VideoGenerationQuotaReservation | null> {
  const lockToken = await reserveVideoGenerationSlot(psid);
  if (!lockToken) {
    return null;
  }

  try {
    const now = Date.now();
    const fallbackState = await Promise.resolve(getOrCreateState(psid));
    const limit = getVideoGenerationLimit();
    let allowed = false;
    const reservationState = {
      token: lockToken,
      expiresAt: videoGenerationReservationExpiresAt(now),
    };

    await Promise.resolve(
      updateStoredState<MessengerUserState>(psid, storedState => {
        const baseState = withSyncedVideoGenerationQuota(
          withSyncedQuota(storedState ?? fallbackState, now),
          now
        );

        if (hasQuotaBypass(psid, baseState.userKey)) {
          allowed = true;
          return {
            ...baseState,
            videoGenerationQuotaReservation: reservationState,
            updatedAt: now,
          };
        }

        if (baseState.videoGenerationQuota.count >= limit) {
          return baseState;
        }

        allowed = true;
        return {
          ...baseState,
          videoGenerationQuotaReservation: reservationState,
          updatedAt: now,
        };
      })
    );

    if (!allowed) {
      await deleteEphemeralKeyIfValue(videoGenerationQuotaLockKey(psid), lockToken);
      return null;
    }

    return { token: lockToken };
  } catch (error) {
    await deleteEphemeralKeyIfValue(videoGenerationQuotaLockKey(psid), lockToken);
    throw error;
  }
}

export async function commitVideoGenerationSuccess(
  psid: string,
  reservation: VideoGenerationQuotaReservation
): Promise<boolean> {
  let committed = false;
  try {
    const now = Date.now();
    const limit = getVideoGenerationLimit();

    await Promise.resolve(
      updateExistingStoredState<MessengerUserState>(psid, storedState => {
        const baseState = withSyncedVideoGenerationQuota(
          withSyncedQuota(storedState, now),
          now
        );
        const storedReservation = baseState.videoGenerationQuotaReservation;
        const hasValidStoredReservation =
          storedReservation?.token === reservation.token &&
          storedReservation.expiresAt > now;

        if (!hasValidStoredReservation) {
          return baseState;
        }

        if (hasQuotaBypass(psid, baseState.userKey)) {
          committed = true;
          return {
            ...baseState,
            videoGenerationQuotaReservation: null,
            updatedAt: now,
          };
        }

        if (baseState.videoGenerationQuota.count >= limit) {
          return baseState;
        }

        committed = true;
        return {
          ...baseState,
          videoGenerationQuotaReservation: null,
          videoGenerationQuota: {
            ...baseState.videoGenerationQuota,
            count: baseState.videoGenerationQuota.count + 1,
          },
          updatedAt: now,
        };
      })
    );
    return committed;
  } finally {
    await releaseVideoGenerationReservation(psid, reservation);
  }
}

export async function releaseVideoGenerationReservation(
  psid: string,
  reservation: VideoGenerationQuotaReservation
): Promise<void> {
  await deleteEphemeralKeyIfValue(
    videoGenerationQuotaLockKey(psid),
    reservation.token
  );

  const now = Date.now();
  await Promise.resolve(
    updateExistingStoredState<MessengerUserState>(psid, storedState => {
      const baseState = withSyncedVideoGenerationQuota(
        withSyncedQuota(storedState, now),
        now
      );
      if (baseState.videoGenerationQuotaReservation?.token !== reservation.token) {
        return baseState;
      }

      return {
        ...baseState,
        videoGenerationQuotaReservation: null,
        updatedAt: now,
      };
    })
  );
}

export async function canTranscribe(psid: string): Promise<boolean> {
  const state = await syncTranscriptionQuotaState(psid);
  if (hasQuotaBypass(psid, state.userKey)) {
    return true;
  }

  return state.transcriptionQuota.count < getTranscriptionLimit();
}

export async function checkAndIncrementTranscription(
  psid: string
): Promise<boolean> {
  const reservation = await reserveTranscriptionForAttempt(psid);
  if (!reservation) {
    return false;
  }

  return await commitTranscriptionSuccess(psid, reservation);
}

export async function reserveTranscriptionForAttempt(
  psid: string
): Promise<TranscriptionQuotaReservation | null> {
  const lockToken = await reserveTranscriptionSlot(psid);
  if (!lockToken) {
    return null;
  }

  try {
    const now = Date.now();
    const fallbackState = await Promise.resolve(getOrCreateState(psid));
    const limit = getTranscriptionLimit();
    let allowed = false;

    await Promise.resolve(
      updateStoredState<MessengerUserState>(psid, storedState => {
        const baseState = withSyncedTranscriptionQuota(
          withSyncedQuota(storedState ?? fallbackState, now),
          now
        );

        if (hasQuotaBypass(psid, baseState.userKey)) {
          allowed = true;
          return baseState;
        }

        if (baseState.transcriptionQuota.count >= limit) {
          return baseState;
        }

        allowed = true;
        return baseState;
      })
    );

    if (!allowed) {
      await deleteEphemeralKeyIfValue(transcriptionQuotaLockKey(psid), lockToken);
      return null;
    }

    return { token: lockToken };
  } catch (error) {
    await deleteEphemeralKeyIfValue(transcriptionQuotaLockKey(psid), lockToken);
    throw error;
  }
}

export async function commitTranscriptionSuccess(
  psid: string,
  reservation: TranscriptionQuotaReservation
): Promise<boolean> {
  const lockKey = transcriptionQuotaLockKey(psid);
  if (!(await hasEphemeralKeyValue(lockKey, reservation.token))) {
    return false;
  }

  try {
    const now = Date.now();
    const fallbackState = await Promise.resolve(getOrCreateState(psid));
    const limit = getTranscriptionLimit();

    await Promise.resolve(
      updateStoredState<MessengerUserState>(psid, storedState => {
        const baseState = withSyncedTranscriptionQuota(
          withSyncedQuota(storedState ?? fallbackState, now),
          now
        );

        if (hasQuotaBypass(psid, baseState.userKey)) {
          return baseState;
        }

        if (baseState.transcriptionQuota.count >= limit) {
          return baseState;
        }

        return {
          ...baseState,
          transcriptionQuota: {
            ...baseState.transcriptionQuota,
            count: baseState.transcriptionQuota.count + 1,
          },
          updatedAt: now,
        };
      })
    );
    return true;
  } finally {
    await releaseTranscriptionReservation(psid, reservation);
  }
}

export async function releaseTranscriptionReservation(
  psid: string,
  reservation: TranscriptionQuotaReservation
): Promise<void> {
  await deleteEphemeralKeyIfValue(
    transcriptionQuotaLockKey(psid),
    reservation.token
  );
}

export async function increment(psid: string): Promise<void> {
  const now = Date.now();
  const current = await syncQuotaState(psid, now);
  if (hasQuotaBypass(psid, current.userKey)) {
    return;
  }

  await Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      const baseState = withSyncedQuota(storedState ?? current, now);

      return {
        ...baseState,
        quota: {
          ...baseState.quota,
          count: baseState.quota.count + 1,
        },
        updatedAt: now,
      };
    })
  );
}

export async function incrementTranscription(psid: string): Promise<void> {
  const now = Date.now();
  const current = await syncTranscriptionQuotaState(psid, now);
  if (hasQuotaBypass(psid, current.userKey)) {
    return;
  }

  await Promise.resolve(
    updateStoredState<MessengerUserState>(psid, storedState => {
      const baseState = withSyncedTranscriptionQuota(
        withSyncedQuota(storedState ?? current, now),
        now
      );

      return {
        ...baseState,
        transcriptionQuota: {
          ...baseState.transcriptionQuota,
          count: baseState.transcriptionQuota.count + 1,
        },
        updatedAt: now,
      };
    })
  );
}
