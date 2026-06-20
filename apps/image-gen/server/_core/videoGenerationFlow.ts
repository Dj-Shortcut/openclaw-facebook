import { storagePut } from "../storage";
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
  assertMessengerDailyVideoBudgetAvailable,
  MessengerDailyVideoBudgetExceededError,
  releaseMessengerDailyVideoBudgetReservation,
  runGuardedVideoGeneration,
} from "./generationGuard";
import {
  getMessengerVideoFlowTimeoutMs,
  getMessengerVideoTimeoutMs,
} from "./video-generation/videoConfig";
import { getVideoProvider } from "./video-generation/videoProviderRegistry";
import type { MessengerSendOutcome } from "./messengerApi";

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

type RunVideoGenerationInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  sourceImageUrl: string;
  promptHint: string;
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
    let sendOutcome: MessengerSendOutcome = { sent: false, reason: "response_window_closed" };
    const existingInFlight = await deps.maybeSendInFlightMessage(psid, reqId, lang);
    if (existingInFlight.handled) {
      return existingInFlight.outcome ?? sendOutcome;
    }

    const didRun = await runGuardedVideoGeneration(psid, async () => {
      let pendingQuotaReservation: VideoGenerationQuotaReservation | null = null;
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
        const commitProviderAttemptQuota = async () => {
          const budgetNow = new Date();
          await assertMessengerDailyVideoBudgetAvailable({ reqId, now: budgetNow });
          try {
            const reservationForAttempt =
              pendingQuotaReservation ?? (await reserveVideoGenerationForAttempt(psid));
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
            if (pendingQuotaReservation?.token === reservationForAttempt.token) {
              pendingQuotaReservation = null;
            }

            safeLog("messenger_video_quota_decision", {
              action: "commit_provider_attempt",
              reqId,
              user: toLogUser(userId),
              allowed: true,
            });
          } catch (error) {
            await releaseMessengerDailyVideoBudgetReservation({ now: budgetNow });
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

        if (hasVideoFlowTimedOut(flowDeadline)) {
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

        if (providerResult.kind === "failure") {
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

        if (hasVideoFlowTimedOut(flowDeadline)) {
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

        if (hasVideoFlowTimedOut(flowDeadline)) {
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

        await Promise.resolve(
          setLastGeneratedVideo(
            psid,
            storedVideo.url,
            providerResult.provider,
            providerResult.providerJobId
          )
        );
        sendOutcome = await sendVideoAttachment(deps, psid, storedVideo.url, reqId);
        safeLog("messenger_video_generation_completed", {
          reqId,
          provider: providerResult.provider,
          providerJobId: providerResult.providerJobId,
          storageKey: storedVideo.key,
          sent: sendOutcome.sent,
        });
      } catch (error) {
        safeLog("messenger_video_generation_failed", {
          level: "error",
          reqId,
          errorCode: error instanceof Error ? error.name : "UnknownError",
        });
        sendOutcome = await sendVideoText(
          deps,
          psid,
          error instanceof MessengerDailyVideoBudgetExceededError ||
            error instanceof MessengerQuotaReservationCommitError
            ? t(lang, "outOfVideoCredits")
            : t(lang, "videoGenerationGenericFailure"),
          reqId,
          "budget_or_internal_failed"
        );
      } finally {
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
