import type { MessengerSendOutcome } from "./messengerApi";
import { safeLog } from "./messengerApi";
import { getGenerationMetrics } from "./image-generation/openAiImageClient";
import { executeGenerationFlow } from "./generationFlow";
import {
  buildFreeQuotaReachedResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
  buildStartpilotQuotaReachedResponse,
} from "./conversationActions";
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
import {
  recordGenerationError,
  recordGenerationSuccess,
  recordMessengerDeliveryFailure,
  recordMessengerDuplicateSkip,
} from "./botRuntimeStats";
import { emitGenerationDiagnostic } from "./generationDiagnostics";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import type { GenerationKind } from "./image-generation/generationTypes";
import type { ImageGenerationQuotaReservation } from "./limits/generationQuota";
import {
  MessengerQuotaReservationCommitError,
} from "./messengerQuota";
import { isMessengerAdmin } from "./messengerAdmin";
import {
  buildGenerationFailureDiagnosticPayload,
  buildGenerationSuccessDiagnosticPayload,
  commitMessengerGenerationQuota,
  getGenerationFailureMessage,
  releaseMessengerGenerationQuota,
  reserveMessengerGenerationQuota,
  resolveGenerationKind,
} from "./generation/generationJobCore";
import {
  enqueueOrRunMessengerGenerationJob,
  isMessengerGenerationQueueEnabled,
} from "./messengerGenerationQueue";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDelivered,
  type MessengerGenerationCompletionFence,
} from "./messengerGenerationCompletion";
import {
  MESSENGER_ASYNC_RESPONSE_QUEUED,
  MESSENGER_SEND_SKIPPED,
  combineMessengerSendOutcomes,
} from "./webhookFallback";
import { clearInFlightNotice } from "./webhookHandlerContext";
import type { HandlerContext } from "./webhookHandlerTypes";
import {
  getMessengerRequestPageId,
  runWithMessengerRequestContext,
  setMessengerRequestOperationId,
} from "./messengerRequestContext";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
  resolveWorkspaceRuntimePolicy,
  type StartpilotRuntimePolicy,
} from "./workspaceEntitlementRuntime";
import {
  assertMessengerPrivacySubject,
  ensureActiveMessengerPrivacySubject,
  MessengerPrivacyFenceError,
} from "./messengerPrivacySubject";
import { reserveStartpilotImageUsage } from "./billing/entitlementUsageStore";
import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";

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
  | "sendLoggedActions"
  | "sendLoggedText"
>;

class MessengerGenerationDeliveryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Messenger image delivery failed");
    this.name = "MessengerGenerationDeliveryError";
    this.cause = cause;
  }
}

class StartpilotImageQuotaExceededError extends Error {
  readonly reason: "total_exhausted" | "daily_exhausted";

  constructor(reason: "total_exhausted" | "daily_exhausted") {
    super("Startpilot image quota reached");
    this.name = "StartpilotImageQuotaExceededError";
    this.reason = reason;
  }
}

