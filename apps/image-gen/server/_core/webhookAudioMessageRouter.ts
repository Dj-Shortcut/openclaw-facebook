import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { safeLog } from "./messengerApi";
import {
  safelyAppendCostLedgerEntry,
  safelyUpdateCostLedgerEntry,
} from "./costLedger";
import { fetchExternalSourceImageForIngress } from "./image-generation/sourceImageFetcher";
import { anonymizePsid } from "./messengerState";
import { handleTextMessage } from "./webhookTextMessageRouter";
import {
  assertMessengerDailyAudioTranscriptionBudgetAvailable,
  assertMessengerDailySpendBudgetAvailable,
  assertMessengerMonthlySpendBudgetAvailable,
  assertMessengerUserDailySpendBudgetAvailable,
  MessengerDailyAudioTranscriptionBudgetExceededError,
  MessengerSpendBudgetExceededError,
  releaseMessengerDailyAudioTranscriptionBudgetReservation,
} from "./generationGuard";
import {
  commitTranscriptionSuccess,
  MessengerQuotaReservationCommitError,
  releaseTranscriptionReservation,
  reserveTranscriptionForAttempt,
} from "./messengerQuota";
import { t } from "./i18n";
import type { HandlerContext } from "./webhookHandlerTypes";
import type { FacebookWebhookAttachment } from "./webhookHelpers";

type AudioMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Parameters<typeof handleTextMessage>[1]["lang"];
  attachments: FacebookWebhookAttachment[];
  text?: string;
  timestamp?: number;
};

const OPENAI_AUDIO_TRANSCRIPTION_ENDPOINT =
  "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_AUDIO_TRANSCRIPTION_MODEL = "whisper-1";
const OPENAI_AUDIO_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES = 1;
const DEFAULT_AUDIO_TRANSCRIPTION_MAX_BYTES = 20 * 1024 * 1024;
const MIN_TRANSCRIPT_WORDS = 2;

export type PreparedAudioForTranscription = {
  apiKey: string;
  sourceAudio: {
    buffer: Buffer;
    contentType?: string;
    incomingLen: number;
  };
};

/** Attempts to transcribe voice/audio attachments and route as text input. */
export async function tryHandleAudioMessage(
  ctx: HandlerContext,
  input: AudioMessageInput
): Promise<boolean> {
  if (input.text?.trim()) {
    return false;
  }

  const audioUrl = getInboundAudioUrl(input.attachments);
  if (!audioUrl) {
    return false;
  }

  const audioBudgetNow = new Date();
  try {
    await assertMessengerDailyAudioTranscriptionBudgetAvailable({
      reqId: input.reqId,
      now: audioBudgetNow,
    });
  } catch (error) {
    if (error instanceof MessengerDailyAudioTranscriptionBudgetExceededError) {
      await ctx.sendLoggedText(input.psid, t(input.lang, "outOfFreeCredits"), input.reqId);
      return true;
    }

    throw error;
  }
  let reservation: Awaited<ReturnType<typeof reserveTranscriptionForAttempt>> | null = null;
  let audioBudgetCommitted = false;

  try {
    const prepared = await prepareAudioForTranscription(
      input.reqId,
      input.psid,
      audioUrl
    );
    if (!prepared) {
      return false;
    }

    reservation = await reserveTranscriptionForAttempt(input.psid);
    if (!reservation) {
      await ctx.sendLoggedText(input.psid, t(input.lang, "outOfFreeCredits"), input.reqId);
      return true;
    }

    const commitProviderAttemptQuota = async () => {
      if (audioBudgetCommitted) {
        return;
      }
      if (!reservation) {
        throw new MessengerQuotaReservationCommitError("Missing transcription reservation");
      }
      const committed = await commitTranscriptionSuccess(input.psid, reservation, {
        releaseReservation: false,
      });
      if (!committed) {
        throw new MessengerQuotaReservationCommitError(
          "Messenger audio transcription quota reservation could not be committed"
        );
      }
      audioBudgetCommitted = true;
    };

    const transcript = await transcribePreparedAudioMessage(
      input.reqId,
      input.psid,
      input.userId,
      audioUrl,
      prepared,
      commitProviderAttemptQuota
    );
    if (!transcript) {
      return false;
    }

    await handleTextMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      text: transcript,
      timestamp: input.timestamp,
    });
    return true;
  } catch (error) {
    if (
      error instanceof MessengerQuotaReservationCommitError ||
      error instanceof MessengerSpendBudgetExceededError
    ) {
      await ctx.sendLoggedText(input.psid, t(input.lang, "outOfFreeCredits"), input.reqId);
      return true;
    }

    throw error;
  } finally {
    if (reservation) {
      await releaseTranscriptionReservation(input.psid, reservation);
    }
    if (!audioBudgetCommitted) {
      await releaseMessengerDailyAudioTranscriptionBudgetReservation({
        now: audioBudgetNow,
      });
    }
  }
}

