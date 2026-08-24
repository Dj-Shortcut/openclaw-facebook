import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { safeLog } from "./messengerApi";
import {
  appendCostLedgerEntry,
  safelyUpdateCostLedgerEntry,
  type CostLedgerTenantScope,
} from "./costLedger";
import { fetchExternalSourceImageForIngress } from "./image-generation/sourceImageFetcher";
import { anonymizePsid } from "./messengerState";
import { toUserKey } from "./privacy";
import { handleTextMessage } from "./webhookTextMessageRouter";
import {
  assertMessengerDailyAudioTranscriptionBudgetAvailable,
  admitMessengerProviderSpend,
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
import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";
import { assertMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";
import { assertMessengerPrivacySubject } from "./messengerPrivacySubject";

type AudioMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Parameters<typeof handleTextMessage>[1]["lang"];
  attachments: FacebookWebhookAttachment[];
  text?: string;
  timestamp?: number;
};

export type AudioProviderJob = MessengerGenerationJob & {
  providerChannel: "facebook_messenger" | "whatsapp";
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
      await ctx.sendLoggedText(
        input.psid,
        t(input.lang, "outOfFreeCredits"),
        input.reqId
      );
      return true;
    }

    throw error;
  }
  let reservation: Awaited<
    ReturnType<typeof reserveTranscriptionForAttempt>
  > | null = null;
  let audioBudgetCommitted = false;

  try {
    const providerJob = getAudioProviderJob(input);
    await assertAudioProviderFence(providerJob);
    let downloadFence: MessengerProviderAttemptFence | null = null;
    let prepared: PreparedAudioForTranscription | null = null;
    try {
      downloadFence = await reserveMessengerProviderAttemptFence(
        providerJob,
        "meta-audio-download",
        1,
        new Date(),
        providerJob.providerChannel
      );
      await markMessengerProviderAttemptStarted(downloadFence);
      prepared = await prepareAudioForTranscription(
        input.reqId,
        input.psid,
        audioUrl
      );
      await finalizeMessengerProviderAttemptFence(
        downloadFence,
        prepared ? "succeeded" : "known_failed"
      );
    } catch (error) {
      if (downloadFence) {
        await finalizeMessengerProviderAttemptFence(downloadFence, "ambiguous");
      }
      throw error;
    }
    if (!prepared) {
      return false;
    }
    // Deletion/rebind may win while Meta media is downloading. Recheck before
    // disclosing the bytes to OpenAI or reserving billable quota.
    await assertAudioProviderFence(providerJob);

    reservation = await reserveTranscriptionForAttempt(input.psid);
    if (!reservation) {
      await ctx.sendLoggedText(
        input.psid,
        t(input.lang, "outOfFreeCredits"),
        input.reqId
      );
      return true;
    }

    const commitProviderAttemptQuota = async () => {
      if (audioBudgetCommitted) {
        return;
      }
      if (!reservation) {
        throw new MessengerQuotaReservationCommitError(
          "Missing transcription reservation"
        );
      }
      const committed = await commitTranscriptionSuccess(
        input.psid,
        reservation,
        {
          releaseReservation: false,
        }
      );
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
      commitProviderAttemptQuota,
      "facebook_messenger",
      providerJob
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
      await ctx.sendLoggedText(
        input.psid,
        t(input.lang, "outOfFreeCredits"),
        input.reqId
      );
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

function getAudioProviderJob(input: AudioMessageInput): AudioProviderJob {
  const ownership = getMessengerRequestOwnership();
  const privacy = getMessengerRequestPrivacySubject();
  return {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    pageId: getMessengerRequestPageId(),
    workspaceId: ownership?.workspaceId,
    channelConnectionId: ownership?.channelConnectionId,
    bindingEpoch: ownership?.bindingEpoch,
    privacyEpoch: privacy?.privacyEpoch,
    providerChannel: "facebook_messenger",
  };
}

export async function assertAudioProviderFence(
  job: AudioProviderJob
): Promise<void> {
  if (
    !job.workspaceId ||
    !job.channelConnectionId ||
    !job.bindingEpoch ||
    !job.privacyEpoch
  ) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger audio privacy ownership is incomplete");
    }
    return;
  }
  await assertMessengerGenerationOwnership({
    ...job,
    channel: job.providerChannel,
  });
  await assertMessengerPrivacySubject({
    workspaceId: job.workspaceId,
    channelConnectionId: job.channelConnectionId,
    userKey: job.userId,
    privacyEpoch: job.privacyEpoch,
  });
}

