import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { safeLog } from "./messengerApi";
import { fetchExternalSourceImageForIngress } from "./image-generation/sourceImageFetcher";
import { anonymizePsid } from "./messengerState";
import { handleTextMessage } from "./webhookTextMessageRouter";
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

  const transcript = await transcribeAudioMessage(input.reqId, input.psid, audioUrl);
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
}

function getInboundAudioUrl(
  attachments: AudioMessageInput["attachments"]
): string | null {
  const audio = attachments.find((att: FacebookWebhookAttachment) =>
    att?.type === "audio" && att.payload?.url
  );
  return typeof audio?.payload?.url === "string" ? audio.payload.url : null;
}

async function transcribeAudioMessage(
  reqId: string,
  psid: string,
  audioUrl: string
): Promise<string | null> {
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

  const body = new FormData();
  const audioFile = new Blob([new Uint8Array(sourceAudio.buffer)], {
    type: sourceAudio.contentType || "audio/mpeg",
  });
  body.append("file", audioFile, "voice-message");
  body.append("model", OPENAI_AUDIO_TRANSCRIPTION_MODEL);
  body.append("response_format", "json");

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
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (attempt < OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES && isRetryableStatus(response.status)) {
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
        return null;
      }

      safeLog("messenger_audio_transcription_complete", {
        ...attemptPayload,
        route: "audio",
        textLength: transcript.length,
        hasText: true,
      });
      return transcript;
    } catch (error) {
      if (attempt < OPENAI_AUDIO_TRANSCRIPTION_MAX_RETRIES && isTransientError(error)) {
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
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

function waitForRetryDelay(attempt: number): Promise<void> {
  const delayMs = 150 * 2 ** attempt;
  return new Promise(resolve => setTimeout(resolve, delayMs));
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
