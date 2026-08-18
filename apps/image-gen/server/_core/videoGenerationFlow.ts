import { storageDelete, storagePut } from "../storage";
import {
  appendCostLedgerEntry,
  safelyUpdateCostLedgerEntry,
} from "./costLedger";
import { safeLog } from "./messengerApi";
import { anonymizePsid, setLastGeneratedVideo } from "./messengerState";
import { t, type Lang } from "./i18n";
import { toLogUser } from "./privacy";
import {
  commitVideoGenerationSuccess,
  MessengerQuotaReservationCommitError,
  releaseVideoGenerationReservation,
  reserveVideoGenerationForAttempt,
  type VideoGenerationQuotaReservation,
} from "./messengerQuota";
import {
  admitMessengerProviderSpend,
  assertMessengerDailyVideoBudgetAvailable,
  MessengerSpendBudgetExceededError,
  MessengerDailyVideoBudgetExceededError,
  releaseMessengerDailyVideoBudgetReservation,
  runGuardedVideoGeneration,
} from "./generationGuard";
import {
  getMessengerVideoFlowTimeoutMs,
  getMessengerVideoTimeoutMs,
} from "./video-generation/videoConfig";
import {
  deleteProviderVideoForUser,
  getVideoProvider,
} from "./video-generation/videoProviderRegistry";
import type { VideoProvider } from "./video-generation/videoProvider";
import type { MessengerSendOutcome } from "./messengerApi";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
} from "./workspaceEntitlementRuntime";
import {
  assertMessengerPrivacySubject,
  ensureActiveMessengerPrivacySubject,
  MessengerPrivacyFenceError,
} from "./messengerPrivacySubject";
import { getMessengerRequestPageId } from "./messengerRequestContext";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";

function getVideoProviderName(provider: VideoProvider): string {
  const configuredProvider =
    process.env.MESSENGER_VIDEO_PROVIDER?.trim().toLowerCase();
  if (configuredProvider) {
    return configuredProvider;
  }

  const providerName = (provider as { name?: string }).name?.trim();
  if (providerName) {
    return providerName.toLowerCase();
  }

  if (provider.constructor.name === "OpenAiVideoProvider") {
    return "openai-video";
  }

  if (!provider.constructor.name || provider.constructor.name === "Object") {
    return "video-provider";
  }

  return provider.constructor.name.toLowerCase();
}

function readUsdEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function estimateVideoGenerationAttemptCost(): {
  estimatedCostUsd: number | null;
  finalCostUsd: number | null;
  costEstimateComplete: boolean;
  estimateSource: string;
  unpricedCostComponents: string[];
} {
  const override = readUsdEnv("OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD");
  if (override !== null) {
    return {
      estimatedCostUsd: override,
      finalCostUsd: override,
      costEstimateComplete: true,
      estimateSource: "env_override",
      unpricedCostComponents: [],
    };
  }

  return {
    estimatedCostUsd: null,
    finalCostUsd: null,
    costEstimateComplete: false,
    estimateSource: "unpriced",
    unpricedCostComponents: ["video_generation"],
  };
}