/** Creates the Messenger image-generation job runner and queue/dead-letter entry points. */
export function createMessengerGenerationJobRunner(
  deps: GenerationJobRunnerDeps
): GenerationJobRunner {
  async function executeImageGenerationJob(
    job: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    return await runWithMessengerRequestContext(
      job.pageId,
      () => {
        setMessengerRequestOperationId(job.reqId);
        return executeImageGenerationJobInPageContext(job);
      },
      job.workspaceId && job.channelConnectionId && job.bindingEpoch
        ? {
            workspaceId: job.workspaceId,
            channelConnectionId: job.channelConnectionId,
            bindingEpoch: job.bindingEpoch,
            userKey: job.userId,
            privacyEpoch: job.privacyEpoch,
          }
        : undefined
    );
  }

  async function executeImageGenerationJobInPageContext(
    job: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    await assertMessengerGenerationOwnership(job);
    await assertGenerationJobPrivacy(job);
    const {
      psid,
      userId,
      generationKind,
      reqId,
      lang,
      sourceImageUrl,
      sourceImageUrls,
      promptHint,
      pageId,
    } = job;
    const resolvedGenerationKind = resolveGenerationKind({
      generationKind,
      sourceImageUrl,
    });
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
            deps,
            psid,
            userId,
            reqId,
            lang,
            promptHint,
            resolvedGenerationKind,
            rememberSendOutcome,
            completionFence: completionFenceForJob(job),
          })
        ) {
          return;
        }

        const workspacePolicy = await resolveWorkspaceRuntimePolicy(pageId);
        const ownerQuotaBypass = isMessengerAdmin(psid, userId);
        const useStartpilotQuota =
          workspacePolicy.kind === "startpilot" && !ownerQuotaBypass;
        const quotaReservation =
          !useStartpilotQuota
            ? await reserveGenerationQuota({
                deps,
                psid,
                reqId,
                lang,
                rememberSendOutcome,
              })
            : null;
        if (!useStartpilotQuota && !quotaReservation) {
          return;
        }

        let pendingQuotaReservation: ImageGenerationQuotaReservation | null =
          quotaReservation;
        let providerAttemptsCommitted = 0;
        let providerFenceSequence = 0;
        const providerFences: MessengerProviderAttemptFence[] = [];
        try {
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
          const commitProviderAttemptQuota = async () => {
            await assertMessengerGenerationOwnership(job);
            await assertGenerationJobPrivacy(job);
            providerFenceSequence += 1;
            const providerFence = await reserveMessengerProviderAttemptFence(
              job,
              resolvedGenerationKind,
              providerFenceSequence
            );
            try {
              if (
                useStartpilotQuota &&
                workspacePolicy.kind === "startpilot"
              ) {
                if (providerAttemptsCommitted === 0) {
                  await commitStartpilotProviderAttempt(workspacePolicy);
                  providerAttemptsCommitted += 1;
                }
              } else {
                const reservationForAttempt =
                  pendingQuotaReservation ??
                  (await reserveMessengerGenerationQuota({
                    psid,
                    userKey: userId,
                    quotaCount: (await getOrCreateState(psid)).quota.count,
                  }));

                if (!reservationForAttempt) {
                  throw new MessengerQuotaReservationCommitError();
                }

                await commitMessengerGenerationQuota({
                  psid,
                  reservation: reservationForAttempt,
                  generationKind: resolvedGenerationKind,
                });
                providerAttemptsCommitted += 1;
                if (
                  pendingQuotaReservation?.token === reservationForAttempt.token
                ) {
                  pendingQuotaReservation = null;
                }
              }
            } catch (error) {
              await finalizeMessengerProviderAttemptFence(
                providerFence,
                "known_failed"
              );
              throw error;
            }
            await markMessengerProviderAttemptStarted(providerFence);
            providerFences.push(providerFence);
          };

          const generationResult = await executeGenerationFlow({
            generationKind: resolvedGenerationKind,
            userId,
            reqId,
            promptHint,
            sourceImageUrl: shouldSendSourceImage ? sourceImageUrl : undefined,
            sourceImageUrls: shouldSendSourceImage
              ? sourceImageUrls
              : undefined,
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
            onProviderAttempt: commitProviderAttemptQuota,
            bypassBudgetLimits: ownerQuotaBypass,
            imageModel:
              workspacePolicy.kind === "startpilot"
                ? workspacePolicy.imageModel
                : undefined,
            imageQuality:
              workspacePolicy.kind === "startpilot"
                ? workspacePolicy.imageQuality
                : undefined,
          });

          if (generationResult.kind === "success") {
            try {
              if (providerAttemptsCommitted === 0) {
                await commitProviderAttemptQuota();
              }
              await assertMessengerGenerationOwnership(job);
              await assertGenerationJobPrivacy(job);
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
                completionFence: completionFenceForJob(job),
              });
            } catch (error) {
              if (error instanceof MessengerPrivacyFenceError) {
                const key = storageKeyFromPublicUrl(generationResult.imageUrl);
                if (key) await storageDelete(key);
              }
              throw error;
            }
            await Promise.all(
              providerFences.map(fence =>
                finalizeMessengerProviderAttemptFence(fence, "succeeded")
              )
            );
            providerFences.length = 0;
            return;
          }

          await Promise.all(
            providerFences.map(fence =>
              finalizeMessengerProviderAttemptFence(fence, "ambiguous")
            )
          );
          providerFences.length = 0;

          await handleGenerationFailure({
            deps,
            generationResult,
            psid,
            reqId,
            resolvedGenerationKind,
            lang,
            rememberSendOutcome,
          });
        } finally {
          await Promise.all(
            providerFences.map(fence =>
              finalizeMessengerProviderAttemptFence(fence, "ambiguous")
            )
          );
          if (pendingQuotaReservation) {
            await releaseMessengerGenerationQuota({
              psid,
              reservation: pendingQuotaReservation,
            });
          }
        }
      });
    } catch (error) {
      if (error instanceof MessengerPrivacyFenceError) {
        return MESSENGER_SEND_SKIPPED;
      }
      if (error instanceof MessengerGenerationDeliveryError) {
        recordMessengerDeliveryFailure();
        safeLog("messenger_generation_image_delivery_failed", {
          level: "error",
          reqId,
          user: toLogUser(userId),
          generationKind: resolvedGenerationKind,
          queueEnabled: isMessengerGenerationQueueEnabled(),
          error: error.cause,
        });
        if (!isMessengerGenerationQueueEnabled()) {
          await setFlowState(psid, "IDLE");
          return sendOutcome;
        }
        throw error;
      }
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
      const result = await deps.maybeSendInFlightMessage(psid, reqId, lang);
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
    const resolvedGenerationKind = resolveGenerationKind({
      generationKind,
      sourceImageUrl,
    });
    const pageId = getMessengerRequestPageId();
    const ownership = await resolveMessengerGenerationOwnership(pageId);
    const privacyEpoch = ownership
      ? await ensureActiveMessengerPrivacySubject({
          workspaceId: ownership.workspaceId,
          channelConnectionId: ownership.channelConnectionId,
          userKey: userId,
        })
      : undefined;
    const currentState = await getOrCreateState(psid);
    const sourceImageUrls =
      resolvedGenerationKind === "source_image_edit" &&
      sourceImageUrl &&
      currentState.pendingImageUrls?.includes(sourceImageUrl)
        ? currentState.pendingImageUrls
        : sourceImageUrl
          ? [sourceImageUrl]
          : undefined;
    const result = await enqueueOrRunMessengerGenerationJob(
      {
        psid,
        userId,
        pageId,
        workspaceId: ownership?.workspaceId,
        channelConnectionId: ownership?.channelConnectionId,
        bindingEpoch: ownership?.bindingEpoch,
        privacyEpoch,
        generationKind: resolvedGenerationKind,
        reqId,
        lang,
        sourceImageUrl,
        sourceImageUrls,
        promptHint,
      },
      executeImageGenerationJob,
      { onDeadLetter: processMessengerGenerationJobDeadLetter }
    );

    if (result.mode === "inline") {
      return result.outcome as MessengerSendOutcome;
    }
    if (result.mode === "duplicate") {
      return MESSENGER_ASYNC_RESPONSE_QUEUED;
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
    return await runWithMessengerRequestContext(
      input.pageId,
      async () => {
        setMessengerRequestOperationId(input.reqId);
        try {
          await assertGenerationJobPrivacy(input);
        } catch (error) {
          if (error instanceof MessengerPrivacyFenceError) {
            return MESSENGER_SEND_SKIPPED;
          }
          throw error;
        }
        await setFlowState(input.psid, "FAILURE");
        return await deps.sendLoggedText(
          input.psid,
          t(input.lang, "generationGenericFailure"),
          input.reqId
        );
      },
      input.workspaceId && input.channelConnectionId && input.bindingEpoch
        ? {
            workspaceId: input.workspaceId,
            channelConnectionId: input.channelConnectionId,
            bindingEpoch: input.bindingEpoch,
            userKey: input.userId,
            privacyEpoch: input.privacyEpoch,
          }
        : undefined
    );
  }

  return {
    runImageGeneration,
    processMessengerGenerationJob: executeImageGenerationJob,
    processMessengerGenerationJobDeadLetter,
  };
}

