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
import { buildGenerationSuccessResponse } from "./conversationActions";
import { renderMessengerQuickReplies } from "./messengerActionRenderer";
import {
  clearPendingImageState,
  getOrCreateState,
  setChosenStyle,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
  setPendingStoredImage,
  setPreselectedStyle,
  setLastUserMessageAt,
  anonymizePsid,
  type ConversationState,
} from "./messengerState";
import { FACE_MEMORY_CONSENT_NO, FACE_MEMORY_CONSENT_YES } from "./faceMemory";
import { t, type Lang } from "./i18n";
import { toLogUser, toUserKey } from "./privacy";
import { normalizeMessengerInboundImage } from "./messengerImageIngress";
import {
  getStylesForCategory,
  type Style,
  type StyleCategory,
} from "./messengerStyles";
import { claimWebhookReplayKey } from "./webhookReplayProtection";
import {
  type FacebookWebhookEntry,
  type FacebookWebhookEvent,
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
import { canGenerate, getFreeDailyLimit, increment } from "./messengerQuota";
import { isDebugLogEnabled } from "./logLevel";
import { ensureDefaultBotFeaturesRegistered } from "./bot/defaultFeatures";
import {
  getTodayRuntimeStats,
  recordGenerationError,
  recordGenerationSuccess,
} from "./botRuntimeStats";
import type {
  BotLogger,
  BotPayloadContext,
  BotTextContext,
  BotImageContext,
} from "./botContext";
import type { DirectorMode } from "./image-generation/director/directorTypes";
import { emitGenerationDiagnostic } from "./generationDiagnostics";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import {
  enqueueOrRunMessengerGenerationJob,
  isMessengerGenerationQueueEnabled,
} from "./messengerGenerationQueue";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./messengerGenerationCompletion";
import { handleEntry } from "./webhookEventRouter";
import {
  MESSENGER_ASYNC_RESPONSE_QUEUED,
  MESSENGER_SEND_SKIPPED,
  combineMessengerSendOutcomes,
  type MaybeInFlightMessageResult,
} from "./webhookFallback";

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
  sourceImageUrl?: string;
};

export class InternalMessengerImageRequestNotQueuedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InternalMessengerImageRequestNotQueuedError";
  }
}

type FeatureContextBase = Omit<BotPayloadContext, "payload">;
type MessengerState = Awaited<ReturnType<typeof getOrCreateState>>;
const DEFAULT_TEXT_TO_IMAGE_STYLE: Style = "cinematic";

