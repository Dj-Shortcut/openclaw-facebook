import { storagePut } from "../storage";
import { safeLog } from "./messengerApi";
import { anonymizePsid, setLastGeneratedVideo } from "./messengerState";
import { t, type Lang } from "./i18n";
import { toLogUser } from "./privacy";
import {
  commitVideoGenerationSuccess,
  releaseVideoGenerationReservation,
  reserveVideoGenerationForAttempt,
  type VideoGenerationQuotaReservation,
} from "./messengerQuota";
import {
  assertMessengerDailyVideoBudgetAvailable,
  MessengerDailyVideoBudgetExceededError,
  runGuardedGeneration,
  runGuardedVideoGeneration,
} from "./generationGuard";
import { getMessengerVideoTimeoutMs } from "./video-generation/videoConfig";
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
      let reservation: VideoGenerationQuotaReservation | null = null;
      let quotaCommitted = false;
      try {
        reservation = await reserveVideoGenerationForAttempt(psid);
        if (!reservation) {
          sendOutcome = await deps.sendLoggedText(
            psid,
            t(lang, "outOfVideoCredits"),
            reqId
          );
          return;
        }

        await deps.sendLoggedText(psid, t(lang, "generatingVideoPrompt"), reqId);
        await assertMessengerDailyVideoBudgetAvailable({ reqId });
        safeLog("messenger_video_generation_started", {
          reqId,
          user: toLogUser(userId),
          psidHash: anonymizePsid(psid).slice(0, 12),
        });

        const providerResult = await getVideoProvider().generateVideo({
          prompt: promptHint,
          sourceImageUrl,
          reqId,
          userKey: userId,
          timeoutMs: getMessengerVideoTimeoutMs(),
        });

        if (providerResult.kind === "failure") {
          safeLog("messenger_video_generation_provider_failed", {
            level: "warn",
            reqId,
            provider: providerResult.provider,
            errorClass: providerResult.errorClass,
            retryable: providerResult.retryable,
          });
          sendOutcome = await deps.sendLoggedText(
            psid,
            providerResult.errorClass === "timeout"
              ? t(lang, "videoGenerationTimeout")
              : t(lang, "videoGenerationGenericFailure"),
            reqId
          );
          return;
        }

        const storedVideo = await storeGeneratedVideo({
          reqId,
          videoBytes: providerResult.videoBytes,
          contentType: providerResult.contentType,
        });

        quotaCommitted = await commitVideoGenerationSuccess(psid, reservation);
        if (!quotaCommitted) {
          sendOutcome = await deps.sendLoggedText(
            psid,
            t(lang, "outOfVideoCredits"),
            reqId
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
        sendOutcome = await deps.sendLoggedVideo(psid, storedVideo.url, reqId);
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
        sendOutcome = await deps.sendLoggedText(
          psid,
          error instanceof MessengerDailyVideoBudgetExceededError
            ? t(lang, "outOfVideoCredits")
            : t(lang, "videoGenerationGenericFailure"),
          reqId
        );
      } finally {
        if (!quotaCommitted) {
          await releaseReservation(psid, reservation);
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
