import type { MessengerSendOutcome } from "./messengerApi";
import { safeLog } from "./messengerApi";
import { getGenerationMetrics } from "./image-generation/openAiImageClient";
import { executeGenerationFlow } from "./generationFlow";
import {
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
} from "./conversationActions";
import { renderMessengerQuickReplies } from "./messengerActionRenderer";
import {
  anonymizePsid,
  getOrCreateState,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
} from "./messengerState";
import { t } from "./i18n";
import { toLogUser } from "./privacy";
import { runGuardedGeneration } from "./generationGuard";
import { canGenerate, getFreeDailyLimit, increment } from "./messengerQuota";
import {
  recordGenerationError,
  recordGenerationSuccess,
} from "./botRuntimeStats";
import { emitGenerationDiagnostic } from "./generationDiagnostics";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import type { GenerationKind } from "./image-generation/generationTypes";
import {
  enqueueOrRunMessengerGenerationJob,
  isMessengerGenerationQueueEnabled,
} from "./messengerGenerationQueue";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./messengerGenerationCompletion";
import {
  MESSENGER_ASYNC_RESPONSE_QUEUED,
  MESSENGER_SEND_SKIPPED,
  combineMessengerSendOutcomes,
} from "./webhookFallback";
import { clearInFlightNotice } from "./webhookHandlerContext";
import type { HandlerContext } from "./webhookHandlerTypes";

type GenerationJobRunner = {
  runImageGeneration: HandlerContext["runImageGeneration"];
  processMessengerGenerationJob: (
    input: MessengerGenerationJob
  ) => Promise<MessengerSendOutcome>;
  processMessengerGenerationJobDeadLetter: (
    input: MessengerGenerationJob
  ) => Promise<MessengerSendOutcome>;
};

type GenerationJobRunnerDeps = Pick<
  HandlerContext,
  | "maybeSendInFlightMessage"
  | "sendLoggedImage"
  | "sendLoggedQuickReplies"
  | "sendLoggedText"
>;