async function assertGenerationJobPrivacy(
  job: MessengerGenerationJob
): Promise<void> {
  if (
    job.workspaceId &&
    job.channelConnectionId &&
    job.privacyEpoch &&
    job.userId
  ) {
    await assertMessengerPrivacySubject({
      workspaceId: job.workspaceId,
      channelConnectionId: job.channelConnectionId,
      userKey: job.userId,
      privacyEpoch: job.privacyEpoch,
    });
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new MessengerPrivacyFenceError();
  }
}

async function commitStartpilotProviderAttempt(
  policy: StartpilotRuntimePolicy
): Promise<void> {
  const decision = await reserveStartpilotImageUsage({
    workspaceId: policy.workspaceId,
    entitlementId: policy.entitlementId,
    mode: policy.mode,
  });
  if (!decision.allowed) {
    throw new StartpilotImageQuotaExceededError(decision.reason);
  }
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
      await input.deps.sendLoggedActions(
        input.psid,
        failureResponse.text ?? "",
        failureResponse.actions ?? [],
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
  deps: GenerationJobRunnerDeps;
  psid: string;
  userId: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  promptHint?: string;
  resolvedGenerationKind: GenerationKind;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  completionFence?: MessengerGenerationCompletionFence;
}): Promise<boolean> {
  const completedGeneration = await Promise.resolve(
    getMessengerGenerationCompletion(input.reqId, input.completionFence)
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
    deliveryStatus: completedGeneration.deliveryStatus ?? "legacy_completed",
  });
  recordMessengerDuplicateSkip();
  await setLastGenerated(input.psid, completedGeneration.imageUrl);
  await setLastGenerationContext(input.psid, { prompt: input.promptHint });
  if (completedGeneration.deliveryStatus === "pending") {
    safeLog("messenger_generation_job_duplicate_delivery_recovered", {
      reqId: input.reqId,
      user: toLogUser(input.userId),
      generationKind: input.resolvedGenerationKind,
    });
    await deliverGenerationImage({
      deps: input.deps,
      psid: input.psid,
      imageUrl: completedGeneration.imageUrl,
      reqId: input.reqId,
      userId: input.userId,
      rememberSendOutcome: input.rememberSendOutcome,
      completionFence: input.completionFence,
    });
    await sendGenerationSuccessActions({
      deps: input.deps,
      psid: input.psid,
      reqId: input.reqId,
      lang: input.lang,
      rememberSendOutcome: input.rememberSendOutcome,
    });
  }
  await setFlowState(input.psid, "IDLE");
  return true;
}

