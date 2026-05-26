import {
  sendButtonTemplate,
  sendGenericTemplate,
  sendImage,
  sendQuickReplies,
  sendText,
  safeLog,
} from "./messengerApi";
import type { MessengerSendOutcome } from "./messengerApi";
import { getGenerationMetrics } from "./image-generation/openAiImageClient";
import { getConfiguredBaseUrl } from "./image-generation/imageServiceConfig";
import { executeGenerationFlow } from "./generationFlow";
import {
  clearPendingImageState,
  getOrCreateState,
  setChosenStyle,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
  setLastEntryIntent,
  setPendingStoredImage,
  setPreselectedStyle,
  setPreferredLang,
  setActiveExperience,
  setLastUserMessageAt,
  markIntroSeen,
  anonymizePsid,
  type ConversationState,
} from "./messengerState";
import { recordInboundUserActivity } from "./messengerInboundActivity";
import { classifyInboundEvent } from "./messengerInboundClassification";
import {
  FACE_MEMORY_CONSENT_NO,
  FACE_MEMORY_CONSENT_YES,
  isFaceMemoryEnabled,
  updateConsentedFaceMemorySource,
} from "./faceMemory";
import { handleMessengerConsentGate } from "./consentService";
import { normalizeLang, t, type Lang } from "./i18n";
import { toLogUser, toUserKey } from "./privacy";
import {
  getStoredMessengerImageDecision,
  normalizeMessengerInboundImage,
} from "./messengerImageIngress";
import {
  getStylesForCategory,
  type Style,
  type StyleCategory,
} from "./messengerStyles";
import { claimWebhookReplayKey } from "./webhookReplayProtection";
import {
  type FacebookWebhookEntry,
  FacebookWebhookEvent,
  getEventDedupeKey,
  getGreetingResponse,
  parseReferralStyle,
  parseStyle,
  STYLE_CATEGORY_LABELS,
  STYLE_LABELS,
  STYLE_OPTIONS,
  toMessengerReplies,
  toMessengerStyleReplies,
} from "./webhookHelpers";
import { hasInFlightGeneration, runGuardedGeneration } from "./generationGuard";
import { canGenerate, increment } from "./messengerQuota";
import { isDebugLogEnabled } from "./logLevel";
import { getBotFeatures } from "./bot/features";
import { ensureDefaultBotFeaturesRegistered } from "./bot/defaultFeatures";
import { handleSharedTextMessage } from "./sharedTextHandler";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";
import { sendMessengerBotResponse } from "./botResponseAdapters";
import {
  parseMessengerEntryIntent,
  routeMessengerActiveExperience,
  routeMessengerEntryIntent,
} from "./messengerExperienceRouting";
import type { EntryIntent } from "./entryIntent";
import type { ActiveExperience } from "./activeExperience";
import {
  getTodayRuntimeStats,
  recordActiveUserToday,
  recordGenerationError,
  recordGenerationSuccess,
} from "./botRuntimeStats";
import { captureException } from "./observability/sentry";
import type {
  BotLogger,
  BotPayloadContext,
  BotTextContext,
  BotImageContext,
} from "./botContext";
import type { DirectorMode } from "./image-generation/director/directorTypes";
import { createTrackedHandlerContext } from "./webhookTrackedContext";
import {
  handlePayload,
  handlePostbackEvent,
} from "./webhookPayloadBranch";

type HandlerDeps = {
  defaultLang: Lang;
  privacyPolicyUrl: string;
};

type InternalMessengerImageRequestInput = {
  psid: string;
  prompt: string;
  reqId: string;
  lang?: Lang;
  style?: Style;
  timestamp?: number;
};

type FacebookWebhookMessage = NonNullable<FacebookWebhookEvent["message"]>;
type FeatureContextBase = Omit<
  BotPayloadContext,
  "payload"
>;
type MessengerState = Awaited<ReturnType<typeof getOrCreateState>>;
const MESSENGER_SEND_SKIPPED: MessengerSendOutcome = {
  sent: false,
  reason: "response_window_closed",
};
type MaybeInFlightMessageResult =
  | { handled: false }
  | { handled: true; outcome?: MessengerSendOutcome };

type TrackedEventContext = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  localeLang: Lang;
  senderLocale?: string;
  state: MessengerState;
  classification: ReturnType<typeof classifyInboundEvent>;
  responseSent: () => boolean;
  markResponseSentFromOutcome: (
    outcome: MessengerSendOutcome | undefined
  ) => void;
  sendFallbackIfNeeded: () => Promise<void>;
  trackedCtx: HandlerContext;
};

function combineMessengerSendOutcomes(
  ...outcomes: MessengerSendOutcome[]
): MessengerSendOutcome {
  return outcomes.some(outcome => outcome.sent)
    ? { sent: true }
    : MESSENGER_SEND_SKIPPED;
}

function normalizeImageRequestText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function inferStyleFromImageRequest(text: string): Style {
  const direct = parseStyle(text);
  if (direct) {
    return direct;
  }

  const normalized = normalizeImageRequestText(text);
  for (const style of STYLE_OPTIONS) {
    const styleLabel = normalizeImageRequestText(STYLE_LABELS[style]);
    const styleId = normalizeImageRequestText(style);
    if (normalized.includes(styleLabel) || normalized.includes(styleId)) {
      return style;
    }
  }

  if (/\b(cyber|neon|future|futuristisch)\b/.test(normalized)) {
    return "cyberpunk";
  }
  if (/\b(cinema|cinematic|film|movie|dramatisch)\b/.test(normalized)) {
    return "cinematic";
  }
  if (/\b(olie|oil|painting|schilderij)\b/.test(normalized)) {
    return "oil-paint";
  }
  if (/\b(gold|goud|luxury|luxe)\b/.test(normalized)) {
    return "gold";
  }
  if (/\b(disco|glow|party)\b/.test(normalized)) {
    return "disco";
  }
  if (/\b(wolk|cloud|clouds|hemel)\b/.test(normalized)) {
    return "clouds";
  }
  if (/\b(caricature|karikatuur)\b/.test(normalized)) {
    return "caricature";
  }

  return "storybook-anime";
}

