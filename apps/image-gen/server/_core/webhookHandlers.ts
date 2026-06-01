import {
  sendImage,
  sendQuickReplies,
  sendText,
  safeLog,
} from "./messengerApi";
import type { MessengerSendOutcome } from "./messengerApi";
import { getGenerationMetrics } from "./image-generation/openAiImageClient";
import { executeGenerationFlow } from "./generationFlow";
import {
  buildFaceMemoryConsentResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
  buildPhotoReceivedResponse,
  buildQuickStartResponse,
} from "./conversationActions";
import { renderMessengerQuickReplies } from "./messengerActionRenderer";
import {
  clearPendingImageState,
  getOrCreateState,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
  setPendingStoredImage,
  setLastUserMessageAt,
  anonymizePsid,
  type ConversationState,
} from "./messengerState";
import { t, type Lang } from "./i18n";
import { toLogUser, toUserKey } from "./privacy";
import { normalizeMessengerInboundImage } from "./messengerImageIngress";
import { claimWebhookReplayKey } from "./webhookReplayProtection";
import {
  type FacebookWebhookEntry,
  type FacebookWebhookEvent,
  getEventDedupeKey,
  getGreetingResponse,
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
import type { GenerationKind } from "./image-generation/generationTypes";
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
import {
  isExplicitSourceImageEditRequest,
  isSourceImageTransformRequest,
  isVisualCorrectionRequest,
} from "./imageIntent";

type HandlerDeps = {
  defaultLang: Lang;
};

type InternalMessengerImageRequestInput = {
  psid: string;
  prompt: string;
  reqId: string;
  lang?: Lang;
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
  logImageFlowDecision: (input: {
    psid: string;
    userId: string;
    reqId: string;
    stage: string;
    hadPreviousPhoto: boolean;
    incomingImageUrl: string;
    action: "request_edit_prompt";
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
  runImageGeneration: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    sourceImageUrl?: string,
    promptHint?: string,
    generationKind?: GenerationKind
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
};

const IN_FLIGHT_MESSAGE =
  "Even geduld, ik ben nog bezig met je afbeelding.";
const IN_FLIGHT_NOTICE_COOLDOWN_MS = 30_000;
const inFlightNoticeSent = new Map<string, number>();
const MESSENGER_CAPABILITIES = Object.freeze({
  quickReplies: true,
  richTemplates: true,
});

export function createWebhookHandlers({ defaultLang }: HandlerDeps) {
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
      sendActions: async (text, actions) => {
        await sendLoggedQuickReplies(
          psid,
          text,
          renderMessengerQuickReplies(actions),
          reqId
        );
      },
      setFlowState: async nextState => {
        await setFlowState(psid, nextState);
        if (userId !== psid) {
          await setFlowState(userId, nextState);
        }
      },
      clearImageContext: async () => {
        await clearPendingImageState(psid);
        if (userId !== psid) {
          await clearPendingImageState(userId);
        }
      },
      runImageGeneration: async (
        sourceImageUrl,
        promptHint,
        generationKind
      ) => {
        await runImageGeneration(
          psid,
          userId,
          reqId,
          lang,
          sourceImageUrl,
          promptHint,
          generationKind
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
    action: "request_edit_prompt";
  }): void {
    safeLog("messenger_image_flow_decision", {
      reqId: input.reqId,
      user: toLogUser(input.userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
      stage: input.stage,
      hadPreviousPhoto: input.hadPreviousPhoto,
      incomingImageHost: getAttachmentHostname(input.incomingImageUrl),
      action: input.action,
    });
  }
  async function sendPhotoReceivedPrompt(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const response = buildPhotoReceivedResponse(lang);
    return await sendLoggedQuickReplies(
      psid,
      response.text ?? "",
      renderMessengerQuickReplies(response.actions),
      reqId
    );
  }

  async function sendFaceMemoryConsentPrompt(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const response = buildFaceMemoryConsentResponse(lang);
    return await sendLoggedQuickReplies(
      psid,
      response.text ?? "",
      renderMessengerQuickReplies(response.actions),
      reqId
    );
  }

  async function sendIntro(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<void> {
    const response = buildQuickStartResponse(lang);
    await sendLoggedQuickReplies(
      psid,
      response.text ?? "",
      renderMessengerQuickReplies(response.actions),
      reqId
    );
  }

  async function executeImageGenerationJob(
    job: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    const {
      psid,
      userId,
      generationKind,
      reqId,
      lang,
      sourceImageUrl,
      promptHint,
    } = job;
    const resolvedGenerationKind =
      generationKind ?? (sourceImageUrl ? "source_image_edit" : "text_to_image");
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
            generationKind: resolvedGenerationKind,
          });
        } else {
          safeLog("messenger_generation_job_duplicate_completed", {
            reqId,
            user: toLogUser(userId),
            generationKind: resolvedGenerationKind,
          });
          await setLastGenerated(psid, completedGeneration.imageUrl);
          await setLastGenerationContext(psid, {
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
        await setFlowState(psid, "AWAITING_EDIT_PROMPT");
        return;
      }

      await setFlowState(psid, "PROCESSING");
      rememberSendOutcome(
        await sendLoggedText(
          psid,
          resolvedGenerationKind === "text_to_image"
            ? t(lang, "generatingImagePrompt")
            : t(lang, "generatingImagePrompt"),
          reqId
        )
      );

      const state = await getOrCreateState(psid);
      const shouldSendSourceImage =
        resolvedGenerationKind === "source_image_edit";
      const sourceIsGeneratedResult = Boolean(
        shouldSendSourceImage &&
        sourceImageUrl &&
          (sourceImageUrl === state.lastGeneratedUrl ||
            sourceImageUrl === state.lastImageUrl)
      );
      const generationResult = await executeGenerationFlow({
        generationKind: resolvedGenerationKind,
        userId,
        reqId,
        promptHint,
        sourceImageUrl: shouldSendSourceImage ? sourceImageUrl : undefined,
        lastPhotoUrl: shouldSendSourceImage
          ? sourceIsGeneratedResult
            ? sourceImageUrl
            : state.lastPhotoUrl
          : undefined,
        lastPhotoSource: shouldSendSourceImage
          ? sourceIsGeneratedResult
            ? "stored"
            : state.lastPhotoSource
          : undefined,
      });

      if (generationResult.kind === "success") {
        const { imageUrl, metrics, mode, proof } = generationResult;
        console.info(
          JSON.stringify({
            level: "info",
            msg: "messenger_send_image_url",
            reqId,
            psidHash: anonymizePsid(psid).slice(0, 12),
            generationKind: resolvedGenerationKind,
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
            generationKind: resolvedGenerationKind,
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
            generationKind: resolvedGenerationKind,
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
          prompt: promptHint,
        });
        recordGenerationSuccess(resolvedGenerationKind, metrics.totalMs);
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
          style: resolvedGenerationKind,
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
          generationKind: resolvedGenerationKind,
          ok: false,
          errorCode: errorClass,
          totalMs: metrics.totalMs,
        })
      );
      emitGenerationDiagnostic({
        generationId: reqId,
        senderId: psid,
        style: resolvedGenerationKind,
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
          await sendLoggedText(psid, t(lang, "editRequiresPhoto"), reqId)
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
        await setFlowState(psid, "AWAITING_EDIT_PROMPT");
        return;
      }

      if (sendGenericFailureLead) {
        rememberSendOutcome(
          await sendLoggedText(psid, t(lang, "failure"), reqId)
        );
      }
      await setFlowState(psid, "FAILURE");

      const failureResponse = buildGenerationFailureResponse(
        lang,
        failureText
      );
      rememberSendOutcome(
        await sendLoggedQuickReplies(
          psid,
          failureResponse.text ?? "",
          renderMessengerQuickReplies(failureResponse.actions),
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

  async function runImageGeneration(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    sourceImageUrl?: string,
    promptHint?: string,
    generationKind?: GenerationKind
  ): Promise<MessengerSendOutcome> {
    const resolvedGenerationKind =
      generationKind ?? (sourceImageUrl ? "source_image_edit" : "text_to_image");
    const job: MessengerGenerationJob = {
      psid,
      userId,
      generationKind: resolvedGenerationKind,
      reqId,
      lang,
      sourceImageUrl,
      promptHint,
    };
    const result = await enqueueOrRunMessengerGenerationJob(
      job,
      executeImageGenerationJob,
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
        generationKind: resolvedGenerationKind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    safeLog("messenger_generation_job_queued", {
      reqId,
      user: toLogUser(userId),
      generationKind: resolvedGenerationKind,
      queueEnabled: isMessengerGenerationQueueEnabled(),
    });
    return MESSENGER_ASYNC_RESPONSE_QUEUED;
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

  const ctx: HandlerContext = {
    defaultLang,
    claimEventReplayOrLog,
    createFeatureImageContext,
    createFeaturePayloadContext,
    createFeatureTextContext,
    debugWebhookLog,
    getAttachmentHostname,
    logImageFlowDecision,
    logIncomingMessage,
    logUserState,
    maybeSendInFlightMessage,
    runImageGeneration,
    sendFaceMemoryConsentPrompt,
    sendFlowExplanation: (userPsid, userLang, requestId) =>
      sendLoggedText(userPsid, t(userLang, "flowExplanation"), requestId),
    sendLoggedImage,
    sendLoggedQuickReplies,
    sendLoggedText,
    sendPhotoReceivedPrompt,
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
    const wantsSourceImageEdit = isExplicitSourceImageEditRequest(input.prompt);
    const wantsPersonalTransform = isSourceImageTransformRequest(input.prompt);
    const wantsVisualCorrection = isVisualCorrectionRequest(input.prompt);
    await setLastUserMessageAt(input.psid, input.timestamp ?? Date.now());

    safeLog("internal_image_request_received", {
      reqId: input.reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
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

    const previousEditableImageUrl =
      state.lastGeneratedUrl ?? state.lastImageUrl ?? state.lastPhotoUrl ?? undefined;
    const shouldUsePreviousPhoto =
      Boolean(storedSourceImageUrl) ||
      wantsSourceImageEdit ||
      wantsVisualCorrection ||
      (wantsPersonalTransform && Boolean(previousEditableImageUrl));
    const sourceImageUrl = shouldUsePreviousPhoto
      ? storedSourceImageUrl ??
        previousEditableImageUrl ??
        undefined
      : undefined;
    if (!sourceImageUrl) {
      if (wantsSourceImageEdit || wantsVisualCorrection) {
        await setFlowState(input.psid, "AWAITING_PHOTO");
        await sendLoggedText(
          input.psid,
          t(lang, "editRequiresPhoto"),
          input.reqId
        );
        throw new InternalMessengerImageRequestNotQueuedError(
          "Internal Messenger image request needs a source image for edit intent"
        );
      }

      return await runImageGeneration(
        input.psid,
        userId,
        input.reqId,
        lang,
        undefined,
        input.prompt,
        "text_to_image"
      );
    }

    return await runImageGeneration(
      input.psid,
      userId,
      input.reqId,
      lang,
      sourceImageUrl,
      input.prompt,
      "source_image_edit"
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
    return await executeImageGenerationJob(input);
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