function getInboundAudioUrl(
  attachments: AudioMessageInput["attachments"]
): string | null {
  const audio = attachments.find((att: FacebookWebhookAttachment) =>
    att?.type === "audio" && att.payload?.url
  );
  return typeof audio?.payload?.url === "string" ? audio.payload.url : null;
}

type AudioSourceForTranscription = {
  buffer: Buffer;
  contentType?: string;
  incomingLen: number;
};

function createPreparedAudioForTranscription(
  reqId: string,
  psid: string,
  audioUrl: string,
  apiKey: string,
  sourceAudio: AudioSourceForTranscription
): PreparedAudioForTranscription | null {
  const attemptPayload = {
    reqId,
    psidHash: anonymizePsid(psid).slice(0, 12),
    attachment: summarizeSensitiveUrl(audioUrl),
    endpoint: OPENAI_AUDIO_TRANSCRIPTION_ENDPOINT,
    model: OPENAI_AUDIO_TRANSCRIPTION_MODEL,
    contentType: sourceAudio.contentType,
    sourceBytes: sourceAudio.incomingLen,
  };

  const maxBytes = getAudioTranscriptionMaxBytes();
  if (sourceAudio.incomingLen > maxBytes) {
    safeLog("messenger_audio_transcription_skipped", {
      ...attemptPayload,
      route: "audio",
      reason: "audio_too_large",
      maxBytes,
    });
    return null;
  }

  return { apiKey, sourceAudio };
}

export function prepareAudioForTranscriptionFromBuffer(
  reqId: string,
  psid: string,
  audioUrl: string,
  audioBuffer: Buffer,
  contentType?: string
): PreparedAudioForTranscription | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    safeLog("messenger_audio_transcription_skipped", {
      reqId,
      route: "audio",
      reason: "missing_openai_api_key",
      psidHash: anonymizePsid(psid).slice(0, 12),
      attachment: summarizeSensitiveUrl(audioUrl),
    });
    return null;
  }

  return createPreparedAudioForTranscription(
    reqId,
    psid,
    audioUrl,
    apiKey,
    {
      buffer: audioBuffer,
      contentType,
      incomingLen: audioBuffer.length,
    }
  );
}