function getAudioCostLedgerScope(
  channel: string,
  userId: string,
  recipientId: string,
  job?: AudioProviderJob
): CostLedgerTenantScope | undefined {
  if (channel !== "facebook_messenger" && channel !== "whatsapp") {
    return undefined;
  }
  if (
    job?.workspaceId &&
    job.channelConnectionId &&
    job.bindingEpoch &&
    job.privacyEpoch &&
    job.userId === userId &&
    job.providerChannel === channel &&
    (channel !== "whatsapp" || toUserKey(recipientId) === userId)
  ) {
    return {
      workspaceId: job.workspaceId,
      channelConnectionId: job.channelConnectionId,
      bindingEpoch: job.bindingEpoch,
      privacyEpoch: job.privacyEpoch,
      userKey: userId,
    };
  }
  // WhatsApp never has a contextless transport path: accepting an incomplete
  // job here would detach the billable provider attempt from its tenant. Keep
  // the existing non-production Messenger compatibility for focused tests and
  // local tooling, while production remains fail closed for both channels.
  if (job?.providerChannel === "whatsapp") {
    throw new Error(
      "Audio transcription requires tenant-scoped cost admission"
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Meta audio cost ledger tenant scope is required");
  }
  return undefined;
}

function getInboundAudioUrl(
  attachments: AudioMessageInput["attachments"]
): string | null {
  const audio = attachments.find(
    (att: FacebookWebhookAttachment) =>
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

  return createPreparedAudioForTranscription(reqId, psid, audioUrl, apiKey, {
    buffer: audioBuffer,
    contentType,
    incomingLen: audioBuffer.length,
  });
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
  channel = "facebook_messenger",
  providerJob?: AudioProviderJob
): Promise<string | null> {
  const { apiKey, sourceAudio } = prepared;
  const costLedgerScope = getAudioCostLedgerScope(
    channel,
    userId,
    psid,
    providerJob
  );
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

  for (
    let attempt = 0;
    attempt <= OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES;
    attempt += 1
  ) {
    let providerFence: MessengerProviderAttemptFence | null = null;
    let ledgerEntryRecorded = false;
    let providerResponseAccepted = false;
    let providerSuccessRecorded = false;
    const attemptNow = new Date();
    const ledgerEntryId = `${reqId}:openai-audio:${attempt + 1}`;
    try {
      if (providerJob) {
        await assertAudioProviderFence(providerJob);
        providerFence = await reserveMessengerProviderAttemptFence(
          providerJob,
          "openai-audio-transcription",
          providerJob.providerChannel === "whatsapp" ? 1 : attempt + 1,
          attemptNow,
          providerJob.providerChannel
        );
      }
      await admitMessengerProviderSpend({
        reqId,
        attemptId: ledgerEntryId,
        tenantScope: costLedgerScope,
        userKey: userId,
        estimatedCostUsd: costEstimate.estimatedCostUsd,
        estimatedOutputCostUsd: null,
        costEstimateComplete: costEstimate.costEstimateComplete,
        now: attemptNow,
        recordAttempt: async () => {
          await appendCostLedgerEntry(
            {
              id: ledgerEntryId,
              channel,
              operation: "audio_transcription",
              provider: "openai-audio",
              model: OPENAI_AUDIO_TRANSCRIPTION_MODEL,
              ...(costLedgerScope ?? {}),
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
          ledgerEntryRecorded = true;
          if (providerFence) {
            await markMessengerProviderAttemptStarted(providerFence);
          }
          // Customer quota is consumed only after the final durable
          // tenant/privacy CAS wins and immediately before fetch.
          await onProviderAttempt();
        },
      });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (ledgerEntryRecorded) {
        try {
          await safelyUpdateCostLedgerEntry(
            ledgerEntryId,
            { status: "provider_attempt_failed" },
            attemptNow,
            costLedgerScope
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (providerFence) {
        try {
          await finalizeMessengerProviderAttemptFence(
            providerFence,
            "known_failed"
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Audio provider admission cleanup failed",
          { cause: error }
        );
      }
      throw error;
    }
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
        const durableAttempt = Boolean(providerFence?.attemptKeyHash);
        if (
          !durableAttempt &&
          attempt < OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES &&
          isRetryableStatus(response.status)
        ) {
          await safelyUpdateCostLedgerEntry(
            ledgerEntryId,
            { status: "provider_attempt_failed" },
            attemptNow,
            costLedgerScope
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
          attemptNow,
          costLedgerScope
        );
        if (providerFence) {
          await finalizeMessengerProviderAttemptFence(
            providerFence,
            isAmbiguousProviderResponseStatus(response.status)
              ? "ambiguous"
              : "known_failed"
          );
          providerFence = null;
        }
        return null;
      }

      // A 2xx is a known billable provider outcome. Persist it before parsing
      // or any privacy/delivery recheck so later local failures can suppress
      // the transcript without rewriting provider spend as failed/ambiguous.
      providerResponseAccepted = true;
      await safelyUpdateCostLedgerEntry(
        ledgerEntryId,
        {
          status: "provider_attempt_succeeded",
          finalCostUsd: costEstimate.finalCostUsd,
        },
        attemptNow,
        costLedgerScope
      );
      if (providerFence) {
        await finalizeMessengerProviderAttemptFence(providerFence, "succeeded");
        providerFence = null;
      }
      providerSuccessRecorded = true;

      const result: unknown = await response.json();
      const transcript =
        result &&
        typeof result === "object" &&
        "text" in result &&
        typeof (result as { text?: unknown }).text === "string"
          ? (result as { text: string }).text.trim()
          : "";
      if (!transcript) {
        safeLog("messenger_audio_transcription_no_text", {
          ...attemptPayload,
          route: "audio",
          reason: "empty_transcript",
          attempt,
        });
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
        return null;
      }
      safeLog("messenger_audio_transcription_complete", {
        ...attemptPayload,
        route: "audio",
        textLength: transcript.length,
        hasText: true,
      });
      if (providerJob) await assertAudioProviderFence(providerJob);
      return transcript;
    } catch (error) {
      if (providerResponseAccepted) {
        const persistenceErrors: unknown[] = [];
        if (!providerSuccessRecorded) {
          try {
            await safelyUpdateCostLedgerEntry(
              ledgerEntryId,
              {
                status: "provider_attempt_succeeded",
                finalCostUsd: costEstimate.finalCostUsd,
              },
              attemptNow,
              costLedgerScope
            );
          } catch (persistenceError) {
            persistenceErrors.push(persistenceError);
          }
          if (providerFence) {
            try {
              await finalizeMessengerProviderAttemptFence(
                providerFence,
                "succeeded"
              );
              providerFence = null;
            } catch (persistenceError) {
              persistenceErrors.push(persistenceError);
            }
          }
        }
        safeLog("messenger_audio_transcription_post_provider_failed", {
          ...attemptPayload,
          route: "audio",
          attempt,
          reason: error instanceof Error ? error.name : "unknown_error",
        });
        if (persistenceErrors.length > 0) {
          throw new AggregateError(
            [error, ...persistenceErrors],
            "Audio provider success persistence failed",
            { cause: error }
          );
        }
        return null;
      }
      const durableAttempt = Boolean(providerFence?.attemptKeyHash);
      if (
        !durableAttempt &&
        attempt < OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES &&
        isTransientError(error)
      ) {
        await safelyUpdateCostLedgerEntry(
          ledgerEntryId,
          { status: "provider_attempt_failed" },
          attemptNow,
          costLedgerScope
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
        attemptNow,
        costLedgerScope
      );
      if (providerFence) {
        await finalizeMessengerProviderAttemptFence(providerFence, "ambiguous");
        providerFence = null;
      }
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

function isAmbiguousProviderResponseStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
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

function mapAudioMimeTypeToExtension(
  contentType: string | undefined
): string | null {
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
    if (
      [".mp3", ".m4a", ".ogg", ".wav", ".webm", ".flac", ".opus"].includes(ext)
    ) {
      return ext;
    }

    return null;
  } catch {
    return null;
  }
}
