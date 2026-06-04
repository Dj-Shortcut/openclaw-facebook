import type { Lang } from "./i18n";
import type { ConversationAction } from "./botResponse";
import {
  clearStateStore,
  deleteState,
  isPromiseLike,
  type MaybePromise,
} from "./stateStore";
import { toUserKey } from "./privacy";
import {
  getOrCreatePersistedState,
  getPersistedState,
  patchState,
} from "./messengerStatePersistence";

export type ConversationState =
  | "IDLE"
  | "AWAITING_PHOTO"
  | "AWAITING_EDIT_PROMPT"
  | "PROCESSING"
  | "RESULT_READY"
  | "FAILURE";
export type MessengerFlowState = ConversationState;

export type QuotaState = {
  dayKey: string;
  count: number;
};

export type SourceImageOrigin = "external" | "stored";

export type MessengerUserState = {
  psid: string;
  userKey: string;
  stage: MessengerFlowState;
  state: MessengerFlowState;
  lastUserMessageAt?: number;
  lastPhotoUrl: string | null;
  lastPhoto: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
  preferredLang?: Lang;
  consentGiven: boolean;
  consentTimestamp?: number;
  pendingDeleteConfirm?: boolean;
  hasSeenIntro: boolean;
  pendingImageUrl?: string;
  pendingImageAt?: number;
  faceMemoryConsent?: {
    given: boolean;
    timestamp: number;
    version: string;
  } | null;
  lastSourceImageUrl?: string | null;
  lastSourceImageUpdatedAt?: number | null;
  pendingSourceImageDeleteUrl?: string | null;
  pendingScreenshotIntentContinuation?: boolean;
  lastImageUrl?: string;
  lastGeneratedUrl?: string | null;
  lastPrompt?: string;
  lastGeneratedAt?: number;
  lastVariantCursor?: number;
  pendingConversationActions?: ConversationAction[];
  pendingConversationActionsByMessageId?: Record<string, ConversationAction[]>;
  quota: QuotaState;
  updatedAt: number;
};

export function anonymizePsid(psid: string): string {
  return toUserKey(psid);
}

function getMessengerResponseWindowMs(): number {
  const configured = Number(process.env.MESSENGER_RESPONSE_WINDOW_MS);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return 24 * 60 * 60 * 1000;
}

export function getState(psid: string): MaybePromise<MessengerUserState | null> {
  return getPersistedState(psid);
}

export function clearUserState(psid: string): MaybePromise<void> {
  return deleteState(psid);
}

export function hasOpenMessengerResponseWindow(psid: string, now = Date.now()): MaybePromise<boolean> {
  const state = getState(psid);

  if (isPromiseLike(state)) {
    return state.then(current => {
      if (!current?.lastUserMessageAt) {
        return false;
      }

      return now - current.lastUserMessageAt <= getMessengerResponseWindowMs();
    });
  }

  if (!state?.lastUserMessageAt) {
    return false;
  }

  return now - state.lastUserMessageAt <= getMessengerResponseWindowMs();
}

export function getOrCreateState(psid: string): MaybePromise<MessengerUserState> {
  return getOrCreatePersistedState(psid);
}