async function reserveGenerationQuota(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<ImageGenerationQuotaReservation | null> {
  const quotaState = await getOrCreateState(input.psid);
  const reservation = await reserveMessengerGenerationQuota({
    psid: input.psid,
    userKey: quotaState.userKey,
    quotaCount: quotaState.quota.count,
  });
  if (reservation) {
    return reservation;
  }

  const response = buildFreeQuotaReachedResponse(input.lang);
  input.rememberSendOutcome(
    await input.deps.sendLoggedActions(
      input.psid,
      response.text ?? t(input.lang, "outOfFreeCredits"),
      response.actions ?? [],
      input.reqId
    )
  );
  await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
  return null;
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
  completionFence?: MessengerGenerationCompletionFence;
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

  await Promise.resolve(
    markMessengerGenerationCompleted(
      input.reqId,
      imageUrl,
      input.userId,
      Date.now(),
      input.completionFence
    )
  );
  await setLastGenerated(input.psid, imageUrl);
  await setLastGenerationContext(input.psid, { prompt: input.promptHint });

  const messengerSendMs = await deliverGenerationImage({
    deps: input.deps,
    psid: input.psid,
    imageUrl,
    reqId: input.reqId,
    userId: input.userId,
    rememberSendOutcome: input.rememberSendOutcome,
    completionFence: input.completionFence,
  });
  recordGenerationSuccess(input.resolvedGenerationKind, metrics.totalMs);
  await sendGenerationSuccessActions({
    deps: input.deps,
    psid: input.psid,
    reqId: input.reqId,
    lang: input.lang,
    rememberSendOutcome: input.rememberSendOutcome,
  });
  emitGenerationDiagnostic(
    buildGenerationSuccessDiagnosticPayload({
      reqId: input.reqId,
      psid: input.psid,
      generationKind: input.resolvedGenerationKind,
      metrics,
      messengerSendMs,
    })
  );
  await setFlowState(input.psid, "IDLE");
}

async function deliverGenerationImage(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  imageUrl: string;
  reqId: string;
  userId: string;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  completionFence?: MessengerGenerationCompletionFence;
}): Promise<number> {
  const messengerSendStartedAt = Date.now();
  let outcome: MessengerSendOutcome;
  try {
    outcome = await input.deps.sendLoggedImage(
      input.psid,
      input.imageUrl,
      input.reqId
    );
  } catch (error) {
    throw new MessengerGenerationDeliveryError(error);
  }

  input.rememberSendOutcome(outcome);
  if (!outcome.sent) {
    throw new MessengerGenerationDeliveryError(
      new Error(`Messenger image send skipped: ${outcome.reason}`)
    );
  }

  try {
    await markMessengerGenerationDelivered(
      input.reqId,
      input.imageUrl,
      input.userId,
      Date.now(),
      input.completionFence
    );
  } catch (error) {
    safeLog("messenger_generation_delivery_marker_failed", {
      level: "error",
      reqId: input.reqId,
      user: toLogUser(input.userId),
      error,
    });
  }
  return Date.now() - messengerSendStartedAt;
}