async function prepareAudioForTranscription(
  reqId: string,
  psid: string,
  audioUrl: string
): Promise<PreparedAudioForTranscription | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    safeLog("messenger_audio_transcription_skipped", {
      reqId,
      route: "audio",
      reason: "missing_openai_api_key",
      psidHash: anonymizePsid(psid).slice(0, 12),
      attachment: summarizeSensitiveUrl(audioUrl),
    });
    return null;
  }

  let sourceAudio;
  try {
    sourceAudio = await fetchExternalSourceImageForIngress({
      sourceImageUrl: audioUrl,
      reqId,
      skipDebugImageProof: true,
    });
  } catch (error) {
    safeLog("messenger_audio_transcription_skipped", {
      reqId,
      route: "audio",
      reason: "audio_download_failed",
      psidHash: anonymizePsid(psid).slice(0, 12),
      attachment: summarizeSensitiveUrl(audioUrl),
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }

  return createPreparedAudioForTranscription(
    reqId,
    psid,
    audioUrl,
    apiKey,
    sourceAudio
  );
}

export async function transcribePreparedAudioMessage(
  reqId: string,
  psid: string,
  userId: string,
  audioUrl: string,
  prepared: PreparedAudioForTranscription,
  onProviderAttempt: () => Promise<void>,
  channel = "facebook_messenger"
): Promise<string | null> {
  const { apiKey, sourceAudio } = prepared;
  const costEstimate = estimateAudioTranscriptionAttemptCost();
  const attemptPayload = {
    reqId,
    psidHash: anonymizePsid(psid).slice(0, 12),
    attachment: summarizeSensitiveUrl(audioUrl),
    endpoint: OPENAI_AUDIO_TRANSCRIPTION_ENDPOINT,
    model: OPENAI_AUDIO_TRANSCRIPTION_MODEL,
    contentType: sourceAudio.contentType,
    sourceBytes: sourceAudio.incomingLen,
  };

  for (let attempt = 0; attempt <= OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES; attempt += 1) {
    const attemptNow = new Date();
    await assertMessengerDailySpendBudgetAvailable({
      reqId,
      estimatedCostUsd: costEstimate.estimatedCostUsd,
      estimatedOutputCostUsd: null,
      now: attemptNow,
    });
    await assertMessengerMonthlySpendBudgetAvailable({
      reqId,
      estimatedCostUsd: costEstimate.estimatedCostUsd,
      estimatedOutputCostUsd: null,
      now: attemptNow,
    });
    await assertMessengerUserDailySpendBudgetAvailable({
      reqId,
      userKey: userId,
      estimatedCostUsd: costEstimate.estimatedCostUsd,
      estimatedOutputCostUsd: null,
      now: attemptNow,
    });
    await onProviderAttempt();
    const ledgerEntryId = `${reqId}:openai-audio:${attempt + 1}`;
    await safelyAppendCostLedgerEntry(
      {
        id: ledgerEntryId,
        channel,
        operation: "audio_transcription",
        provider: "openai-audio",
        model: OPENAI_AUDIO_TRANSCRIPTION_MODEL,
        userKey: userId,
        reqId,
        status: "provider_attempt_started",
        estimatedCostUsd: costEstimate.estimatedCostUsd,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: costEstimate.costEstimateComplete,
        estimateSource: costEstimate.estimateSource,
        unpricedCostComponents: costEstimate.unpricedCostComponents,
        providerUsage: {
          pricingModel: costEstimate.estimateSource,
          retryAttempt: attempt + 1,
          contentType: sourceAudio.contentType ?? null,
          sourceBytes: sourceAudio.incomingLen,
        },
      },
      attemptNow
    );
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, OPENAI_AUDIO_TRANSCRIPTION_TIMEOUT_MS);

    try {
      safeLog("messenger_audio_transcription_request", {
        ...attemptPayload,
        route: "audio",
        attempt,
      });

      const response = await fetch(OPENAI_AUDIO_TRANSCRIPTION_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: buildTranscriptionRequestBody(sourceAudio, audioUrl),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt < OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES && isRetryableStatus(response.status)) {
          await safelyUpdateCostLedgerEntry(
            ledgerEntryId,
            { status: "provider_attempt_failed" },
            attemptNow
          );
          safeLog("messenger_audio_transcription_retry", {
            ...attemptPayload,
            route: "audio",
            attempt,
            status: response.status,
          });
          await waitForRetryDelay(attempt);
          continue;
        }
        safeLog("messenger_audio_transcription_failed", {
          ...attemptPayload,
          route: "audio",
          status: response.status,
          attempt,
          reason: "http_error",
        });
        await safelyUpdateCostLedgerEntry(
          ledgerEntryId,
          { status: "provider_attempt_failed" },
          attemptNow
        );
        return null;
      }

      const result = await response.json();
      const transcript =
        typeof result?.text === "string" ? result.text.trim() : "";
      if (!transcript) {
        safeLog("messenger_audio_transcription_no_text", {
          ...attemptPayload,
          route: "audio",
          reason: "empty_transcript",
          attempt,
        });
        await safelyUpdateCostLedgerEntry(
          ledgerEntryId,
          { status: "provider_attempt_failed" },
          attemptNow
        );
        return null;
      }

      const wordCount = countTranscriptWords(transcript);
      if (wordCount < MIN_TRANSCRIPT_WORDS) {
        safeLog("messenger_audio_transcription_no_text", {
          ...attemptPayload,
          route: "audio",
          reason: "transcript_too_short",
          attempt,
          textLength: transcript.length,
          wordCount,
        });
        await safelyUpdateCostLedgerEntry(
          ledgerEntryId,
          { status: "provider_attempt_failed" },
          attemptNow
        );
        return null;
      }

      await safelyUpdateCostLedgerEntry(
        ledgerEntryId,
        {
          status: "provider_attempt_succeeded",
          finalCostUsd: costEstimate.finalCostUsd,
        },
        attemptNow
      );
      safeLog("messenger_audio_transcription_complete", {
        ...attemptPayload,
        route: "audio",
        textLength: transcript.length,
        hasText: true,
      });
      return transcript;
    } catch (error) {
      if (attempt < OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES && isTransientError(error)) {
        await safelyUpdateCostLedgerEntry(
          ledgerEntryId,
          { status: "provider_attempt_failed" },
          attemptNow
        );
        safeLog("messenger_audio_transcription_retry", {
          ...attemptPayload,
          route: "audio",
          attempt,
          reason: error instanceof Error ? error.name : "unknown_error",
        });
        await waitForRetryDelay(attempt);
        continue;
      }
      safeLog("messenger_audio_transcription_failed", {
        ...attemptPayload,
        route: "audio",
        attempt,
        reason: error instanceof Error ? error.name : "unknown_error",
      });
      await safelyUpdateCostLedgerEntry(
        ledgerEntryId,
        { status: "provider_attempt_failed" },
        attemptNow
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

function getAudioTranscriptionMaxBytes(): number {
  const configured = Number.parseInt(
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_MAX_BYTES ?? "",
    10
  );
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_AUDIO_TRANSCRIPTION_MAX_BYTES;
}

function readUsdEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function estimateAudioTranscriptionAttemptCost(): {
  estimatedCostUsd: number | null;
  finalCostUsd: number | null;
  costEstimateComplete: boolean;
  estimateSource: string;
  unpricedCostComponents: string[];
} {
  const override = readUsdEnv("OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD");
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
    unpricedCostComponents: ["audio_seconds"],
  };
}

function countTranscriptWords(transcript: string): number {
  return transcript.split(/\s+/).filter(Boolean).length;
}

function waitForRetryDelay(attempt: number): Promise<void> {
  const delayMs = 150 * 2 ** attempt;
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function buildTranscriptionRequestBody(
  sourceAudio: { buffer: Buffer; contentType?: string },
  audioUrl: string
): FormData {
  const body = new FormData();
  const audioFile = new Blob([new Uint8Array(sourceAudio.buffer)], {
    type: sourceAudio.contentType || "audio/mpeg",
  });
  body.append(
    "file",
    audioFile,
    getAudioFileName(audioUrl, sourceAudio.contentType)
  );
  body.append("model", OPENAI_AUDIO_TRANSCRIPTION_MODEL);
  body.append("response_format", "json");

  return body;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTransientError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TypeError")
  );
}

function getAudioFileName(audioUrl: string, contentType?: string): string {
  const extFromContentType = mapAudioMimeTypeToExtension(contentType);
  if (extFromContentType) {
    return `voice-message${extFromContentType}`;
  }

  const extFromUrl = extractAudioFileExtensionFromUrl(audioUrl);
  if (extFromUrl) {
    return `voice-message${extFromUrl}`;
  }

  return "voice-message.mp3";
}

function mapAudioMimeTypeToExtension(contentType: string | undefined): string | null {
  if (!contentType) {
    return null;
  }

  const normalized = contentType.split(";")[0].trim().toLowerCase();
  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/mp4") return ".m4a";
  if (normalized === "audio/x-m4a") return ".m4a";
  if (normalized === "audio/wav" || normalized === "audio/wave") return ".wav";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/webm") return ".webm";
  if (normalized === "audio/flac") return ".flac";
  return null;
}

function extractAudioFileExtensionFromUrl(audioUrl: string): string | null {
  try {
    const parsed = new URL(audioUrl);
    const basename = parsed.pathname.split("/").pop() ?? "";
    const cleanBasename = basename.replace(/\?.*$/, "").split("#")[0];
    const matched = cleanBasename.match(/\.[a-z0-9]{2,6}$/i);
    if (!matched) {
      return null;
    }

    const ext = matched[0].toLowerCase();
    if ([".mp3", ".m4a", ".ogg", ".wav", ".webm", ".flac", ".opus"].includes(ext)) {
      return ext;
    }

    return null;
  } catch {
    return null;
  }
}
