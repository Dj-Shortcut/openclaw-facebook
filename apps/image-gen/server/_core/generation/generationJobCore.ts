import type { executeGenerationFlow } from "../generationFlow";
import { t } from "../i18n";
import {
  getFreeDailyLimit,
  hasQuotaBypass,
  MessengerQuotaReservationCommitError,
} from "../messengerQuota";
import {
  commitImageGenerationUsage,
  releaseImageGenerationUsage,
  reserveImageGenerationUsage,
  type ImageGenerationQuotaReservation,
} from "../limits/generationQuota";
import { anonymizePsid } from "../messengerState";
import { safeLog } from "../messengerApi";
import type { MessengerGenerationJob } from "../messengerGenerationJob";
import type { GenerationKind } from "../image-generation/generationTypes";

type GenerationFlowSuccess = Extract<
  Awaited<ReturnType<typeof executeGenerationFlow>>,
  { kind: "success" }
>;

type GenerationFlowError = Extract<
  Awaited<ReturnType<typeof executeGenerationFlow>>,
  { kind: "error" }
>;

type GenerationMetrics = NonNullable<GenerationFlowSuccess["metrics"]>;

export function resolveGenerationKind(input: {
  generationKind?: GenerationKind;
  sourceImageUrl?: string;
}): GenerationKind {
  return input.generationKind ??
    (input.sourceImageUrl ? "source_image_edit" : "text_to_image");
}

export async function reserveMessengerGenerationQuota(input: {
  psid: string;
  userKey: string;
  quotaCount: number;
}): Promise<ImageGenerationQuotaReservation | null> {
  const reservation = await reserveImageGenerationUsage({
    channel: "messenger",
    senderId: input.psid,
  });
  const bypassApplied = hasQuotaBypass(input.psid, input.userKey);
  const allowed = Boolean(reservation);
  safeLog("quota_decision", {
    action: "reserve",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    count: input.quotaCount,
    limit: getFreeDailyLimit(),
    bypassApplied,
    allowed,
  });
  return reservation;
}

export async function commitMessengerGenerationQuota(input: {
  psid: string;
  reservation: ImageGenerationQuotaReservation;
  generationKind: GenerationKind;
}): Promise<void> {
  const committed = await commitImageGenerationUsage({
    channel: "messenger",
    senderId: input.psid,
    reservation: input.reservation,
  });
  if (!committed) {
    throw new MessengerQuotaReservationCommitError();
  }

  safeLog("quota_decision", {
    action: "commit_provider_attempt",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.generationKind,
    allowed: true,
  });
}

export async function releaseMessengerGenerationQuota(input: {
  psid: string;
  reservation: ImageGenerationQuotaReservation;
}): Promise<void> {
  await releaseImageGenerationUsage({
    channel: "messenger",
    senderId: input.psid,
    reservation: input.reservation,
  });
}

export function buildGenerationSuccessDiagnosticPayload(input: {
  reqId: string;
  psid: string;
  generationKind: GenerationKind;
  metrics: GenerationMetrics;
  messengerSendMs: number;
}) {
  return {
    generationId: input.reqId,
    senderId: input.psid,
    style: input.generationKind,
    success: true,
    durationsMs: {
      source_image_downloaded: input.metrics.fbImageFetchMs ?? 0,
      prompt_built: input.metrics.promptBuildMs ?? 0,
      provider_payload_built: input.metrics.openAiPayloadBuildMs ?? 0,
      provider_request: input.metrics.openAiMs ?? 0,
      provider_response_parsed: input.metrics.openAiParseMs ?? 0,
      result_uploaded_or_stored: input.metrics.uploadOrServeMs ?? 0,
      messenger_send: input.messengerSendMs,
      total: input.metrics.totalMs + input.messengerSendMs,
    },
  };
}

export function buildGenerationFailureDiagnosticPayload(input: {
  reqId: string;
  psid: string;
  generationKind: GenerationKind;
  metrics: Partial<GenerationMetrics> & { totalMs: number };
  failureReason: GenerationFlowError["errorKind"];
}) {
  return {
    generationId: input.reqId,
    senderId: input.psid,
    style: input.generationKind,
    success: false,
    failureReason: input.failureReason,
    durationsMs: {
      source_image_downloaded: input.metrics.fbImageFetchMs ?? 0,
      prompt_built: input.metrics.promptBuildMs ?? 0,
      provider_payload_built: input.metrics.openAiPayloadBuildMs ?? 0,
      provider_request: input.metrics.openAiMs ?? 0,
      provider_response_parsed: input.metrics.openAiParseMs ?? 0,
      result_uploaded_or_stored: input.metrics.uploadOrServeMs ?? 0,
      total: input.metrics.totalMs,
    },
  };
}

export function getGenerationFailureMessage(
  errorKind: GenerationFlowError["errorKind"],
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