function completionFenceForJob(
  job: MessengerGenerationJob
): MessengerGenerationCompletionFence | undefined {
  if (
    !job.workspaceId ||
    !job.channelConnectionId ||
    !job.bindingEpoch ||
    !job.privacyEpoch
  ) {
    if (process.env.NODE_ENV !== "production") return undefined;
    throw new MessengerPrivacyFenceError();
  }
  return {
    workspaceId: job.workspaceId,
    channelConnectionId: job.channelConnectionId,
    bindingEpoch: job.bindingEpoch,
    privacyEpoch: job.privacyEpoch,
    userKey: job.userId,
    pageId: job.pageId ?? "",
  };
}

async function sendGenerationSuccessActions(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  const successResponse = buildGenerationSuccessResponse(input.lang);
  input.rememberSendOutcome(
    await input.deps.sendLoggedActions(
      input.psid,
      successResponse.text ?? "",
      successResponse.actions ?? [],
      input.reqId
    )
  );
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
  emitGenerationDiagnostic(
    buildGenerationFailureDiagnosticPayload({
      reqId: input.reqId,
      psid: input.psid,
      generationKind: input.resolvedGenerationKind,
      metrics,
      failureReason: input.generationResult.errorKind,
    })
  );
  recordGenerationError();

  if (error instanceof StartpilotImageQuotaExceededError) {
    safeLog("startpilot_image_quota_blocked", {
      reqId: input.reqId,
      reason: error.reason,
    });
    const response = buildStartpilotQuotaReachedResponse(input.lang);
    input.rememberSendOutcome(
      await input.deps.sendLoggedActions(
        input.psid,
        response.text ?? "",
        response.actions ?? [],
        input.reqId
      )
    );
    await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
    return;
  }

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
    await input.deps.sendLoggedActions(
      input.psid,
      failureResponse.text ?? "",
      failureResponse.actions ?? [],
      input.reqId
    )
  );
}