function normalizeImageRequestText(text: string): string {
  return text.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function inferStyleFromImageRequest(text: string): Style | undefined {
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

  return undefined;
}

function isSourceImageEditRequest(text: string): boolean {
  const normalized = normalizeImageRequestText(text);
  return /\b(restyle|restylen|restijlen|restijl|bewerk foto|bewerk deze foto|foto bewerken|edit image|edit this image|edit photo|this photo|deze foto)\b/.test(
    normalized
  );
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
    action:
      | "show_style_picker"
      | "auto_run_preselected_style"
      | "auto_run_selected_style";
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

const IN_FLIGHT_MESSAGE =
  "\u23F3 even geduld, ik ben nog bezig met jouw restyle";
const IN_FLIGHT_NOTICE_COOLDOWN_MS = 30_000;
const inFlightNoticeSent = new Map<string, number>();
const MESSENGER_CAPABILITIES = Object.freeze({
  quickReplies: true,
  richTemplates: true,
});

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

    const now = Date.now();
    const lastNoticeSentAt = inFlightNoticeSent.get(psid);
    if (
      lastNoticeSentAt !== undefined &&
      now - lastNoticeSentAt < IN_FLIGHT_NOTICE_COOLDOWN_MS
    ) {
      return { handled: true };
    }

    const outcome = await sendLoggedText(psid, IN_FLIGHT_MESSAGE, reqId);
    inFlightNoticeSent.set(psid, now);
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
      runStyleGeneration: async (
        style,
        sourceImageUrl,
        promptHint,
        directorMode
      ) => {
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
    action:
      | "show_style_picker"
      | "auto_run_preselected_style"
      | "auto_run_selected_style";
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
        ? 'May I keep your photo for 30 days? Then you do not have to upload it again every time. You can delete it any time with "delete my data".'
        : 'Mag ik je foto 30 dagen bewaren? Dan hoef je niet steeds opnieuw te uploaden. Je kan dit altijd wissen met "verwijder mijn data".',
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

  async function executeStyleGenerationJob(
    job: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    const {
      psid,
      userId,
      style,
      generationKind = "style_restyle",
      reqId,
      lang,
      sourceImageUrl,
      promptHint,
      directorMode,
    } = job;
    let sendOutcome: MessengerSendOutcome = MESSENGER_SEND_SKIPPED;
    const rememberSendOutcome = (outcome: MessengerSendOutcome) => {
      sendOutcome = combineMessengerSendOutcomes(sendOutcome, outcome);
      return outcome;
    };

    const didRun = await runGuardedGeneration(psid, async () => {
      const completedGeneration = await Promise.resolve(
        getMessengerGenerationCompletion(reqId)
      );
      if (completedGeneration) {
        if (
          completedGeneration.userKey &&
          completedGeneration.userKey !== userId
        ) {
          safeLog("messenger_generation_job_duplicate_user_mismatch", {
            reqId,
            expectedUser: toLogUser(userId),
            completionUser: toLogUser(completedGeneration.userKey),
            style,
          });
        } else {
          safeLog("messenger_generation_job_duplicate_completed", {
            reqId,
            user: toLogUser(userId),
            style,
          });
          await setLastGenerated(psid, completedGeneration.imageUrl);
          await setLastGenerationContext(psid, {
            style,
            directorMode,
            prompt: promptHint,
          });
          await setFlowState(psid, "IDLE");
          return;
        }
      }

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
          limit: getFreeDailyLimit(),
          bypassApplied,
          allowed,
        })
      );
      if (!allowed) {
        rememberSendOutcome(
          await sendLoggedText(
            psid,
            lang === "en"
              ? "You used your free credits for today. Come back tomorrow."
              : "Je hebt je gratis credits voor vandaag opgebruikt. Kom morgen terug.",
            reqId
          )
        );
        await setFlowState(psid, "AWAITING_STYLE");
        return;
      }

      await setFlowState(psid, "PROCESSING");
      rememberSendOutcome(
        await sendLoggedText(
          psid,
          generationKind === "text_to_image"
            ? t(lang, "generatingImagePrompt")
            : t(lang, "generatingPrompt", { styleLabel: STYLE_LABELS[style] }),
          reqId
        )
      );

      const state = await getOrCreateState(psid);
      const generationResult = await executeGenerationFlow({
        style,
        generationKind,
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
            imageUrl: summarizeSensitiveUrl(imageUrl),
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
            prompt_build_ms: metrics.promptBuildMs,
            openai_payload_build_ms: metrics.openAiPayloadBuildMs,
            openai_ms: metrics.openAiMs,
            openai_parse_ms: metrics.openAiParseMs,
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
            outputUrl: summarizeSensitiveUrl(imageUrl),
            totalMs: metrics.totalMs,
            ok: true,
          })
        );

        const messengerSendStartedAt = Date.now();
        rememberSendOutcome(await sendLoggedImage(psid, imageUrl, reqId));
        await Promise.resolve(
          markMessengerGenerationCompleted(reqId, imageUrl, userId)
        );
        const messengerSendMs = Date.now() - messengerSendStartedAt;
        await increment(psid);
        await setLastGenerated(psid, imageUrl);
        await setLastGenerationContext(psid, {
          style,
          directorMode,
          prompt: promptHint,
        });
        recordGenerationSuccess(style, metrics.totalMs);
        const successResponse = buildGenerationSuccessResponse(lang);
        rememberSendOutcome(
          await sendLoggedQuickReplies(
            psid,
            successResponse.text ?? "",
            renderMessengerQuickReplies(successResponse.actions),
            reqId
          )
        );
        emitGenerationDiagnostic({
          generationId: reqId,
          senderId: psid,
          style,
          success: true,
          durationsMs: {
            source_image_downloaded: metrics.fbImageFetchMs,
            prompt_built: metrics.promptBuildMs,
            provider_payload_built: metrics.openAiPayloadBuildMs,
            provider_request: metrics.openAiMs,
            provider_response_parsed: metrics.openAiParseMs,
            result_uploaded_or_stored: metrics.uploadOrServeMs,
            messenger_send: messengerSendMs,
            total: metrics.totalMs + messengerSendMs,
          },
        });
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
      const metrics = generationResult.metrics ??
        getGenerationMetrics(error) ?? { totalMs: 0 };

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
      emitGenerationDiagnostic({
        generationId: reqId,
        senderId: psid,
        style,
        success: false,
        failureReason: generationResult.errorKind,
        durationsMs: {
          source_image_downloaded: metrics.fbImageFetchMs,
          prompt_built: metrics.promptBuildMs,
          provider_payload_built: metrics.openAiPayloadBuildMs,
          provider_request: metrics.openAiMs,
          provider_response_parsed: metrics.openAiParseMs,
          result_uploaded_or_stored: metrics.uploadOrServeMs,
          total: metrics.totalMs,
        },
      });
      recordGenerationError();

      let failureText = t(lang, "generationGenericFailure");
      let sendGenericFailureLead = true;
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
        sendGenericFailureLead = false;
      } else if (generationResult.errorKind === "generation_budget_reached") {
        rememberSendOutcome(
          await sendLoggedText(psid, t(lang, "generationBudgetReached"), reqId)
        );
        await setFlowState(psid, "AWAITING_STYLE");
        return;
      }

      if (sendGenericFailureLead) {
        rememberSendOutcome(
          await sendLoggedText(psid, t(lang, "failure"), reqId)
        );
      }
      await setFlowState(psid, "FAILURE");

      rememberSendOutcome(
        await sendLoggedQuickReplies(
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
        )
      );
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

  async function runStyleGeneration(
    psid: string,
    userId: string,
    style: Style,
    reqId: string,
    lang: Lang,
    sourceImageUrl?: string,
    promptHint?: string,
    directorMode?: DirectorMode,
    generationKind: MessengerGenerationJob["generationKind"] = "style_restyle"
  ): Promise<MessengerSendOutcome> {
    const job: MessengerGenerationJob = {
      psid,
      userId,
      style,
      generationKind,
      reqId,
      lang,
      sourceImageUrl,
      promptHint,
      directorMode,
    };
    const result = await enqueueOrRunMessengerGenerationJob(
      job,
      executeStyleGenerationJob,
      {
        onDeadLetter: processMessengerGenerationJobDeadLetter,
      }
    );

    if (result.mode === "inline") {
      return result.outcome as MessengerSendOutcome;
    }

    await setFlowState(psid, "PROCESSING");
    try {
      await sendLoggedText(psid, t(lang, "generationQueued"), reqId);
    } catch (error) {
      safeLog("messenger_generation_queued_ack_failed", {
        reqId,
        user: toLogUser(userId),
        style,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    safeLog("messenger_generation_job_queued", {
      reqId,
      user: toLogUser(userId),
      style,
      queueEnabled: isMessengerGenerationQueueEnabled(),
    });
    return MESSENGER_ASYNC_RESPONSE_QUEUED;
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
    const outcome = await sendReferralPhotoPrompt(
      psid,
      referralStyle,
      lang,
      reqId
    );
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

  async function acceptInternalMessengerImageRequest(
    input: InternalMessengerImageRequestInput
  ): Promise<MessengerSendOutcome> {
    const lang = input.lang ?? defaultLang;
    const userId = toUserKey(input.psid);
    const inferredStyle = input.style ?? inferStyleFromImageRequest(input.prompt);
    await setLastUserMessageAt(input.psid, input.timestamp ?? Date.now());

    safeLog("internal_image_request_received", {
      reqId: input.reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
      style: inferredStyle ?? null,
      hasSourceImageUrl: Boolean(input.sourceImageUrl),
    });

    let storedSourceImageUrl: string | undefined;
    if (input.sourceImageUrl) {
      storedSourceImageUrl =
        (await normalizeMessengerInboundImage({
          inboundImageUrl: input.sourceImageUrl,
          psidHash: anonymizePsid(input.psid).slice(0, 12),
          reqId: input.reqId,
        })) ?? undefined;
      if (!storedSourceImageUrl) {
        await clearPendingImageState(input.psid);
        await setFlowState(input.psid, "AWAITING_PHOTO");
        await sendLoggedText(
          input.psid,
          t(lang, "missingInputImage"),
          input.reqId
        );
        throw new InternalMessengerImageRequestNotQueuedError(
          "Internal Messenger image request source image could not be persisted"
        );
      }
      await setPendingStoredImage(input.psid, storedSourceImageUrl);
    }

    const state = await getOrCreateState(input.psid);
    if (state.stage === "PROCESSING") {
      const result = await maybeSendInFlightMessage(input.psid, input.reqId);
      return "outcome" in result && result.outcome
        ? result.outcome
        : MESSENGER_SEND_SKIPPED;
    }

    const wantsSourceImageEdit = isSourceImageEditRequest(input.prompt);
    const shouldUsePreviousPhoto = Boolean(storedSourceImageUrl) || wantsSourceImageEdit;
    const sourceImageUrl = shouldUsePreviousPhoto
      ? storedSourceImageUrl ?? state.lastPhotoUrl ?? undefined
      : undefined;
    if (!sourceImageUrl) {
      if (wantsSourceImageEdit) {
        const style = inferredStyle ?? DEFAULT_TEXT_TO_IMAGE_STYLE;
        await setPreselectedStyle(input.psid, style);
        await setFlowState(input.psid, "AWAITING_PHOTO");
        await sendLoggedText(
          input.psid,
          t(lang, "styleWithoutPhoto"),
          input.reqId
        );
        throw new InternalMessengerImageRequestNotQueuedError(
          "Internal Messenger image request needs a source image for edit intent"
        );
      }

      const style = inferredStyle ?? DEFAULT_TEXT_TO_IMAGE_STYLE;
      await setChosenStyle(input.psid, style);
      return await runStyleGeneration(
        input.psid,
        userId,
        style,
        input.reqId,
        lang,
        undefined,
        input.prompt,
        undefined,
        "text_to_image"
      );
    }

    const style = inferredStyle ?? DEFAULT_TEXT_TO_IMAGE_STYLE;
    await setChosenStyle(input.psid, style);
    return await runStyleGeneration(
      input.psid,
      userId,
      style,
      input.reqId,
      lang,
      sourceImageUrl,
      input.prompt
    );
  }

  async function processInternalMessengerImageRequest(
    input: InternalMessengerImageRequestInput
  ): Promise<MessengerSendOutcome> {
    return await acceptInternalMessengerImageRequest(input);
  }

  async function processMessengerGenerationJob(
    input: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    return await executeStyleGenerationJob(input);
  }

  async function processMessengerGenerationJobDeadLetter(
    input: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    await setFlowState(input.psid, "FAILURE");
    return await sendLoggedText(
      input.psid,
      t(input.lang, "generationGenericFailure"),
      input.reqId
    );
  }

  return {
    processFacebookWebhookPayload,
    acceptInternalMessengerImageRequest,
    processInternalMessengerImageRequest,
    processMessengerGenerationJob,
    processMessengerGenerationJobDeadLetter,
  };
}
