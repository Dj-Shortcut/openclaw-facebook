import type { Style, StyleCategory } from "./messengerStyles";
import {
  STYLE_CATEGORY_CONFIGS,
  getStylesForCategory,
} from "./messengerStyles";
import type { ActiveExperience } from "./activeExperience";
import type { EntryIntent } from "./entryIntent";
import type { DirectorMode } from "./image-generation/director/directorTypes";
import type { Lang } from "./i18n";
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
  | "AWAITING_STYLE"
  | "PROCESSING"
  | "RESULT_READY"
  | "FAILURE";
export type MessengerFlowState = ConversationState;

export type StateQuickReply = {
  title: string;
  payload: string;
};

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
  lastEntryIntent?: EntryIntent | null;
  activeExperience?: ActiveExperience | null;
  lastUserMessageAt?: number;
  lastPhotoUrl: string | null;
  lastPhoto: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
  selectedStyle: string | null;
  chosenStyle: string | null;
  selectedStyleCategory?: StyleCategory | "director" | null;
  preselectedStyle?: string | null;
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
  lastImageUrl?: string;
  lastGeneratedUrl?: string | null;
  lastStyle?: Style;
  lastDirectorMode?: DirectorMode;
  lastPrompt?: string;
  lastGeneratedAt?: number;
  lastVariantCursor?: number;
  quota: QuotaState;
  updatedAt: number;
};

const QUICK_REPLIES_BY_STATE: Record<ConversationState, StateQuickReply[]> = {
  IDLE: [
    { title: "Wat doe ik?", payload: "WHAT_IS_THIS" },
    { title: "Privacy", payload: "PRIVACY_INFO" },
  ],
  AWAITING_PHOTO: [],
  AWAITING_STYLE: STYLE_CATEGORY_CONFIGS.map(category => ({
    title: category.label,
    payload: category.payload,
  })),
  PROCESSING: [],
  RESULT_READY: [
    { title: "Nieuwe stijl", payload: "CHOOSE_STYLE" },
    { title: "Privacy", payload: "PRIVACY_INFO" },
  ],
  FAILURE: [
    { title: "Probeer opnieuw", payload: "RETRY_STYLE" },
    { title: "Andere stijl", payload: "CHOOSE_STYLE" },
  ],
};

export function getQuickRepliesForState(state: ConversationState): StateQuickReply[] {
  return QUICK_REPLIES_BY_STATE[state];
}

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

export function setLastEntryIntent(
  psid: string,
  entryIntent: EntryIntent | null,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      lastEntryIntent: entryIntent,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setActiveExperience(
  psid: string,
  activeExperience: ActiveExperience | null,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      activeExperience,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

function clearActiveExperience(
  psid: string,
  now = Date.now()
): MaybePromise<void> {
  return setActiveExperience(psid, null, now);
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
      pendingImageUrl: imageUrl,
      pendingImageAt: now,
      stage: "AWAITING_STYLE",
      state: "AWAITING_STYLE",
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
      pendingImageUrl: undefined,
      pendingImageAt: undefined,
      selectedStyle: null,
      chosenStyle: null,
      selectedStyleCategory: null,
    },
    now,
  );
}

export function setPreselectedStyle(psid: string, style: string | null, now = Date.now()): MaybePromise<MessengerUserState> {
  return patchState(
    psid,
    {
      preselectedStyle: style,
    },
    now,
  );
}

export function setChosenStyle(psid: string, style: string, now = Date.now()): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      selectedStyle: style,
      chosenStyle: style,
      selectedStyleCategory: null,
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function setSelectedStyleCategory(
  psid: string,
  category: StyleCategory | "director" | null,
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      selectedStyleCategory: category,
    },
    now
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
}

export function getStyleRepliesForCategory(category: StyleCategory): StateQuickReply[] {
  return [
    ...getStylesForCategory(category).map(style => ({
      title: style.label,
      payload: style.payload,
    })),
    {
      title: "↩️ Categorieen",
      payload: "CHOOSE_STYLE",
    },
  ];
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
      stage: "AWAITING_PHOTO",
      state: "AWAITING_PHOTO",
    },
    now,
  );

  if (isPromiseLike(result)) {
    return result.then(() => undefined);
  }
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
  context: { style?: Style; directorMode?: DirectorMode; prompt?: string },
  now = Date.now()
): MaybePromise<void> {
  const result = patchState(
    psid,
    {
      lastStyle: context.style,
      lastDirectorMode: context.directorMode,
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