export function setFlowState(psid: string, nextState: MessengerFlowState): MaybePromise<void> {
  const result = patchState(psid, {
    stage: nextState,
    state: nextState,
  });

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setPendingScreenshotIntentContinuation(
  psid: string,
  pending: boolean,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      pendingScreenshotIntentContinuation: pending ? true : undefined,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function clearPendingScreenshotIntentContinuation(
  psid: string,
  now = Date.now()
): MaybePromise<void> {
  return setPendingScreenshotIntentContinuation(psid, false, now);
}

export function setConsentState(
  psid: string,
  consentGiven: boolean,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      consentGiven,
      consentTimestamp: consentGiven ? now : undefined,
      pendingDeleteConfirm: false,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setPendingDeleteConfirm(
  psid: string,
  pendingDeleteConfirm: boolean,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      pendingDeleteConfirm,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setPendingImage(
  psid: string,
  imageUrl: string,
  now = Date.now(),
  source: SourceImageOrigin = "external"
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      lastPhotoUrl: imageUrl,
      lastPhoto: imageUrl,
      lastPhotoSource: source,
      lastImageUrl: undefined,
      lastGeneratedUrl: null,
      pendingImageUrl: imageUrl,
      pendingImageAt: now,
      stage: "AWAITING_EDIT_PROMPT",
      state: "AWAITING_EDIT_PROMPT",
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setPendingStoredImage(
  psid: string,
  imageUrl: string,
  now = Date.now()
): MaybePromise<void> {
  return setPendingImage(psid, imageUrl, now, "stored");
}

export function rememberFaceSourceImage(
  psid: string,
  imageUrl: string,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      faceMemoryConsent: { given: true, timestamp: now, version: "v1" },
      lastSourceImageUrl: imageUrl,
      lastSourceImageUpdatedAt: now,
      pendingSourceImageDeleteUrl: null,
      lastPhotoUrl: imageUrl,
      lastPhoto: imageUrl,
      lastPhotoSource: "stored",
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setFaceMemoryConsentGiven(
  psid: string,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      faceMemoryConsent: { given: true, timestamp: now, version: "v1" },
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function declineFaceMemory(psid: string, now = Date.now()): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      faceMemoryConsent: { given: false, timestamp: now, version: "v1" },
      lastSourceImageUrl: null,
      lastSourceImageUpdatedAt: null,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function clearFaceMemoryState(
  psid: string,
  now = Date.now(),
  pendingDeleteUrl: string | null = null
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      faceMemoryConsent: null,
      lastSourceImageUrl: null,
      lastSourceImageUpdatedAt: null,
      pendingSourceImageDeleteUrl: pendingDeleteUrl,
      lastPhotoUrl: null,
      lastPhoto: null,
      lastPhotoSource: null,
      pendingImageUrl: undefined,
      pendingImageAt: undefined,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setPendingSourceImageDeleteUrl(
  psid: string,
  pendingDeleteUrl: string,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      pendingSourceImageDeleteUrl: pendingDeleteUrl,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function clearPendingImageState(psid: string, now = Date.now()): MaybePromise<MessengerUserState> {
  return patchState(
    psid,
    {
      lastPhotoUrl: null,
      lastPhoto: null,
      lastPhotoSource: null,
      lastImageUrl: undefined,
      lastGeneratedUrl: null,
      pendingImageUrl: undefined,
      pendingImageAt: undefined,
      pendingScreenshotIntentContinuation: undefined,
    },
    now,
  );
}

export function setPreferredLang(psid: string, lang: Lang, now = Date.now()): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      preferredLang: lang,
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setLastUserMessageAt(psid: string, timestamp = Date.now()): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      lastUserMessageAt: timestamp,
    },
    timestamp,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function markIntroSeen(psid: string, now = Date.now()): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      hasSeenIntro: true,
      stage: "IDLE",
      state: "IDLE",
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setPendingConversationActions(
  psid: string,
  actions: ConversationAction[] | undefined,
  messageId?: string,
  now = Date.now()
): MaybePromise<void> {
  const currentState = getOrCreateState(psid);
  const currentByMessageId = isPromiseLike(currentState)
    ? undefined
    : currentState.pendingConversationActionsByMessageId;
  const nextByMessageId =
    actions?.length && messageId?.trim()
      ? prunePendingConversationActionsByMessageId({
          ...(currentByMessageId ?? {}),
          [messageId.trim()]: actions,
        })
      : currentByMessageId;
  const result = patchState(
    psid,
    {
      pendingConversationActions: actions?.length ? actions : undefined,
      pendingConversationActionsByMessageId: nextByMessageId,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function getPendingConversationActionsForMessage(
  state: MessengerUserState,
  messageId: string | undefined
): ConversationAction[] | undefined {
  const key = messageId?.trim();
  if (!key) {
    return undefined;
  }

  return state.pendingConversationActionsByMessageId?.[key];
}

function prunePendingConversationActionsByMessageId(
  actionsByMessageId: Record<string, ConversationAction[]>
): Record<string, ConversationAction[]> {
  const entries = Object.entries(actionsByMessageId).slice(-20);
  return Object.fromEntries(entries);
}

export function setLastGenerated(psid: string, resultImageUrl: string, now = Date.now()): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      lastImageUrl: resultImageUrl,
      lastGeneratedUrl: resultImageUrl,
      lastGeneratedAt: now,
      stage: "RESULT_READY",
      state: "RESULT_READY",
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setLastGenerationContext(
  psid: string,
  context: { prompt?: string },
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      lastPrompt: context.prompt,
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

function pruneOldState(): void {}

export function resetStateStore(): void {
  clearStateStore();
}