type VideoGenerationDeps = {
  maybeSendInFlightMessage: (
    psid: string,
    reqId: string,
    lang: Lang
  ) => Promise<{ handled: boolean; outcome?: MessengerSendOutcome }>;
  sendLoggedText: (
    psid: string,
    text: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedVideo: (
    psid: string,
    videoUrl: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
};

type VideoNotificationPhase =
  | "quota_exhausted"
  | "generation_started"
  | "provider_failed"
  | "flow_timeout"
  | "budget_or_internal_failed"
  | "video_delivered";

type VideoFlowDeadline = {
  startedAt: number;
  timeoutMs: number;
};

function buildGeneratedVideoKey(reqId: string): string {
  const safeReqId = reqId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return `generated/videos/${Date.now()}-${safeReqId || "video"}.mp4`;
}

async function storeGeneratedVideo(input: {
  reqId: string;
  videoBytes: Uint8Array;
  contentType: "video/mp4";
}): Promise<{ key: string; url: string }> {
  return await storagePut(
    buildGeneratedVideoKey(input.reqId),
    input.videoBytes,
    input.contentType
  );
}

async function releaseReservation(
  psid: string,
  reservation: VideoGenerationQuotaReservation | null
): Promise<void> {
  if (reservation) {
    await releaseVideoGenerationReservation(psid, reservation);
  }
}

function createVideoFlowDeadline(): VideoFlowDeadline {
  return {
    startedAt: Date.now(),
    timeoutMs: getMessengerVideoFlowTimeoutMs(),
  };
}

function hasVideoFlowTimedOut(deadline: VideoFlowDeadline): boolean {
  return Date.now() - deadline.startedAt >= deadline.timeoutMs;
}

async function sendVideoText(
  deps: VideoGenerationDeps,
  psid: string,
  text: string,
  reqId: string,
  phase: VideoNotificationPhase
): Promise<MessengerSendOutcome> {
  const outcome = await deps.sendLoggedText(psid, text, reqId);
  logNotificationOutcome(outcome, reqId, phase);
  return outcome;
}

async function sendVideoAttachment(
  deps: VideoGenerationDeps,
  psid: string,
  videoUrl: string,
  reqId: string
): Promise<MessengerSendOutcome> {
  const outcome = await deps.sendLoggedVideo(psid, videoUrl, reqId);
  logNotificationOutcome(outcome, reqId, "video_delivered");
  return outcome;
}

function logNotificationOutcome(
  outcome: MessengerSendOutcome,
  reqId: string,
  phase: VideoNotificationPhase
): void {
  if (outcome.sent) {
    return;
  }

  safeLog("messenger_video_generation_notification_skipped", {
    level: "warn",
    reqId,
    phase,
    reason: outcome.reason,
  });
}

export function createMessengerVideoGenerationRunner(
  deps: VideoGenerationDeps
) {
  return async function runVideoGeneration(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    sourceImageUrl: string,
    promptHint: string
  ): Promise<MessengerSendOutcome> {
    const pageId = getMessengerRequestPageId();
    const ownership = await resolveMessengerGenerationOwnership(pageId);
    if (!ownership && process.env.NODE_ENV === "production") {
      return { sent: false, reason: "response_window_closed" };
    }
    const privacyEpoch = ownership
      ? await ensureActiveMessengerPrivacySubject({
          workspaceId: ownership.workspaceId,
          channelConnectionId: ownership.channelConnectionId,
          userKey: userId,
        })
      : undefined;
    const fenceJob: MessengerGenerationJob = {
      psid,
      userId,
      reqId,
      lang,
      pageId,
      workspaceId: ownership?.workspaceId,
      channelConnectionId: ownership?.channelConnectionId,
      bindingEpoch: ownership?.bindingEpoch,
      privacyEpoch,
      sourceImageUrl,
      promptHint,
    };
    const assertVideoFence = async () => {
      await assertMessengerGenerationOwnership(fenceJob);
      if (ownership && privacyEpoch) {
        await assertMessengerPrivacySubject({
          workspaceId: ownership.workspaceId,
          channelConnectionId: ownership.channelConnectionId,
          userKey: userId,
          privacyEpoch,
        });
      } else if (process.env.NODE_ENV === "production") {
        throw new MessengerPrivacyFenceError();
      }
    };
    let sendOutcome: MessengerSendOutcome = {
      sent: false,
      reason: "response_window_closed",
    };
    const existingInFlight = await deps.maybeSendInFlightMessage(
      psid,
      reqId,
      lang
    );
    if (existingInFlight.handled) {
      return existingInFlight.outcome ?? sendOutcome;
    }

    const didRun = await runGuardedVideoGeneration(psid, async () => {
      let pendingQuotaReservation: VideoGenerationQuotaReservation | null =
        null;
      let lastVideoLedgerEntryId: string | null = null;
      let lastVideoLedgerEntryRecordedAt: Date | null = null;
      let lastVideoLedgerEntrySucceeded = false;
      const providerFences: MessengerProviderAttemptFence[] = [];
      let generatedStorageKey: string | null = null;
      let generatedProviderArtifact: {
        provider: string;
        providerJobId: string;
      } | null = null;
      let deliveryCompleted = false;
      const flowDeadline = createVideoFlowDeadline();
      try {
        pendingQuotaReservation = await reserveVideoGenerationForAttempt(psid);
        if (!pendingQuotaReservation) {
          sendOutcome = await sendVideoText(
            deps,
            psid,
            t(lang, "outOfVideoCredits"),
            reqId,
            "quota_exhausted"
          );
          return;
        }

        await sendVideoText(
          deps,
          psid,
          t(lang, "generatingVideoPrompt"),
          reqId,
          "generation_started"
        );
        const provider = getVideoProvider();
        const costEstimate = estimateVideoGenerationAttemptCost();
        let providerAttemptCount = 0;
        const commitProviderAttemptQuota = async () => {
          await assertVideoFence();
          const budgetNow = new Date();
          providerAttemptCount += 1;
          const providerFence = await reserveMessengerProviderAttemptFence(
            fenceJob,
            `video:${getVideoProviderName(provider)}`,
            providerAttemptCount
          );
          const ledgerEntryId = `${reqId}:video:${providerAttemptCount}`;
          try {
            await assertMessengerDailyVideoBudgetAvailable({
              reqId,
              now: budgetNow,
            });
            const admitted = await admitMessengerProviderSpend({
              reqId,
              attemptId: ledgerEntryId,
              userKey: userId,
              estimatedCostUsd: costEstimate.estimatedCostUsd,
              estimatedOutputCostUsd: null,
              costEstimateComplete: costEstimate.costEstimateComplete,
              now: budgetNow,
              recordAttempt: async () => {
                const reservationForAttempt =
                  pendingQuotaReservation ??
                  (await reserveVideoGenerationForAttempt(psid));
                if (!reservationForAttempt) {
                  throw new MessengerQuotaReservationCommitError(
                    "Messenger video quota reservation could not be committed"
                  );
                }

                const committed = await commitVideoGenerationSuccess(
                  psid,
                  reservationForAttempt
                );
                if (!committed) {
                  throw new MessengerQuotaReservationCommitError(
                    "Messenger video quota reservation could not be committed"
                  );
                }
                if (
                  pendingQuotaReservation?.token === reservationForAttempt.token
                ) {
                  pendingQuotaReservation = null;
                }

                safeLog("messenger_video_quota_decision", {
                  action: "commit_provider_attempt",
                  reqId,
                  user: toLogUser(userId),
                  allowed: true,
                });
                if (lastVideoLedgerEntryId && lastVideoLedgerEntryRecordedAt) {
                  await safelyUpdateCostLedgerEntry(
                    lastVideoLedgerEntryId,
                    { status: "provider_attempt_failed" },
                    lastVideoLedgerEntryRecordedAt
                  );
                }
                await appendCostLedgerEntry(
                  {
                    id: ledgerEntryId,
                    channel: "facebook_messenger",
                    operation: "video_generation",
                    provider: getVideoProviderName(provider),
                    model: null,
                    userKey: userId,
                    reqId,
                    status: "provider_attempt_started",
                    estimatedCostUsd: costEstimate.estimatedCostUsd,
                    estimatedOutputCostUsd: null,
                    finalCostUsd: null,
                    costEstimateComplete: costEstimate.costEstimateComplete,
                    estimateSource: costEstimate.estimateSource,
                    unpricedCostComponents: costEstimate.unpricedCostComponents,
                  },
                  budgetNow
                );
                lastVideoLedgerEntryId = ledgerEntryId;
                lastVideoLedgerEntryRecordedAt = budgetNow;
                lastVideoLedgerEntrySucceeded = false;
                return ledgerEntryId;
              },
            });
            await assertVideoFence();
            await markMessengerProviderAttemptStarted(providerFence);
            providerFences.push(providerFence);
            return admitted;
          } catch (error) {
            await finalizeMessengerProviderAttemptFence(
              providerFence,
              "known_failed"
            );
            await releaseMessengerDailyVideoBudgetReservation({
              now: budgetNow,
            });
            throw error;
          }
        };
        safeLog("messenger_video_generation_started", {
          reqId,
          user: toLogUser(userId),
          psidHash: anonymizePsid(psid).slice(0, 12),
        });

        const providerResult = await provider.generateVideo({
          prompt: promptHint,
          sourceImageUrl,
          reqId,
          userKey: userId,
          timeoutMs: getMessengerVideoTimeoutMs(),
          onProviderAttempt: commitProviderAttemptQuota,
        });

        await assertVideoFence();

        if (providerResult.kind === "failure") {
          await Promise.all(
            providerFences.map(fence =>
              finalizeMessengerProviderAttemptFence(fence, "ambiguous")
            )
          );
          providerFences.length = 0;
          if (lastVideoLedgerEntryId && lastVideoLedgerEntryRecordedAt) {
            await safelyUpdateCostLedgerEntry(
              lastVideoLedgerEntryId,
              { status: "provider_attempt_failed" },
              lastVideoLedgerEntryRecordedAt
            );
          }
          safeLog("messenger_video_generation_provider_failed", {
            level: "warn",
            reqId,
            provider: providerResult.provider,
            errorClass: providerResult.errorClass,
            retryable: providerResult.retryable,
          });
          sendOutcome = await sendVideoText(
            deps,
            psid,
            providerResult.errorClass === "timeout"
              ? t(lang, "videoGenerationTimeout")
              : t(lang, "videoGenerationGenericFailure"),
            reqId,
            "provider_failed"
          );
          return;
        }

        generatedProviderArtifact = {
          provider: providerResult.provider,
          providerJobId: providerResult.providerJobId,
        };
        await Promise.all(
          providerFences.map(fence =>
            finalizeMessengerProviderAttemptFence(fence, "succeeded")
          )
        );
        providerFences.length = 0;

        if (lastVideoLedgerEntryId && lastVideoLedgerEntryRecordedAt) {
          await safelyUpdateCostLedgerEntry(
            lastVideoLedgerEntryId,
            {
              status: "provider_attempt_succeeded",
              finalCostUsd: costEstimate.finalCostUsd,
            },
            lastVideoLedgerEntryRecordedAt
          );
          lastVideoLedgerEntrySucceeded = true;
        }

        if (hasVideoFlowTimedOut(flowDeadline)) {
          if (
            lastVideoLedgerEntryId &&
            lastVideoLedgerEntryRecordedAt &&
            !lastVideoLedgerEntrySucceeded
          ) {
            await safelyUpdateCostLedgerEntry(
              lastVideoLedgerEntryId,
              { status: "provider_attempt_failed" },
              lastVideoLedgerEntryRecordedAt
            );
          }
          safeLog("messenger_video_generation_flow_timeout", {
            level: "warn",
            reqId,
            timeoutMs: flowDeadline.timeoutMs,
          });
          sendOutcome = await sendVideoText(
            deps,
            psid,
            t(lang, "videoGenerationTimeout"),
            reqId,
            "flow_timeout"
          );
          return;
        }

        const storedVideo = await storeGeneratedVideo({
          reqId,
          videoBytes: providerResult.videoBytes,
          contentType: providerResult.contentType,
        });
        generatedStorageKey = storedVideo.key;

        try {
          await assertVideoFence();
        } catch (error) {
          await storageDelete(storedVideo.key).catch(() => undefined);
          throw error;
        }

        if (hasVideoFlowTimedOut(flowDeadline)) {
          if (
            lastVideoLedgerEntryId &&
            lastVideoLedgerEntryRecordedAt &&
            !lastVideoLedgerEntrySucceeded
          ) {
            await safelyUpdateCostLedgerEntry(
              lastVideoLedgerEntryId,
              { status: "provider_attempt_failed" },
              lastVideoLedgerEntryRecordedAt
            );
          }
          safeLog("messenger_video_generation_flow_timeout", {
            level: "warn",
            reqId,
            timeoutMs: flowDeadline.timeoutMs,
          });
          sendOutcome = await sendVideoText(
            deps,
            psid,
            t(lang, "videoGenerationTimeout"),
            reqId,
            "flow_timeout"
          );
          return;
        }

        await assertVideoFence();
        sendOutcome = await sendVideoAttachment(
          deps,
          psid,
          storedVideo.url,
          reqId
        );
        deliveryCompleted = sendOutcome.sent;
        if (deliveryCompleted) {
          await assertVideoFence();
          await Promise.resolve(
            setLastGeneratedVideo(
              psid,
              storedVideo.url,
              providerResult.provider,
              providerResult.providerJobId
            )
          );
        }
        safeLog("messenger_video_generation_completed", {
          reqId,
          provider: providerResult.provider,
          providerJobId: providerResult.providerJobId,
          storageKey: storedVideo.key,
          sent: sendOutcome.sent,
        });
      } catch (error) {
        await Promise.all(
          providerFences.map(fence =>
            finalizeMessengerProviderAttemptFence(fence, "ambiguous")
          )
        );
        providerFences.length = 0;
        if (
          lastVideoLedgerEntryId &&
          lastVideoLedgerEntryRecordedAt &&
          !lastVideoLedgerEntrySucceeded
        ) {
          await safelyUpdateCostLedgerEntry(
            lastVideoLedgerEntryId,
            { status: "provider_attempt_failed" },
            lastVideoLedgerEntryRecordedAt
          );
        }
        safeLog("messenger_video_generation_failed", {
          level: "error",
          reqId,
          errorCode: error instanceof Error ? error.name : "UnknownError",
        });
        if (error instanceof MessengerPrivacyFenceError) {
          sendOutcome = { sent: false, reason: "response_window_closed" };
          return;
        }
        sendOutcome = await sendVideoText(
          deps,
          psid,
          error instanceof MessengerDailyVideoBudgetExceededError ||
            error instanceof MessengerSpendBudgetExceededError ||
            error instanceof MessengerQuotaReservationCommitError
            ? t(lang, "outOfVideoCredits")
            : t(lang, "videoGenerationGenericFailure"),
          reqId,
          "budget_or_internal_failed"
        );
      } finally {
        if (!deliveryCompleted && generatedStorageKey) {
          await storageDelete(generatedStorageKey).catch(() => undefined);
        }
        if (!deliveryCompleted && generatedProviderArtifact) {
          await deleteProviderVideoForUser({
            ...generatedProviderArtifact,
            reqId,
          }).catch(() => undefined);
        }
        if (pendingQuotaReservation) {
          await releaseReservation(psid, pendingQuotaReservation);
        }
      }
    });

    if (didRun === null) {
      const inFlight = await deps.maybeSendInFlightMessage(psid, reqId, lang);
      if (inFlight.handled && inFlight.outcome) {
        return inFlight.outcome;
      }
    }

    return sendOutcome;
  };
}