export type HandlerContext = {
  defaultLang: Lang;
  claimEventReplayOrLog: (
    event: FacebookWebhookEvent,
    entryId: string | undefined,
    userId: string
  ) => Promise<boolean>;
  createFeatureImageContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState,
    imageUrl: string
  ) => BotImageContext;
  createFeaturePayloadContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState,
    payload: string
  ) => BotPayloadContext;
  createFeatureTextContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState,
    messageText: string,
    normalizedText: string,
    hasPhoto: boolean
  ) => BotTextContext;
  debugWebhookLog: (message: Record<string, unknown>) => void;
  getAttachmentHostname: (url: string) => string | null;
  handleStyleSelection: (
    psid: string,
    userId: string,
    selectedStyle: Style,
    reqId: string,
    lang: Lang
  ) => Promise<MessengerSendOutcome>;
  handleReferralStyleEvent: (
    psid: string,
    referralRef: string | undefined,
    lang: Lang,
    reqId: string
  ) => Promise<MaybeInFlightMessageResult>;
  logImageFlowDecision: (input: {
    psid: string;
    userId: string;
    reqId: string;
    stage: string;
    hadPreviousPhoto: boolean;
    incomingImageUrl: string;
    selectedStyle: string | null;
    preselectedStyle: string | null;
    action: "show_style_picker" | "auto_run_preselected_style";
  }) => void;
  logIncomingMessage: (
    psid: string,
    userId: string,
    event: FacebookWebhookEvent,
    reqId: string
  ) => void;
  logUserState: (
    psid: string,
    userId: string,
    state: MessengerState,
    reqId: string,
    context: string
  ) => void;
  maybeSendInFlightMessage: (
    psid: string,
    reqId: string
  ) => Promise<MaybeInFlightMessageResult>;
  runStyleGeneration: (
    psid: string,
    userId: string,
    style: Style,
    reqId: string,
    lang: Lang,
    sourceImageUrl?: string,
    promptHint?: string,
    directorMode?: DirectorMode
  ) => Promise<MessengerSendOutcome>;
  sendFaceMemoryConsentPrompt: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendFlowExplanation: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedImage: (
    psid: string,
    imageUrl: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedQuickReplies: (
    psid: string,
    text: string,
    quickReplies: Array<{
      content_type: "text";
      title: string;
      payload: string;
    }>,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedText: (
    psid: string,
    text: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendPhotoReceivedPrompt: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendPrivacyInfo: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendStateQuickReplies: (
    psid: string,
    stateName: ConversationState,
    text: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendStyleOptionsForCategory: (
    psid: string,
    category: StyleCategory,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendStylePicker: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
};

type MessageEventInput = {
  psid: string;
  userId: string;
  event: FacebookWebhookEvent;
  reqId: string;
  lang: Lang;
};

type ImageMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  attachments: FacebookWebhookMessage["attachments"];
};

type TextMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  text: string;
  timestamp?: number;
};

const IN_FLIGHT_MESSAGE =
  "\u23F3 even geduld, ik ben nog bezig met jouw restyle";
const inFlightNoticeSent = new Set();
const MESSENGER_CAPABILITIES = Object.freeze({
  quickReplies: true,
  richTemplates: true,
});

function logMessengerWebhookTrace(
  stage:
    | "webhook_received"
    | "selected_branch"
    | "before_send"
    | "after_send"
    | "top_level_catch",
  details: Record<string, unknown>
): void {
  safeLog("messenger_response_window_trace", { stage, ...details });
}

async function handleEntry(
  ctx: HandlerContext,
  entry: FacebookWebhookEntry
): Promise<void> {
  const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
  for (const event of events) {
    await handleEvent(ctx, event, entry?.id);
  }
}

async function createTrackedEventContext(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<TrackedEventContext | null> {
  const psid = event.sender?.id;
  if (!psid) return null;

  const userId = toUserKey(psid);
  const reqId = `${psid}-${Date.now()}`;
  let responseSent = false;
  const markResponseSent = () => {
    responseSent = true;
  };
  const markResponseSentFromOutcome = (
    outcome: MessengerSendOutcome | undefined
  ) => {
    if (outcome?.sent) {
      markResponseSent();
    }
  };
  const trackedCtx = createTrackedHandlerContext(ctx, markResponseSentFromOutcome);

  if (!(await ctx.claimEventReplayOrLog(event, entryId, userId))) {
    return null;
  }

  recordActiveUserToday(userId);
  const senderLocale = event.sender?.locale?.trim();
  const localeLang = senderLocale
    ? normalizeLang(senderLocale)
    : ctx.defaultLang;
  const state = await getOrCreateState(psid);
  const lang = state.preferredLang || localeLang || ctx.defaultLang;
  const classification = classifyInboundEvent(event);
  await recordInboundUserActivity(psid, event, classification);
  const sendFallbackIfNeeded = async () => {
    if (
      classification.isInboundUserEvent &&
      !classification.isIntentionalSilentAck &&
      !classification.isIntentionalSilentUnknownPayload &&
      !responseSent
    ) {
      await trackedCtx.sendLoggedText(psid, t(lang, "failure"), reqId);
    }
  };

  return {
    psid,
    userId,
    reqId,
    lang,
    localeLang,
    senderLocale,
    state,
    classification,
    responseSent: () => responseSent,
    markResponseSentFromOutcome,
    sendFallbackIfNeeded,
    trackedCtx,
  };
}

async function handleEvent(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<void> {
  const eventContext = await createTrackedEventContext(ctx, event, entryId);
  if (!eventContext) return;

  const { psid, userId, reqId, state, trackedCtx } = eventContext;

  logMessengerWebhookTrace("webhook_received", {
    reqId,
    user: toLogUser(userId),
    entryId,
    hasMessage: Boolean(event.message),
    hasPostback: Boolean(event.postback),
    isEcho: Boolean(event.message?.is_echo),
  });

  try {
    trackedCtx.logIncomingMessage(psid, userId, event, reqId);
    trackedCtx.logUserState(psid, userId, state, reqId, "handle_event");

    if (
      eventContext.senderLocale &&
      eventContext.localeLang !== state.preferredLang
    ) {
      await setPreferredLang(psid, eventContext.localeLang);
    }

    await routeTrackedEvent(eventContext, event);
  } catch (error) {
    logMessengerWebhookTrace("top_level_catch", {
      reqId,
      user: toLogUser(userId),
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
    captureException(error, {
      area: "webhook",
      eventType: event.postback ? "postback" : event.message ? "message" : "unknown",
      hasImage: Boolean(
        event.message?.attachments?.some(attachment => attachment.type === "image")
      ),
      hasText: Boolean(event.message?.text),
    });
    await eventContext.sendFallbackIfNeeded();
    throw error;
  }

  await eventContext.sendFallbackIfNeeded();
}

async function routeTrackedEvent(
  context: TrackedEventContext,
  event: FacebookWebhookEvent
): Promise<void> {
  const { psid, userId, reqId, lang, localeLang, state, trackedCtx } = context;
  if (await routeConsentGate(context, event)) return;

  const routeDeps = createMessengerRouteDeps(context);
  const { referralRef, entryIntent } = parseMessengerEntryIntent({
    event,
    reqId,
    userId,
    localeLang,
    safeLog,
  });

  if (
    await routeMessengerEntryIntent({
      deps: routeDeps,
      state,
      entryIntent,
    })
  ) {
    await finishSelectedBranch(context, "entry_intent");
    return;
  }

  if (
    await routeMessengerActiveExperience({
      deps: routeDeps,
      state,
      event,
    })
  ) {
    await finishSelectedBranch(context, "active_experience");
    return;
  }

  const referralResult = await trackedCtx.handleReferralStyleEvent(
    psid,
    referralRef,
    lang,
    reqId
  );
  if (referralResult.handled) {
    context.markResponseSentFromOutcome(referralResult.outcome);
    await finishSelectedBranch(context, "referral");
    return;
  }

  if (
    await handlePostbackEvent(trackedCtx, {
      psid,
      userId,
      event,
      reqId,
      lang,
    })
  ) {
    await finishSelectedBranch(context, "postback");
    return;
  }

  await handleMessageEvent(trackedCtx, { psid, userId, event, reqId, lang });
  await finishSelectedBranch(context, "message");
}

async function routeConsentGate(
  context: TrackedEventContext,
  event: FacebookWebhookEvent
): Promise<boolean> {
  const { psid, lang, reqId, state, classification, trackedCtx } = context;
  if (!classification.isInboundUserEvent) {
    return false;
  }

  const handled = await handleMessengerConsentGate({
    psid,
    lang,
    text: event.message?.text,
    payload: classification.eventPayload,
    state,
    sendText: async text => {
      await trackedCtx.sendLoggedText(psid, text, reqId);
    },
    sendQuickReplies: async (text, replies) => {
      await trackedCtx.sendLoggedQuickReplies(psid, text, replies, reqId);
    },
    sendRestyleStarterPills: async () => {
      await setFlowState(psid, "AWAITING_STYLE");
      await trackedCtx.sendStylePicker(psid, lang, reqId);
    },
  });

  if (handled) {
    await finishSelectedBranch(context, "consent_gate");
  }

  return handled;
}

function createMessengerRouteDeps(context: TrackedEventContext) {
  const { psid, userId, reqId, trackedCtx } = context;
  return {
    psid,
    userId,
    reqId,
    sendText: async (text: string) => {
      await trackedCtx.sendLoggedText(psid, text, reqId);
    },
    sendStateText: async (stateName: ConversationState, text: string) => {
      await trackedCtx.sendStateQuickReplies(psid, stateName, text, reqId);
    },
    sendOptionsPrompt: async (
      prompt: string,
      options: Array<{ id: string; title: string }>
    ) => {
      await trackedCtx.sendLoggedQuickReplies(
        psid,
        prompt,
        options.map(option => ({
          content_type: "text",
          title: option.title,
          payload: option.id,
        })),
        reqId
      );
    },
    sendImage: async (imageUrl: string) => {
      await trackedCtx.sendLoggedImage(psid, imageUrl, reqId);
    },
    safeLog,
    setLastEntryIntent: (nextEntryIntent: EntryIntent | null) =>
      Promise.resolve(setLastEntryIntent(psid, nextEntryIntent)),
    setActiveExperience: (nextActiveExperience: ActiveExperience | null) =>
      Promise.resolve(setActiveExperience(psid, nextActiveExperience)),
  };
}

async function finishSelectedBranch(
  context: TrackedEventContext,
  branch: string
): Promise<void> {
  logMessengerWebhookTrace("selected_branch", {
    reqId: context.reqId,
    user: toLogUser(context.userId),
    branch,
    responseSent: context.responseSent(),
  });
  await context.sendFallbackIfNeeded();
}

async function handleMessageEvent(
  ctx: HandlerContext,
  input: MessageEventInput
): Promise<void> {
  const message = input.event.message;
  if (!message || message.is_echo) return;

  if ((await ctx.maybeSendInFlightMessage(input.psid, input.reqId)).handled) {
    return;
  }

  const quickPayload = message.quick_reply?.payload;
  if (quickPayload) {
    await handlePayload(ctx, {
      psid: input.psid,
      userId: input.userId,
      payload: quickPayload,
      reqId: input.reqId,
      lang: input.lang,
    });
    return;
  }

  if (
    await tryHandleImageMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      attachments: message.attachments,
    })
  ) {
    return;
  }

  const text = message.text;
  const trimmedText = text?.trim();
  if (!trimmedText) {
    return;
  }

  await handleTextMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    text: trimmedText,
    timestamp: input.event.timestamp ?? Date.now(),
  });
}

async function tryHandleImageMessage(
  ctx: HandlerContext,
  input: ImageMessageInput
): Promise<boolean> {
  const imageAttachment = input.attachments?.find(
    att => att.type === "image" && att.payload?.url
  );
  if (!imageAttachment?.payload?.url) {
    return false;
  }

  const inboundImageUrl = imageAttachment.payload.url;
  ctx.debugWebhookLog({
    level: "debug",
    msg: "photo_received",
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    hasAttachments: !!input.attachments,
    attachmentHostname: ctx.getAttachmentHostname(inboundImageUrl),
  });

  const storedSourceImageUrl = await normalizeMessengerInboundImage({
    inboundImageUrl,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    reqId: input.reqId,
  });
  if (!storedSourceImageUrl) {
    await clearPendingImageState(input.psid);
    await setFlowState(input.psid, "AWAITING_PHOTO");
    await ctx.sendLoggedText(
      input.psid,
      t(input.lang, "missingInputImage"),
      input.reqId
    );
    return true;
  }

  const state = await getOrCreateState(input.psid);
  for (const feature of getBotFeatures()) {
    const result = await feature.onImage?.(
      ctx.createFeatureImageContext(
        input.psid,
        input.userId,
        input.reqId,
        input.lang,
        state,
        storedSourceImageUrl
      )
    );
    if (result?.handled) {
      return true;
    }
  }

  ctx.logUserState(input.psid, input.userId, state, input.reqId, "image_received");
  const imageDecision = getStoredMessengerImageDecision({
    lastPhotoUrl: state.lastPhotoUrl,
    preselectedStyle: state.preselectedStyle,
    storedSourceImageUrl,
  });
  await setPendingStoredImage(input.psid, storedSourceImageUrl);
  if (isFaceMemoryEnabled()) {
    if (state.faceMemoryConsent?.given) {
      await updateConsentedFaceMemorySource(input.psid, storedSourceImageUrl);
    } else if (!state.faceMemoryConsent) {
      if (imageDecision.action === "show_style_picker") {
        await setPreselectedStyle(input.psid, null);
      }
      await ctx.sendFaceMemoryConsentPrompt(input.psid, input.lang, input.reqId);
      return true;
    }
  }

  ctx.logImageFlowDecision({
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    stage: state.stage,
    hadPreviousPhoto: imageDecision.hadPreviousPhoto,
    incomingImageUrl: imageDecision.incomingImageUrl,
    selectedStyle: state.selectedStyle,
    preselectedStyle: imageDecision.preselectedStyle,
    action: imageDecision.action,
  });

  if (imageDecision.action === "auto_run_preselected_style") {
    await setPreselectedStyle(input.psid, null);
    await setChosenStyle(input.psid, imageDecision.preselectedStyle);
    await ctx.runStyleGeneration(
      input.psid,
      input.userId,
      imageDecision.preselectedStyle,
      input.reqId,
      input.lang
    );
    return true;
  }

  await setFlowState(input.psid, "AWAITING_STYLE");
  await ctx.sendPhotoReceivedPrompt(input.psid, input.lang, input.reqId);
  return true;
}

async function handleTextMessage(
  ctx: HandlerContext,
  input: TextMessageInput
): Promise<void> {
  const normalizedMessage = createNormalizedTextMessage(input);
  logNormalizedTextHandoff(input, normalizedMessage);

  const result = await handleSharedMessengerText(ctx, input, normalizedMessage);
  await sendSharedMessengerTextResponse(ctx, input, result);
  await applyTextAfterSend(result, input);
}

function createNormalizedTextMessage(
  input: TextMessageInput
): NormalizedInboundMessage {
  return {
    channel: "messenger",
    senderId: input.psid,
    userId: input.userId,
    messageType: "text",
    textBody: input.text,
    timestamp: input.timestamp ?? Date.now(),
  };
}

function logNormalizedTextHandoff(
  input: TextMessageInput,
  normalizedMessage: NormalizedInboundMessage
): void {
  console.log("[messenger webhook] normalized event handoff", {
    channel: normalizedMessage.channel,
    reqId: input.reqId,
    user: toLogUser(input.userId),
    messageType: normalizedMessage.messageType,
  });
}

async function handleSharedMessengerText(
  ctx: HandlerContext,
  input: TextMessageInput,
  normalizedMessage: NormalizedInboundMessage
) {
  return await handleSharedTextMessage({
    message: normalizedMessage,
    reqId: input.reqId,
    lang: input.lang,
    getState: () => Promise.resolve(getOrCreateState(input.psid)),
    setFlowState: nextState =>
      Promise.resolve(setFlowState(input.psid, nextState)),
    runTextFeatures: async ({
      state,
      messageText,
      normalizedText,
      hasPhoto,
    }) => {
      for (const feature of getBotFeatures()) {
        const result = await feature.onText?.(
          ctx.createFeatureTextContext(
            input.psid,
            input.userId,
            input.reqId,
            input.lang,
            state,
            messageText,
            normalizedText,
            hasPhoto
          )
        );
        if (result?.handled) {
          return true;
        }
      }

      return false;
    },
    logState: (state, context) => {
      ctx.logUserState(input.psid, input.userId, state, input.reqId, context);
    },
    logAckIgnored: ack => {
      safeLog("ack_ignored", { ack });
    },
  });
}

async function sendSharedMessengerTextResponse(
  ctx: HandlerContext,
  input: TextMessageInput,
  result: Awaited<ReturnType<typeof handleSharedMessengerText>>
): Promise<void> {
  await sendMessengerBotResponse(result.response, {
    replyState: result.replyState,
    sendText: async text => {
      await ctx.sendLoggedText(input.psid, text, input.reqId);
    },
    sendStateText: async (stateName, text) => {
      await ctx.sendStateQuickReplies(input.psid, stateName, text, input.reqId);
    },
  });
}

async function applyTextAfterSend(
  result: Awaited<ReturnType<typeof handleSharedMessengerText>>,
  input: TextMessageInput
): Promise<void> {
  if (result.afterSend === "markIntroSeen") {
    await Promise.resolve(markIntroSeen(input.psid));
  }
}

export function createWebhookHandlers({
  defaultLang,
  privacyPolicyUrl,
}: HandlerDeps) {
  ensureDefaultBotFeaturesRegistered();

  function debugWebhookLog(message: Record<string, unknown>): void {
    if (!isDebugLogEnabled()) {
      return;
    }

    console.log(JSON.stringify(message));
  }

  function getAttachmentHostname(url: string): string | null {
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  }

  async function maybeSendInFlightMessage(
    psid: string,
    reqId: string
  ): Promise<MaybeInFlightMessageResult> {
    if (!(await hasInFlightGeneration(psid))) {
      inFlightNoticeSent.delete(psid);
      return { handled: false };
    }

    if (inFlightNoticeSent.has(psid)) {
      return { handled: true };
    }

    inFlightNoticeSent.add(psid);
    const outcome = await sendLoggedText(psid, IN_FLIGHT_MESSAGE, reqId);
    return { handled: true, outcome };
  }

  function logIncomingMessage(
    psid: string,
    userId: string,
    event: FacebookWebhookEvent,
    reqId: string
  ): void {
    debugWebhookLog({
      level: "debug",
      msg: "incoming_message",
      reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(psid).slice(0, 12),
      isEcho: Boolean(event.message?.is_echo),
      text: event.message?.text ?? null,
      quickReplyPayload: event.message?.quick_reply?.payload ?? null,
      attachments:
        event.message?.attachments?.map(attachment => ({
          type: attachment.type,
          hasUrl: Boolean(attachment.payload?.url),
        })) ?? [],
      postbackPayload: event.postback?.payload ?? null,
      referralRef: event.postback?.referral?.ref ?? event.referral?.ref ?? null,
    });
  }

  function logUserState(
    psid: string,
    userId: string,
    state: Awaited<ReturnType<typeof getOrCreateState>>,
    reqId: string,
    context: string
  ): void {
    debugWebhookLog({
      level: "debug",
      msg: "user_state",
      context,
      reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(psid).slice(0, 12),
      stage: state.stage,
      hasSeenIntro: state.hasSeenIntro,
      hasLastPhoto: Boolean(state.lastPhotoUrl),
      selectedStyle: state.selectedStyle ?? null,
      preselectedStyle: state.preselectedStyle ?? null,
      preferredLang: state.preferredLang ?? null,
    });
  }

  async function sendLoggedText(
    psid: string,
    text: string,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "text",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      text,
    });
    return await sendText(psid, text);
  }

  async function sendLoggedQuickReplies(
    psid: string,
    text: string,
    replies: Parameters<typeof sendQuickReplies>[2],
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "quick_replies",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      text,
      quickReplies: replies.map(reply => ({
        title: reply.title,
        payload: reply.payload,
      })),
    });
    return await sendQuickReplies(psid, text, replies);
  }

  async function sendLoggedImage(
    psid: string,
    imageUrl: string,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "image",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      imageUrl,
    });
    return await sendImage(psid, imageUrl);
  }

  async function sendStateQuickReplies(
    psid: string,
    state: ConversationState,
    text: string,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const replies = toMessengerReplies(state);
    if (replies.length === 0) {
      return await sendLoggedText(psid, text, reqId);
    }

    return await sendLoggedQuickReplies(psid, text, replies, reqId);
  }

  function resolvePrivacyPolicyUrl(): string | undefined {
    const trimmed = privacyPolicyUrl.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    const appBaseUrl = getConfiguredBaseUrl();
    if (appBaseUrl) {
      return `${appBaseUrl}/privacy`;
    }

    return undefined;
  }

  function resolveStylePreviewUrl(style: Style): string | undefined {
    const appBaseUrl = getConfiguredBaseUrl();
    if (!appBaseUrl) {
      return undefined;
    }

    return `${appBaseUrl}/style-previews/${style}.png`;
  }

  async function sendLoggedGenericTemplate(
    psid: string,
    elements: Parameters<typeof sendGenericTemplate>[1],
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "generic_template",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      elements: elements.map(element => ({
        title: element.title,
        subtitle: element.subtitle,
        imageUrl: element.image_url,
        buttons: element.buttons?.map(button => {
          if (button.type === "web_url") {
            return {
              type: button.type,
              title: button.title,
            };
          }

          return {
            type: button.type,
            title: button.title,
            payload: button.payload,
          };
        }),
      })),
    });
    return await sendGenericTemplate(psid, elements);
  }

  async function sendLoggedButtonTemplate(
    psid: string,
    text: string,
    buttons: Parameters<typeof sendButtonTemplate>[2],
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "button_template",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      text,
      buttons: buttons.map(button => {
        if (button.type === "web_url") {
          return { type: button.type, title: button.title };
        }

        return {
          type: button.type,
          title: button.title,
          payload: button.payload,
        };
      }),
    });
    return await sendButtonTemplate(psid, text, buttons);
  }

  function createFeatureLogger(userId: string): BotLogger {
    return {
      info(event, details = {}) {
        safeLog(event, { user: toLogUser(userId), ...details });
      },
      warn(event, details = {}) {
        safeLog(event, { level: "warn", user: toLogUser(userId), ...details });
      },
      error(event, details = {}) {
        safeLog(event, { level: "error", user: toLogUser(userId), ...details });
      },
    };
  }

  function createFeatureContextBase(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: Awaited<ReturnType<typeof getOrCreateState>>
  ): FeatureContextBase {
    return {
      channel: "messenger",
      capabilities: MESSENGER_CAPABILITIES,
      senderId: psid,
      userId,
      reqId,
      lang,
      state,
      sendText: async text => {
        await sendLoggedText(psid, text, reqId);
      },
      sendImage: async imageUrl => {
        await sendLoggedImage(psid, imageUrl, reqId);
      },
      sendQuickReplies: async (text, replies) => {
        await sendLoggedQuickReplies(psid, text, replies, reqId);
      },
      sendStateQuickReplies: async (nextState, text) => {
        await sendStateQuickReplies(psid, nextState, text, reqId);
      },
      setFlowState: async nextState => {
        await setFlowState(psid, nextState);
      },
      preselectStyle: async style => {
        await setPreselectedStyle(psid, style);
      },
      chooseStyle: async style => {
        await handleStyleSelection(psid, userId, style, reqId, lang);
      },
      runStyleGeneration: async (style, sourceImageUrl, promptHint, directorMode) => {
        await runStyleGeneration(
          psid,
          userId,
          style,
          reqId,
          lang,
          sourceImageUrl,
          promptHint,
          directorMode
        );
      },
      getRuntimeStats: () => getTodayRuntimeStats(),
      logger: createFeatureLogger(userId),
    };
  }

  function createFeaturePayloadContext(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: Awaited<ReturnType<typeof getOrCreateState>>,
    payload: string
  ): BotPayloadContext {
    return {
      ...createFeatureContextBase(psid, userId, reqId, lang, state),
      payload,
    };
  }

  function createFeatureImageContext(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: Awaited<ReturnType<typeof getOrCreateState>>,
    imageUrl: string
  ): BotImageContext {
    return {
      ...createFeatureContextBase(psid, userId, reqId, lang, state),
      imageUrl,
    };
  }

  function createFeatureTextContext(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: Awaited<ReturnType<typeof getOrCreateState>>,
    messageText: string,
    normalizedText: string,
    hasPhoto: boolean
  ): BotTextContext {
    return {
      ...createFeatureContextBase(psid, userId, reqId, lang, state),
      messageText,
      normalizedText,
      hasPhoto,
    };
  }

  function logImageFlowDecision(input: {
    psid: string;
    userId: string;
    reqId: string;
    stage: string;
    hadPreviousPhoto: boolean;
    incomingImageUrl: string;
    selectedStyle: string | null;
    preselectedStyle: string | null;
    action: "show_style_picker" | "auto_run_preselected_style";
  }): void {
    safeLog("messenger_image_flow_decision", {
      reqId: input.reqId,
      user: toLogUser(input.userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
      stage: input.stage,
      hadPreviousPhoto: input.hadPreviousPhoto,
      incomingImageHost: getAttachmentHostname(input.incomingImageUrl),
      selectedStyle: input.selectedStyle,
      preselectedStyle: input.preselectedStyle,
      action: input.action,
    });
  }

  async function sendStylePicker(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    return await sendStateQuickReplies(
      psid,
      "AWAITING_STYLE",
      t(lang, "styleCategoryPicker"),
      reqId
    );
  }

  async function sendStyleOptionsForCategory(
    psid: string,
    category: StyleCategory,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const styles = getStylesForCategory(category);
    const categoryLabel = STYLE_CATEGORY_LABELS[category];
    const introText = t(lang, "styleCategoryCarouselIntro", {
      styleLabel: categoryLabel.toLowerCase(),
    });

    try {
      const introOutcome = await sendLoggedText(psid, introText, reqId);
      const templateOutcome = await sendLoggedGenericTemplate(
        psid,
        styles.map(style => ({
          title: STYLE_LABELS[style.style],
          subtitle:
            lang === "en" ? `${categoryLabel} style` : `${categoryLabel}-stijl`,
          image_url: resolveStylePreviewUrl(style.style),
          buttons: [
            {
              type: "postback",
              title: lang === "en" ? "Choose" : "Kies",
              payload: style.payload,
            },
          ],
        })),
        reqId
      );
      return combineMessengerSendOutcomes(introOutcome, templateOutcome);
    } catch (error) {
      safeLog("style_category_carousel_failed", {
        user: toLogUser(psid),
        category,
        errorCode: error instanceof Error ? error.name : "unknown_error",
      });
    }

    return await sendLoggedQuickReplies(
      psid,
      introText,
      toMessengerStyleReplies(category, lang),
      reqId
    );
  }

  async function sendPhotoReceivedPrompt(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    return await sendStylePicker(psid, lang, reqId);
  }

  async function sendFaceMemoryConsentPrompt(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    return await sendLoggedQuickReplies(
      psid,
      lang === "en"
        ? "May I keep your photo for 30 days? Then you do not have to upload it again every time. You can delete it any time with \"delete my data\"."
        : "Mag ik je foto 30 dagen bewaren? Dan hoef je niet steeds opnieuw te uploaden. Je kan dit altijd wissen met \"verwijder mijn data\".",
      [
        {
          content_type: "text",
          title: lang === "en" ? "Yes, 30 days" : "Ja, 30 dagen",
          payload: FACE_MEMORY_CONSENT_YES,
        },
        {
          content_type: "text",
          title: lang === "en" ? "No" : "Nee",
          payload: FACE_MEMORY_CONSENT_NO,
        },
      ],
      reqId
    );
  }

  async function sendIntro(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<void> {
    await sendStateQuickReplies(
      psid,
      "IDLE",
      t(lang, "flowExplanation"),
      reqId
    );
  }

  async function sendReferralPhotoPrompt(
    psid: string,
    style: Style,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const styleLabel = STYLE_LABELS[style];
    const text =
      lang === "en"
        ? `You came in via ${styleLabel}. Send a photo to start `
        : `Je bent binnengekomen via ${styleLabel}. Stuur een foto om te starten `;
    return await sendLoggedText(psid, text, reqId);
  }

  async function runStyleGeneration(
    psid: string,
    userId: string,
    style: Style,
    reqId: string,
    lang: Lang,
    sourceImageUrl?: string,
    promptHint?: string,
    directorMode?: DirectorMode
  ): Promise<MessengerSendOutcome> {
    let sendOutcome: MessengerSendOutcome = MESSENGER_SEND_SKIPPED;
    const rememberSendOutcome = (outcome: MessengerSendOutcome) => {
      sendOutcome = combineMessengerSendOutcomes(sendOutcome, outcome);
      return outcome;
    };

    const didRun = await runGuardedGeneration(psid, async () => {
      const allowed = await canGenerate(psid);
      const quotaState = await getOrCreateState(psid);
      const bypassRaw = process.env.MESSENGER_QUOTA_BYPASS_IDS ?? "";
      const bypassApplied =
        bypassRaw.includes(psid) || bypassRaw.includes(quotaState.userKey);
      console.log(
        JSON.stringify({
          level: "info",
          msg: "quota_decision",
          action: "check",
          psidHash: anonymizePsid(psid).slice(0, 12),
          count: quotaState.quota.count,
          limit: 3,
          bypassApplied,
          allowed,
        })
      );
      if (!allowed) {
        rememberSendOutcome(await sendLoggedText(
          psid,
          lang === "en"
            ? "You used your free credits for today. Come back tomorrow."
            : "Je hebt je gratis credits voor vandaag opgebruikt. Kom morgen terug.",
          reqId
        ));
        await setFlowState(psid, "AWAITING_STYLE");
        return;
      }

      await setFlowState(psid, "PROCESSING");
      rememberSendOutcome(await sendLoggedText(
        psid,
        t(lang, "generatingPrompt", { styleLabel: STYLE_LABELS[style] }),
        reqId
      ));

      const state = await getOrCreateState(psid);
      const generationResult = await executeGenerationFlow({
        style,
        userId,
        reqId,
        promptHint,
        directorMode,
        sourceImageUrl,
        lastPhotoUrl: state.lastPhotoUrl,
        lastPhotoSource: state.lastPhotoSource,
      });

      if (generationResult.kind === "success") {
        const { imageUrl, metrics, mode, proof } = generationResult;
        console.info(
          JSON.stringify({
            level: "info",
            msg: "messenger_send_image_url",
            reqId,
            psidHash: anonymizePsid(psid).slice(0, 12),
            style,
            imageUrl,
          })
        );

        console.info(
          JSON.stringify({
            level: "info",
            msg: "generation_summary",
            reqId,
            psidHash: anonymizePsid(psid).slice(0, 12),
            mode,
            style,
            ok: true,
            fb_image_fetch_ms: metrics.fbImageFetchMs,
            openai_ms: metrics.openAiMs,
            upload_or_serve_ms: metrics.uploadOrServeMs,
            total_ms: metrics.totalMs,
          })
        );

        console.log(
          "PROOF_SUMMARY",
          JSON.stringify({
            reqId,
            psidHash: anonymizePsid(psid).slice(0, 12),
            style,
            incomingLen: proof.incomingLen,
            incomingSha256: proof.incomingSha256,
            openaiInputLen: proof.openaiInputLen,
            openaiInputSha256: proof.openaiInputSha256,
            outputUrl: imageUrl,
            totalMs: metrics.totalMs,
            ok: true,
          })
        );

        rememberSendOutcome(await sendLoggedImage(psid, imageUrl, reqId));
        await increment(psid);
        await setLastGenerated(psid, imageUrl);
        await setLastGenerationContext(psid, { style, directorMode, prompt: promptHint });
        recordGenerationSuccess(style, metrics.totalMs);
        rememberSendOutcome(await sendStateQuickReplies(
          psid,
          "RESULT_READY",
          t(lang, "success"),
          reqId
        ));
        await setFlowState(psid, "IDLE");
        return;
      }

      const error = generationResult.error;
      console.error("OPENAI_CALL_ERROR", {
        psidHash: anonymizePsid(psid).slice(0, 12),
        error: error instanceof Error ? error.message : undefined,
      });

      const errorClass =
        error instanceof Error ? error.constructor.name : "UnknownError";
      const metrics =
        generationResult.metrics ?? getGenerationMetrics(error) ?? { totalMs: 0 };

      console.log(
        "PROOF_SUMMARY",
        JSON.stringify({
          reqId,
          psidHash: anonymizePsid(psid).slice(0, 12),
          style,
          ok: false,
          errorCode: errorClass,
          totalMs: metrics.totalMs,
        })
      );
      recordGenerationError();

      let failureText = t(lang, "generationGenericFailure");
      if (generationResult.errorKind === "missing_source_image") {
        rememberSendOutcome(
          await sendLoggedText(psid, t(lang, "styleWithoutPhoto"), reqId)
        );
        await setFlowState(psid, "AWAITING_PHOTO");
        return;
      } else if (
        generationResult.errorKind === "missing_input_image" ||
        generationResult.errorKind === "invalid_source_image"
      ) {
        rememberSendOutcome(
          await sendLoggedText(psid, t(lang, "missingInputImage"), reqId)
        );
        await setFlowState(psid, "AWAITING_PHOTO");
        return;
      } else if (generationResult.errorKind === "generation_unavailable") {
        failureText = t(lang, "generationUnavailable");
      } else if (generationResult.errorKind === "generation_timeout") {
        failureText = t(lang, "generationTimeout");
      } else if (generationResult.errorKind === "generation_budget_reached") {
        rememberSendOutcome(
          await sendLoggedText(psid, t(lang, "generationBudgetReached"), reqId)
        );
        await setFlowState(psid, "AWAITING_STYLE");
        return;
      }

      rememberSendOutcome(await sendLoggedText(psid, t(lang, "failure"), reqId));
      await setFlowState(psid, "FAILURE");

      rememberSendOutcome(await sendLoggedQuickReplies(
        psid,
        failureText,
        [
          {
            content_type: "text",
            title: t(lang, "retryThisStyle"),
            payload: `RETRY_STYLE_${style}`,
          },
          {
            content_type: "text",
            title: t(lang, "otherStyle"),
            payload: "CHOOSE_STYLE",
          },
        ],
        reqId
      ));
    });

    if (didRun === null) {
      const result = await maybeSendInFlightMessage(psid, reqId);
      if ("outcome" in result && result.outcome) {
        rememberSendOutcome(result.outcome);
      }
      return sendOutcome;
    }
    inFlightNoticeSent.delete(psid);
    return sendOutcome;
  }

  async function handleStyleSelection(
    psid: string,
    userId: string,
    selectedStyle: Style,
    reqId: string,
    lang: Lang
  ): Promise<MessengerSendOutcome> {
    const state = await getOrCreateState(psid);
    if (state.stage === "PROCESSING") {
      const result = await maybeSendInFlightMessage(psid, reqId);
      return "outcome" in result && result.outcome
        ? result.outcome
        : MESSENGER_SEND_SKIPPED;
    }

    await setChosenStyle(psid, selectedStyle);
    if (!state.lastPhotoUrl) {
      await setPreselectedStyle(psid, selectedStyle);
      await setFlowState(psid, "AWAITING_PHOTO");
      return await sendLoggedText(psid, t(lang, "styleWithoutPhoto"), reqId);
    }

    return await runStyleGeneration(psid, userId, selectedStyle, reqId, lang);
  }

  async function sendPrivacyInfo(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const resolvedPrivacyUrl = resolvePrivacyPolicyUrl();
    const privacyText = t(lang, "privacy", { link: resolvedPrivacyUrl });

    if (!resolvedPrivacyUrl) {
      return await sendLoggedText(psid, privacyText, reqId);
    }

    return await sendLoggedButtonTemplate(
      psid,
      privacyText,
      [
        {
          type: "web_url",
          title: t(lang, "privacyButtonLabel"),
          url: resolvedPrivacyUrl,
        },
      ],
      reqId
    );
  }

  async function claimEventReplayOrLog(
    event: FacebookWebhookEvent,
    entryId: string | undefined,
    userId: string
  ): Promise<boolean> {
    const dedupeKey = getEventDedupeKey(event, userId, entryId);
    if (!dedupeKey) {
      return true;
    }

    const claimed = await claimWebhookReplayKey(dedupeKey);
    if (claimed) {
      return true;
    }

    safeLog("webhook_replay_ignored", {
      user: toLogUser(userId),
      eventId: dedupeKey,
    });
    return false;
  }

  async function handleReferralStyleEvent(
    psid: string,
    referralRef: string | undefined,
    lang: Lang,
    reqId: string
  ): Promise<MaybeInFlightMessageResult> {
    const referralStyle = parseReferralStyle(referralRef);
    if (!referralStyle) {
      return { handled: false };
    }

    await clearPendingImageState(psid);
    await setPreselectedStyle(psid, referralStyle);
    await setFlowState(psid, "AWAITING_PHOTO");
    const outcome = await sendReferralPhotoPrompt(psid, referralStyle, lang, reqId);
    return { handled: true, outcome };
  }

  const ctx: HandlerContext = {
    defaultLang,
    claimEventReplayOrLog,
    createFeatureImageContext,
    createFeaturePayloadContext,
    createFeatureTextContext,
    debugWebhookLog,
    getAttachmentHostname,
    handleStyleSelection,
    handleReferralStyleEvent,
    logImageFlowDecision,
    logIncomingMessage,
    logUserState,
    maybeSendInFlightMessage,
    runStyleGeneration,
    sendFaceMemoryConsentPrompt,
    sendFlowExplanation: (userPsid, userLang, requestId) =>
      sendLoggedText(userPsid, t(userLang, "flowExplanation"), requestId),
    sendLoggedImage,
    sendLoggedQuickReplies,
    sendLoggedText,
    sendPhotoReceivedPrompt,
    sendPrivacyInfo,
    sendStateQuickReplies,
    sendStyleOptionsForCategory,
    sendStylePicker,
  };

  async function processFacebookWebhookPayload(
    payload: unknown
  ): Promise<void> {
    const entries = Array.isArray(
      (payload as { entry?: unknown[] } | null | undefined)?.entry
    )
      ? ((payload as { entry: FacebookWebhookEntry[] }).entry ?? [])
      : [];

    for (const entry of entries) {
      await handleEntry(ctx, entry);
    }
  }

  async function processInternalMessengerImageRequest(
    input: InternalMessengerImageRequestInput
  ): Promise<MessengerSendOutcome> {
    const lang = input.lang ?? defaultLang;
    const userId = toUserKey(input.psid);
    const style = input.style ?? inferStyleFromImageRequest(input.prompt);
    await setLastUserMessageAt(input.psid, input.timestamp ?? Date.now());

    safeLog("internal_image_request_received", {
      reqId: input.reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
      style,
    });

    const state = await getOrCreateState(input.psid);
    if (state.stage === "PROCESSING") {
      const result = await maybeSendInFlightMessage(input.psid, input.reqId);
      return "outcome" in result && result.outcome
        ? result.outcome
        : MESSENGER_SEND_SKIPPED;
    }

    if (!state.lastPhotoUrl) {
      await setPreselectedStyle(input.psid, style);
      await setFlowState(input.psid, "AWAITING_PHOTO");
      return await sendLoggedText(input.psid, t(lang, "styleWithoutPhoto"), input.reqId);
    }

    await setChosenStyle(input.psid, style);
    return await runStyleGeneration(
      input.psid,
      userId,
      style,
      input.reqId,
      lang,
      state.lastPhotoUrl,
      input.prompt
    );
  }

  return {
    processFacebookWebhookPayload,
    processInternalMessengerImageRequest,
  };
}
