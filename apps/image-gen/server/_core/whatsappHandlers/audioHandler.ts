import { createHash } from "node:crypto";
import { t } from "../i18n";
import { safeLog } from "../logger";
import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";
import { toLogUser } from "../privacy";
import {
  assertMessengerDailyAudioTranscriptionBudgetAvailable,
  MessengerDailyAudioTranscriptionBudgetExceededError,
  MessengerSpendBudgetExceededError,
  releaseMessengerDailyAudioTranscriptionBudgetReservation,
} from "../generationGuard";
import {
  commitTranscriptionSuccess,
  releaseTranscriptionReservation,
  reserveTranscriptionForAttempt,
  MessengerQuotaReservationCommitError,
} from "../messengerQuota";
import {
  prepareAudioForTranscriptionFromBuffer,
  transcribePreparedAudioMessage,
} from "../webhookAudioMessageRouter";
import { downloadWhatsAppMedia } from "../whatsappApi";
import { sendWhatsAppTextReply } from "../whatsappResponseService";
import { handleWhatsAppTextEvent } from "./textHandler";

export async function handleWhatsAppAudioEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  if (!event.audioId) {
    safeLog("whatsapp_audio_event_missing_audio_id", {
      user: toLogUser(event.userId),
      reqId: context.reqId,
    });
    await sendWhatsAppTextReply(event.senderId, t(context.lang, "unsupportedAudio"));
    return;
  }

  const audioBudgetNow = new Date();
  try {
    await assertMessengerDailyAudioTranscriptionBudgetAvailable({
      reqId: context.reqId,
      now: audioBudgetNow,
    });
  } catch (error) {
    if (error instanceof MessengerDailyAudioTranscriptionBudgetExceededError) {
      await sendWhatsAppTextReply(event.senderId, t(context.lang, "outOfFreeCredits"));
      return;
    }
    throw error;
  }

  if (!process.env.OPENAI_API_KEY?.trim()) {
    await sendWhatsAppTextReply(event.senderId, t(context.lang, "unsupportedAudio"));
    return;
  }

  let sourceAudioBuffer: Buffer;
  let sourceAudioContentType: string | undefined;
  try {
    const downloaded = await downloadWhatsAppMedia(event.audioId);
    sourceAudioBuffer = downloaded.buffer;
    sourceAudioContentType = downloaded.contentType;
  } catch (error) {
    safeLog("whatsapp_audio_media_download_failed", {
      user: toLogUser(event.userId),
      reqId: context.reqId,
      error: error instanceof Error ? error.name : "unknown_error",
      audioIdHash: createHash("sha256")
        .update(event.audioId)
        .digest("hex")
        .slice(0, 12),
    });
    await sendWhatsAppTextReply(event.senderId, t(context.lang, "unsupportedAudio"));
    return;
  }

  const preparedAudio = prepareAudioForTranscriptionFromBuffer(
    context.reqId,
    event.senderId,
    event.audioId,
    sourceAudioBuffer,
    sourceAudioContentType
  );
  if (!preparedAudio) {
    await releaseMessengerDailyAudioTranscriptionBudgetReservation({
      now: audioBudgetNow,
    });
    await sendWhatsAppTextReply(event.senderId, t(context.lang, "unsupportedAudio"));
    return;
  }

  const reservation = await reserveTranscriptionForAttempt(event.senderId);
  if (!reservation) {
    await releaseMessengerDailyAudioTranscriptionBudgetReservation({
      now: audioBudgetNow,
    });
    await sendWhatsAppTextReply(event.senderId, t(context.lang, "outOfFreeCredits"));
    return;
  }

  let audioBudgetCommitted = false;
  const commitProviderAttemptQuota = async () => {
    const committed = await commitTranscriptionSuccess(event.senderId, reservation, {
      releaseReservation: false,
    });
    if (!committed) {
      throw new MessengerQuotaReservationCommitError(
        "Messenger audio transcription quota reservation could not be committed"
      );
    }
    audioBudgetCommitted = true;
  };

  try {
    const transcript = await transcribePreparedAudioMessage(
      context.reqId,
      event.senderId,
      event.userId,
      event.audioId,
      preparedAudio,
      commitProviderAttemptQuota,
      "whatsapp"
    );
    if (!transcript) {
      await sendWhatsAppTextReply(event.senderId, t(context.lang, "unsupportedAudio"));
      return;
    }

    await handleWhatsAppTextEvent(
      {
        ...event,
        messageType: "text",
        textBody: transcript,
      },
      context
    );
  } catch (error) {
    if (
      error instanceof MessengerQuotaReservationCommitError ||
      error instanceof MessengerSpendBudgetExceededError
    ) {
      await sendWhatsAppTextReply(event.senderId, t(context.lang, "outOfFreeCredits"));
      return;
    }

    throw error;
  } finally {
    await releaseTranscriptionReservation(event.senderId, reservation);
    if (!audioBudgetCommitted) {
      await releaseMessengerDailyAudioTranscriptionBudgetReservation({
        now: audioBudgetNow,
      });
    }
  }
}