export function createMessengerGenerationJobRunner(
  deps: GenerationJobRunnerDeps
): GenerationJobRunner {
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
    const resolvedGenerationKind: GenerationKind =
      generationKind ??
      (sourceImageUrl ? "source_image_edit" : "text_to_image");
    let sendOutcome: MessengerSendOutcome = MESSENGER_SEND_SKIPPED;
    const rememberSendOutcome = (outcome: MessengerSendOutcome) => {
      sendOutcome = combineMessengerSendOutcomes(sendOutcome, outcome);
      return outcome;
    };

    let didRun: Awaited<ReturnType<typeof runGuardedGeneration<void>>>;
    try {
      didRun = await runGuardedGeneration(psid, async () => {
        if (
          await finishDuplicateGenerationIfCompleted({
            psid,
            userId,
            reqId,
            promptHint,
            resolvedGenerationKind,
          })
        ) {
          return;
        }

        if (
          !(await reserveGenerationQuota({
            deps,
            psid,
            reqId,
            lang,
            rememberSendOutcome,
          }))
        ) {
          return;
        }

        await setFlowState(psid, "PROCESSING");
        await sendGenerationStartedAck({
          deps,
          psid,
          userId,
          reqId,
          lang,
          resolvedGenerationKind,
          rememberSendOutcome,
        });

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
          await handleGenerationSuccess({
            deps,
            generationResult,
            promptHint,
            psid,
            reqId,
            resolvedGenerationKind,
            userId,
            lang,
            rememberSendOutcome,
          });
          return;
        }

        await handleGenerationFailure({
          deps,
          generationResult,
          psid,
          reqId,
          resolvedGenerationKind,
          lang,
          rememberSendOutcome,
        });
      });
    } catch (error) {
      await recoverUnexpectedGenerationError({
        deps,
        error,
        psid,
        userId,
        reqId,
        lang,
        resolvedGenerationKind,
        rememberSendOutcome,
      });
      return sendOutcome;
    } finally {
      clearInFlightNotice(psid);
    }

    if (didRun === null) {
      const result = await deps.maybeSendInFlightMessage(psid, reqId);
      if ("outcome" in result && result.outcome) {
        rememberSendOutcome(result.outcome);
      }
      return sendOutcome;
    }
    return sendOutcome;
  }

  async function runImageGeneration(
    psid: string,
    userId: string,
    reqId: string,
    lang: MessengerGenerationJob["lang"],
    sourceImageUrl?: string,
    promptHint?: string,
    generationKind?: GenerationKind
  ): Promise<MessengerSendOutcome> {
    const resolvedGenerationKind: GenerationKind =
      generationKind ??
      (sourceImageUrl ? "source_image_edit" : "text_to_image");
    const result = await enqueueOrRunMessengerGenerationJob(
      {
        psid,
        userId,
        generationKind: resolvedGenerationKind,
        reqId,
        lang,
        sourceImageUrl,
        promptHint,
      },
      executeImageGenerationJob,
      { onDeadLetter: processMessengerGenerationJobDeadLetter }
    );

    if (result.mode === "inline") {
      return result.outcome as MessengerSendOutcome;
    }

    await setFlowState(psid, "PROCESSING");
    try {
      await deps.sendLoggedText(psid, t(lang, "generationQueued"), reqId);
    } catch (error) {
      safeLog("messenger_generation_queued_ack_failed", {
        reqId,
        user: toLogUser(userId),
        generationKind: resolvedGenerationKind,
        error,
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

  async function processMessengerGenerationJobDeadLetter(
    input: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    await setFlowState(input.psid, "FAILURE");
    return await deps.sendLoggedText(
      input.psid,
      t(input.lang, "generationGenericFailure"),
      input.reqId
    );
  }

  return {
    runImageGeneration,
    processMessengerGenerationJob: executeImageGenerationJob,
    processMessengerGenerationJobDeadLetter,
  };
}

async function sendGenerationStartedAck(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  userId: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  resolvedGenerationKind: GenerationKind;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  try {
    input.rememberSendOutcome(
      await input.deps.sendLoggedText(
        input.psid,
        t(input.lang, "generatingImagePrompt"),
        input.reqId
      )
    );
  } catch (error) {
    logMessengerGenerationRecoveryEvent(
      "messenger_generation_started_ack_failed",
      {
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        error,
      }
    );
  }
}

async function recoverUnexpectedGenerationError(input: {
  deps: GenerationJobRunnerDeps;
  error: unknown;
  psid: string;
  userId: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  resolvedGenerationKind: GenerationKind;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  try {
    await setFlowState(input.psid, "FAILURE");
  } catch (stateError) {
    logMessengerGenerationRecoveryEvent(
      "messenger_generation_recovery_state_failed",
      {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        error: stateError,
      }
    );
    return;
  }

  logMessengerGenerationRecoveryEvent("messenger_generation_unexpected_error", {
    level: "error",
    reqId: input.reqId,
    user: toLogUser(input.userId),
    generationKind: input.resolvedGenerationKind,
    error: input.error,
  });
  recordGenerationError();

  try {
    const failureResponse = buildGenerationFailureResponse(
      input.lang,
      t(input.lang, "generationGenericFailure")
    );
    input.rememberSendOutcome(
      await input.deps.sendLoggedQuickReplies(
        input.psid,
        failureResponse.text ?? "",
        renderMessengerQuickReplies(failureResponse.actions),
        input.reqId
      )
    );
  } catch (sendError) {
    logMessengerGenerationRecoveryEvent(
      "messenger_generation_recovery_send_failed",
      {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        error: sendError,
      }
    );
  }
}

function logMessengerGenerationRecoveryEvent(
  event: string,
  details: Record<string, unknown>
): void {
  try {
    safeLog(event, details);
  } catch {
    // Recovery logging must never prevent flow-state recovery.
  }
}

async function finishDuplicateGenerationIfCompleted(input: {
  psid: string;
  userId: string;
  reqId: string;
  promptHint?: string;
  resolvedGenerationKind: GenerationKind;
}): Promise<boolean> {
  const completedGeneration = await Promise.resolve(
    getMessengerGenerationCompletion(input.reqId)
  );
  if (!completedGeneration) {
    return false;
  }

  if (
    completedGeneration.userKey &&
    completedGeneration.userKey !== input.userId
  ) {
    safeLog("messenger_generation_job_duplicate_user_mismatch", {
      reqId: input.reqId,
      expectedUser: toLogUser(input.userId),
      completionUser: toLogUser(completedGeneration.userKey),
      generationKind: input.resolvedGenerationKind,
    });
    return false;
  }

  safeLog("messenger_generation_job_duplicate_completed", {
    reqId: input.reqId,
    user: toLogUser(input.userId),
    generationKind: input.resolvedGenerationKind,
  });
  await setLastGenerated(input.psid, completedGeneration.imageUrl);
  await setLastGenerationContext(input.psid, { prompt: input.promptHint });
  await setFlowState(input.psid, "IDLE");
  return true;
}

async function reserveGenerationQuota(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<boolean> {
  const allowed = await canGenerate(input.psid);
  const quotaState = await getOrCreateState(input.psid);
  const bypassRaw = process.env.MESSENGER_QUOTA_BYPASS_IDS ?? "";
  const bypassApplied =
    bypassRaw.includes(input.psid) || bypassRaw.includes(quotaState.userKey);
  safeLog("quota_decision", {
    action: "check",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    count: quotaState.quota.count,
    limit: getFreeDailyLimit(),
    bypassApplied,
    allowed,
  });
  if (allowed) {
    return true;
  }

  input.rememberSendOutcome(
    await input.deps.sendLoggedText(
      input.psid,
      input.lang === "en"
        ? "You used your free credits for today. Come back tomorrow."
        : "Je hebt je gratis credits voor vandaag opgebruikt. Kom morgen terug.",
      input.reqId
    )
  );
  await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
  return false;
}

async function handleGenerationSuccess(input: {
  deps: GenerationJobRunnerDeps;
  generationResult: Extract<
    Awaited<ReturnType<typeof executeGenerationFlow>>,
    { kind: "success" }
  >;
  promptHint?: string;
  psid: string;
  reqId: string;
  resolvedGenerationKind: GenerationKind;
  userId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  const { imageUrl, metrics, mode, proof } = input.generationResult;
  safeLog("messenger_send_image_url", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.resolvedGenerationKind,
    imageLocation: summarizeSensitiveUrl(imageUrl),
  });
  safeLog("generation_summary", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    mode,
    generationKind: input.resolvedGenerationKind,
    ok: true,
    fb_image_fetch_ms: metrics.fbImageFetchMs ?? 0,
    prompt_build_ms: metrics.promptBuildMs ?? 0,
    openai_payload_build_ms: metrics.openAiPayloadBuildMs ?? 0,
    openai_ms: metrics.openAiMs ?? 0,
    openai_parse_ms: metrics.openAiParseMs ?? 0,
    upload_or_serve_ms: metrics.uploadOrServeMs ?? 0,
    total_ms: metrics.totalMs,
  });
  safeLog("proof_summary", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.resolvedGenerationKind,
    incomingLen: proof.incomingLen,
    incomingSha256: proof.incomingSha256,
    openaiInputLen: proof.openaiInputLen,
    openaiInputSha256: proof.openaiInputSha256,
    outputLocation: summarizeSensitiveUrl(imageUrl),
    totalMs: metrics.totalMs,
    ok: true,
  });

  const messengerSendStartedAt = Date.now();
  input.rememberSendOutcome(
    await input.deps.sendLoggedImage(input.psid, imageUrl, input.reqId)
  );
  await Promise.resolve(
    markMessengerGenerationCompleted(input.reqId, imageUrl, input.userId)
  );
  const messengerSendMs = Date.now() - messengerSendStartedAt;
  await increment(input.psid);
  await setLastGenerated(input.psid, imageUrl);
  await setLastGenerationContext(input.psid, { prompt: input.promptHint });
  recordGenerationSuccess(input.resolvedGenerationKind, metrics.totalMs);
  const successResponse = buildGenerationSuccessResponse(input.lang);
  input.rememberSendOutcome(
    await input.deps.sendLoggedQuickReplies(
      input.psid,
      successResponse.text ?? "",
      renderMessengerQuickReplies(successResponse.actions),
      input.reqId
    )
  );
  emitGenerationDiagnostic({
    generationId: input.reqId,
    senderId: input.psid,
    style: input.resolvedGenerationKind,
    success: true,
    durationsMs: {
      source_image_downloaded: metrics.fbImageFetchMs ?? 0,
      prompt_built: metrics.promptBuildMs ?? 0,
      provider_payload_built: metrics.openAiPayloadBuildMs ?? 0,
      provider_request: metrics.openAiMs ?? 0,
      provider_response_parsed: metrics.openAiParseMs ?? 0,
      result_uploaded_or_stored: metrics.uploadOrServeMs ?? 0,
      messenger_send: messengerSendMs,
      total: metrics.totalMs + messengerSendMs,
    },
  });
  await setFlowState(input.psid, "IDLE");
}

async function handleGenerationFailure(input: {
  deps: GenerationJobRunnerDeps;
  generationResult: Extract<
    Awaited<ReturnType<typeof executeGenerationFlow>>,
    { kind: "error" }
  >;
  psid: string;
  reqId: string;
  resolvedGenerationKind: GenerationKind;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  const error = input.generationResult.error;
  safeLog("openai_call_error", {
    level: "error",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    error,
  });

  const errorClass =
    error instanceof Error ? error.constructor.name : "UnknownError";
  const metrics = input.generationResult.metrics ??
    getGenerationMetrics(error) ?? { totalMs: 0 };

  safeLog("proof_summary", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.resolvedGenerationKind,
    ok: false,
    errorCode: errorClass,
    totalMs: metrics.totalMs,
  });
  emitGenerationDiagnostic({
    generationId: input.reqId,
    senderId: input.psid,
    style: input.resolvedGenerationKind,
    success: false,
    failureReason: input.generationResult.errorKind,
    durationsMs: {
      source_image_downloaded: metrics.fbImageFetchMs ?? 0,
      prompt_built: metrics.promptBuildMs ?? 0,
      provider_payload_built: metrics.openAiPayloadBuildMs ?? 0,
      provider_request: metrics.openAiMs ?? 0,
      provider_response_parsed: metrics.openAiParseMs ?? 0,
      result_uploaded_or_stored: metrics.uploadOrServeMs ?? 0,
      total: metrics.totalMs,
    },
  });
  recordGenerationError();

  const failure = getGenerationFailureMessage(
    input.generationResult.errorKind,
    input.lang
  );
  if (failure.handled) {
    input.rememberSendOutcome(
      await input.deps.sendLoggedText(input.psid, failure.text, input.reqId)
    );
    await setFlowState(input.psid, failure.nextState);
    return;
  }

  if (failure.sendGenericFailureLead) {
    input.rememberSendOutcome(
      await input.deps.sendLoggedText(
        input.psid,
        t(input.lang, "failure"),
        input.reqId
      )
    );
  }
  await setFlowState(input.psid, "FAILURE");

  const failureResponse = buildGenerationFailureResponse(
    input.lang,
    failure.failureText
  );
  input.rememberSendOutcome(
    await input.deps.sendLoggedQuickReplies(
      input.psid,
      failureResponse.text ?? "",
      renderMessengerQuickReplies(failureResponse.actions),
      input.reqId
    )
  );
}

function getGenerationFailureMessage(
  errorKind: Extract<
    Awaited<ReturnType<typeof executeGenerationFlow>>,
    { kind: "error" }
  >["errorKind"],
  lang: MessengerGenerationJob["lang"]
):
  | {
      handled: true;
      text: string;
      nextState: "AWAITING_PHOTO" | "AWAITING_EDIT_PROMPT";
    }
  | { handled: false; failureText: string; sendGenericFailureLead: boolean } {
  if (errorKind === "missing_source_image") {
    return {
      handled: true,
      text: t(lang, "editRequiresPhoto"),
      nextState: "AWAITING_PHOTO",
    };
  }
  if (
    errorKind === "missing_input_image" ||
    errorKind === "invalid_source_image"
  ) {
    return {
      handled: true,
      text: t(lang, "missingInputImage"),
      nextState: "AWAITING_PHOTO",
    };
  }
  if (errorKind === "generation_budget_reached") {
    return {
      handled: true,
      text: t(lang, "generationBudgetReached"),
      nextState: "AWAITING_EDIT_PROMPT",
    };
  }
  if (errorKind === "generation_unavailable") {
    return {
      handled: false,
      failureText: t(lang, "generationUnavailable"),
      sendGenericFailureLead: true,
    };
  }
  if (errorKind === "generation_timeout") {
    return {
      handled: false,
      failureText: t(lang, "generationTimeout"),
      sendGenericFailureLead: false,
    };
  }
  return {
    handled: false,
    failureText: t(lang, "generationGenericFailure"),
    sendGenericFailureLead: true,
  };
}
