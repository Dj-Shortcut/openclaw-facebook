import { toUserKey } from "./privacy";
import type { MessengerFlowState, MessengerUserState } from "./messengerState";

type PartialState = Partial<MessengerUserState>;
type LegacyConversationState = MessengerFlowState | "AWAITING_STYLE";

type StateNormalizationBase = {
  resolvedPsid: string;
  fallback: MessengerUserState;
};

type LegacyStateFields = {
  stage: MessengerFlowState;
  lastPhoto: string | null;
  lastGeneratedUrl: string | null | undefined;
};

type NormalizationCtx = {
  value: PartialState | null | undefined;
  fallback: MessengerUserState;
};

function looksLikeUserKey(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function getUserKey(psid: string): string {
  return looksLikeUserKey(psid) ? psid : toUserKey(psid);
}

export function getDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function createDefaultState(
  psid: string,
  now = Date.now()
): MessengerUserState {
  return {
    psid,
    userKey: getUserKey(psid),
    pageId: null,
    workspaceId: null,
    channelConnectionId: null,
    bindingEpoch: null,
    privacyEpoch: null,
    stage: "IDLE",
    state: "IDLE",
    lastUserMessageAt: undefined,
    lastPaidHandoffEligibleAt: undefined,
    lastPhotoUrl: null,
    lastPhoto: null,
    lastPhotoSource: null,
    preferredLang: undefined,
    preferredLangSource: undefined,
    consentGiven: false,
    consentTimestamp: undefined,
    consentDeclinedAt: undefined,
    consentPromptedAt: undefined,
    pendingDeleteConfirm: false,
    pendingDeleteConfirmAt: undefined,
    hasSeenIntro: false,
    pendingImageUrl: undefined,
    pendingImageAt: undefined,
    faceMemoryConsent: null,
    lastSourceImageUrl: null,
    lastSourceImageUpdatedAt: null,
    pendingSourceImageDeleteUrl: null,
    pendingSourceImageDeleteUrls: null,
    lastImageUrl: undefined,
    lastGeneratedUrl: null,
    lastPrompt: undefined,
    lastGeneratedAt: undefined,
    lastGeneratedVideoUrl: null,
    lastGeneratedVideoAt: null,
    lastGeneratedVideoProvider: null,
    lastGeneratedVideoProviderJobId: null,
    pendingVideoGeneration: null,
    lastVariantCursor: undefined,
    pendingConversationActions: undefined,
    pendingConversationActionsByMessageId: undefined,
    pendingEditIntent: null,
    quota: {
      dayKey: getDayKey(now),
      count: 0,
    },
    imageGenerationQuotaReservation: null,
    videoGenerationQuota: {
      dayKey: getDayKey(now),
      count: 0,
    },
    videoGenerationQuotaReservation: null,
    transcriptionQuota: {
      dayKey: getDayKey(now),
      count: 0,
    },
    updatedAt: now,
  };
}

export function normalizeState(
  psid: string,
  value: PartialState | null | undefined
): MessengerUserState {
  const base = createStateNormalizationBase(psid, value);
  const legacyFields = resolveLegacyStateFields(value, base.fallback);

  return applyNormalizedStateShape(value, base, legacyFields);
}

function createStateNormalizationBase(
  psid: string,
  value: PartialState | null | undefined
): StateNormalizationBase {
  const resolvedPsid = value?.psid ?? psid;
  const fallback = createDefaultState(resolvedPsid);
  return { resolvedPsid, fallback };
}

function resolveLegacyStateFields(
  value: PartialState | null | undefined,
  fallback: MessengerUserState
): LegacyStateFields {
  const rawStage = (value?.stage ??
    value?.state ??
    fallback.stage) as LegacyConversationState;
  const stage =
    rawStage === "AWAITING_STYLE" ? "AWAITING_EDIT_PROMPT" : rawStage;
  const lastPhoto =
    value?.lastPhotoUrl ?? value?.lastPhoto ?? fallback.lastPhoto;
  const lastGeneratedUrl =
    value?.lastGeneratedUrl ?? value?.lastImageUrl ?? fallback.lastGeneratedUrl;

  return { stage, lastPhoto, lastGeneratedUrl };
}

function resolveConsentState(
  ctx: NormalizationCtx
): Pick<
  MessengerUserState,
  | "consentGiven"
  | "consentTimestamp"
  | "consentDeclinedAt"
  | "consentPromptedAt"
  | "pendingDeleteConfirm"
  | "pendingDeleteConfirmAt"
  | "hasSeenIntro"
> {
  const { value, fallback } = ctx;
  const consentGiven = value?.consentGiven ?? fallback.consentGiven;
  const consentDeclinedAt =
    !consentGiven &&
    typeof value?.consentDeclinedAt === "number" &&
    Number.isFinite(value.consentDeclinedAt)
      ? value.consentDeclinedAt
      : undefined;
  const consentPromptedAt =
    typeof value?.consentPromptedAt === "number" &&
    Number.isFinite(value.consentPromptedAt)
      ? value.consentPromptedAt
      : undefined;
  const pendingDeleteConfirmAt =
    typeof value?.pendingDeleteConfirmAt === "number" &&
    Number.isFinite(value.pendingDeleteConfirmAt)
      ? value.pendingDeleteConfirmAt
      : undefined;
  const pendingDeleteConfirm =
    value?.pendingDeleteConfirm === true && pendingDeleteConfirmAt !== undefined;

  return {
    consentGiven,
    consentTimestamp: value?.consentTimestamp ?? fallback.consentTimestamp,
    consentDeclinedAt,
    consentPromptedAt,
    pendingDeleteConfirm,
    pendingDeleteConfirmAt: pendingDeleteConfirm
      ? pendingDeleteConfirmAt
      : undefined,
    hasSeenIntro: value?.hasSeenIntro ?? fallback.hasSeenIntro,
  };
}

function resolveConversationContext(
  ctx: NormalizationCtx
): Pick<MessengerUserState, "lastUserMessageAt" | "lastPaidHandoffEligibleAt"> {
  const { value, fallback } = ctx;

  return {
    lastUserMessageAt: value?.lastUserMessageAt ?? fallback.lastUserMessageAt,
    lastPaidHandoffEligibleAt:
      value?.lastPaidHandoffEligibleAt ?? fallback.lastPaidHandoffEligibleAt,
  };
}

function resolveLanguageState(
  ctx: NormalizationCtx
): Pick<MessengerUserState, "preferredLang" | "preferredLangSource"> {
  const preferredLang =
    ctx.value?.preferredLang === "nl" || ctx.value?.preferredLang === "en"
      ? ctx.value.preferredLang
      : undefined;
  const storedSource = ctx.value?.preferredLangSource;
  if (storedSource === "account_default" || storedSource === "sender_locale") {
    return { preferredLang, preferredLangSource: storedSource };
  }
  if (preferredLang === "en") {
    return { preferredLang, preferredLangSource: "sender_locale" };
  }
  if (preferredLang === "nl") {
    return { preferredLang, preferredLangSource: "account_default" };
  }
  return { preferredLang: undefined, preferredLangSource: undefined };
}

function resolvePhotoAndStyleState(
  ctx: NormalizationCtx,
  legacyFields: Pick<LegacyStateFields, "lastPhoto">
): Pick<MessengerUserState, "lastPhotoUrl" | "lastPhoto" | "lastPhotoSource"> {
  const { value, fallback } = ctx;
  const { lastPhoto } = legacyFields;

  return {
    lastPhotoUrl: lastPhoto,
    lastPhoto,
    lastPhotoSource: value?.lastPhotoSource ?? fallback.lastPhotoSource,
  };
}

function resolveGeneratedImageState(
  ctx: NormalizationCtx,
  lastGeneratedUrl: LegacyStateFields["lastGeneratedUrl"]
): Pick<MessengerUserState, "lastImageUrl" | "lastGeneratedUrl"> {
  const { value, fallback } = ctx;

  return {
    lastImageUrl:
      value?.lastImageUrl ?? lastGeneratedUrl ?? fallback.lastImageUrl,
    lastGeneratedUrl,
  };
}

function resolveSourceImageState(
  ctx: NormalizationCtx
): Pick<
  MessengerUserState,
  | "faceMemoryConsent"
  | "lastSourceImageUrl"
  | "lastSourceImageUpdatedAt"
  | "pendingSourceImageDeleteUrl"
  | "pendingSourceImageDeleteUrls"
> {
  const { value, fallback } = ctx;

  return {
    faceMemoryConsent: value?.faceMemoryConsent ?? fallback.faceMemoryConsent,
    lastSourceImageUrl:
      value?.lastSourceImageUrl ?? fallback.lastSourceImageUrl,
    lastSourceImageUpdatedAt:
      value?.lastSourceImageUpdatedAt ?? fallback.lastSourceImageUpdatedAt,
    pendingSourceImageDeleteUrl:
      value?.pendingSourceImageDeleteUrl ??
      fallback.pendingSourceImageDeleteUrl,
    pendingSourceImageDeleteUrls:
      value?.pendingSourceImageDeleteUrls ??
      fallback.pendingSourceImageDeleteUrls,
  };
}

function resolveQuotaState(ctx: NormalizationCtx): MessengerUserState["quota"] {
  const { value, fallback } = ctx;

  return {
    dayKey: value?.quota?.dayKey ?? fallback.quota.dayKey,
    count: value?.quota?.count ?? fallback.quota.count,
  };
}

function resolveImageGenerationQuotaReservation(
  ctx: NormalizationCtx
): MessengerUserState["imageGenerationQuotaReservation"] {
  const reservation = ctx.value?.imageGenerationQuotaReservation;
  if (
    reservation &&
    typeof reservation.token === "string" &&
    reservation.token.length > 0 &&
    Number.isFinite(reservation.expiresAt)
  ) {
    return {
      token: reservation.token,
      expiresAt: reservation.expiresAt,
    };
  }

  return ctx.fallback.imageGenerationQuotaReservation;
}

function resolveVideoGenerationQuotaState(
  ctx: NormalizationCtx
): MessengerUserState["videoGenerationQuota"] {
  const { value, fallback } = ctx;

  return {
    dayKey:
      value?.videoGenerationQuota?.dayKey ??
      fallback.videoGenerationQuota.dayKey,
    count:
      value?.videoGenerationQuota?.count ?? fallback.videoGenerationQuota.count,
  };
}

function resolveVideoGenerationQuotaReservation(
  ctx: NormalizationCtx
): MessengerUserState["videoGenerationQuotaReservation"] {
  const reservation = ctx.value?.videoGenerationQuotaReservation;
  if (
    reservation &&
    typeof reservation.token === "string" &&
    reservation.token.length > 0 &&
    Number.isFinite(reservation.expiresAt)
  ) {
    return {
      token: reservation.token,
      expiresAt: reservation.expiresAt,
      ...(Number.isSafeInteger(reservation.dailyLimit) &&
      Number(reservation.dailyLimit) >= 0
        ? { dailyLimit: Number(reservation.dailyLimit) }
        : {}),
    };
  }

  return ctx.fallback.videoGenerationQuotaReservation;
}

function resolveTranscriptionQuotaState(
  ctx: NormalizationCtx
): MessengerUserState["transcriptionQuota"] {
  const { value, fallback } = ctx;

  return {
    dayKey:
      value?.transcriptionQuota?.dayKey ?? fallback.transcriptionQuota.dayKey,
    count:
      value?.transcriptionQuota?.count ?? fallback.transcriptionQuota.count,
  };
}

function resolvePendingEditIntent(
  ctx: NormalizationCtx
): Pick<MessengerUserState, "pendingEditIntent"> {
  const { value, fallback } = ctx;

  return {
    pendingEditIntent: value?.pendingEditIntent ?? fallback.pendingEditIntent,
  };
}

function resolvePendingVideoGeneration(
  ctx: NormalizationCtx
): Pick<MessengerUserState, "pendingVideoGeneration"> {
  const pending = ctx.value?.pendingVideoGeneration;
  if (
    pending &&
    typeof pending.sourceImageUrl === "string" &&
    typeof pending.promptHint === "string" &&
    typeof pending.requestedAt === "number" &&
    Number.isFinite(pending.requestedAt)
  ) {
    return { pendingVideoGeneration: pending };
  }
  return { pendingVideoGeneration: null };
}

function applyNormalizedStateShape(
  value: PartialState | null | undefined,
  base: StateNormalizationBase,
  legacyFields: LegacyStateFields
): MessengerUserState {
  const { resolvedPsid, fallback } = base;
  const { stage, lastPhoto, lastGeneratedUrl } = legacyFields;
  const ctx: NormalizationCtx = { value, fallback };

  return {
    ...fallback,
    ...value,
    psid: resolvedPsid,
    userKey: getUserKey(value?.userKey ?? fallback.userKey),
    pageId: value?.pageId ?? fallback.pageId,
    ...resolveConsentState(ctx),
    stage,
    state: stage,
    ...resolveConversationContext(ctx),
    ...resolveLanguageState(ctx),
    ...resolvePhotoAndStyleState(ctx, { lastPhoto }),
    ...resolveGeneratedImageState(ctx, lastGeneratedUrl),
    ...resolveSourceImageState(ctx),
    ...resolvePendingEditIntent(ctx),
    ...resolvePendingVideoGeneration(ctx),
    quota: resolveQuotaState(ctx),
    imageGenerationQuotaReservation:
      resolveImageGenerationQuotaReservation(ctx),
    videoGenerationQuota: resolveVideoGenerationQuotaState(ctx),
    videoGenerationQuotaReservation:
      resolveVideoGenerationQuotaReservation(ctx),
    transcriptionQuota: resolveTranscriptionQuotaState(ctx),
    updatedAt: value?.updatedAt ?? fallback.updatedAt,
  };
}
