import { createHash } from "node:crypto";
import { t } from "../i18n";
import { safeLog } from "../logger";
import type {
  NormalizedWhatsAppEvent,
  WhatsAppHandlerContext,
} from "../whatsappTypes";
import { toLogUser } from "../privacy";
import {
  assertMessengerDailyAudioTranscriptionBudgetAvailable,
  MessengerDailyAudioTranscriptionBudgetExceededError,
  MessengerSpendBudgetExceededError,
  releaseMessengerDailyAudioTranscriptionBudgetReservation,
} from "../generationGuard";
import {
  commitTranscriptionSuccess,
  MessengerQuotaReservationCommitError,
  releaseTranscriptionReservation,
  reserveTranscriptionForAttempt,
} from "../transcriptionQuota";
import {
  assertAudioProviderFence,
  type AudioProviderJob,
  prepareAudioForTranscriptionFromBuffer,
  transcribePreparedAudioMessage,
} from "../webhookAudioMessageRouter";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
} from "../messengerProviderAttemptFence";
import { sendWhatsAppTextReply } from "../whatsappResponseService";
import { downloadWhatsAppInboundMedia } from "../../whatsappTransportBoundary";
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
    await sendWhatsAppTextReply(
      event.senderId,
      t(context.lang, "unsupportedAudio"),
      context.reqId,
      "audio-missing"
    );
    return;
  }

  const audioBudgetNow = new Date();
  let sourceAudioBuffer: Buffer | undefined;
  let sourceAudioContentType: string | undefined;
  let reservation: Awaited<
    ReturnType<typeof reserveTranscriptionForAttempt>
  > | null = null;
  let audioBudgetReserved = false;
  let audioBudgetCommitted = false;

  try {
    await assertMessengerDailyAudioTranscriptionBudgetAvailable({
      reqId: context.reqId,
      now: audioBudgetNow,
    });
    audioBudgetReserved = true;
    if (!process.env.OPENAI_API_KEY?.trim()) {
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "unsupportedAudio"),
        context.reqId,
        "audio-provider-unavailable"
      );
      return;
    }

    reservation = await reserveTranscriptionForAttempt(event.senderId);
    if (!reservation) {
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "outOfFreeCredits"),
        context.reqId,
        "audio-quota-exhausted"
      );
      return;
    }

    const providerJob: AudioProviderJob = {
      psid: event.senderId,
      userId: event.userId,
      reqId: context.reqId,
      lang: context.lang,
      pageId: event.endpoint.phoneNumberId,
      workspaceId: context.costLedgerScope.workspaceId,
      channelConnectionId: context.costLedgerScope.channelConnectionId,
      bindingEpoch: context.costLedgerScope.bindingEpoch,
      privacyEpoch: context.costLedgerScope.privacyEpoch,
      providerChannel: "whatsapp",
    };

    let downloadFence: MessengerProviderAttemptFence | null = null;
    let downloadStarted = false;
    try {
      await assertAudioProviderFence(providerJob);
      downloadFence = await reserveMessengerProviderAttemptFence(
        providerJob,
        "meta-audio-download",
        1,
        new Date(),
        "whatsapp"
      );
      await markMessengerProviderAttemptStarted(downloadFence);
      downloadStarted = true;
      const downloaded = await downloadWhatsAppInboundMedia(event.audioId);
      sourceAudioBuffer = downloaded.buffer;
      sourceAudioContentType = downloaded.contentType;
      await finalizeMessengerProviderAttemptFence(downloadFence, "succeeded");
      downloadFence = null;
      // Deletion/rebind may win during the download. Never disclose the bytes
      // to OpenAI after that immutable privacy scope changes.
      await assertAudioProviderFence(providerJob);
    } catch (error) {
      if (downloadFence) {
        try {
          await finalizeMessengerProviderAttemptFence(
            downloadFence,
            downloadStarted ? "ambiguous" : "known_failed"
          );
        } catch (fenceError) {
          throw new AggregateError(
            [error, fenceError],
            "WhatsApp audio download fence finalization failed",
            { cause: error }
          );
        }
      }
      safeLog("whatsapp_audio_media_download_failed", {
        user: toLogUser(event.userId),
        reqId: context.reqId,
        error: error instanceof Error ? error.name : "unknown_error",
        audioIdHash: createHash("sha256")
          .update(event.audioId)
          .digest("hex")
          .slice(0, 12),
      });
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "unsupportedAudio"),
        context.reqId,
        "audio-download-failed"
      );
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
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "unsupportedAudio"),
        context.reqId,
        "audio-unsupported-format"
      );
      return;
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
        event.senderId,
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
      context.reqId,
      event.senderId,
      event.userId,
      event.audioId,
      preparedAudio,
      commitProviderAttemptQuota,
      "whatsapp",
      providerJob
    );
    if (!transcript) {
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "unsupportedAudio"),
        context.reqId,
        "audio-empty-transcript"
      );
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
    if (error instanceof MessengerDailyAudioTranscriptionBudgetExceededError) {
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "outOfFreeCredits"),
        context.reqId,
        "audio-daily-budget-exhausted"
      );
      return;
    }
    if (
      error instanceof MessengerQuotaReservationCommitError ||
      error instanceof MessengerSpendBudgetExceededError
    ) {
      await sendWhatsAppTextReply(
        event.senderId,
        t(context.lang, "outOfFreeCredits"),
        context.reqId,
        "audio-quota-commit-failed"
      );
      return;
    }

    throw error;
  } finally {
    if (reservation) {
      await releaseTranscriptionReservation(event.senderId, reservation);
    }
    if (audioBudgetReserved && !audioBudgetCommitted) {
      await releaseMessengerDailyAudioTranscriptionBudgetReservation({
        now: audioBudgetNow,
      });
    }
  }
}
