import type { executeGenerationFlow } from "../generationFlow";
import { t } from "../i18n";
import { MessengerQuotaReservationCommitError } from "../messengerQuota";
import {
  commitMessengerImageQuotaSuccess,
  getMessengerImageQuotaReservationRenewIntervalMs,
  releaseMessengerImageQuotaReservation,
  renewMessengerImageQuotaReservation,
  reserveMessengerImageQuota,
  type MessengerImageQuotaCommitResult,
  type MessengerImageQuotaIdentity,
  type MessengerImageQuotaReservation,
  type MessengerImageQuotaReservationDecision,
} from "../messengerImageQuotaStore";
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

export type MessengerGenerationQuotaLeaseHeartbeat = {
  stopAndAssertOwned: () => Promise<void>;
};

export class MessengerImageQuotaLeaseLostError extends MessengerQuotaReservationCommitError {
  constructor() {
    super("Messenger image quota reservation lease was lost");
    this.name = "MessengerImageQuotaLeaseLostError";
  }
}

export function resolveGenerationKind(input: {
  generationKind?: GenerationKind;
  sourceImageUrl?: string;
}): GenerationKind {
  return (
    input.generationKind ??
    (input.sourceImageUrl ? "source_image_edit" : "text_to_image")
  );
}

export async function reserveMessengerGenerationQuota(input: {
  psid: string;
  identity: MessengerImageQuotaIdentity;
  requestId: string;
}): Promise<MessengerImageQuotaReservationDecision> {
  const decision = await reserveMessengerImageQuota(
    input.identity,
    input.requestId
  );
  safeLog("quota_decision", {
    action: "reserve",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    dailyUsed: decision.quotaStatus.daily.used,
    dailyLimit: decision.quotaStatus.daily.limit,
    monthlyUsed: decision.quotaStatus.monthly.used,
    monthlyLimit: decision.quotaStatus.monthly.limit,
    result: decision.status,
    allowed:
      decision.status === "reserved" || decision.status === "already_committed",
  });
  return decision;
}

export async function commitMessengerGenerationQuota(input: {
  psid: string;
  identity: MessengerImageQuotaIdentity;
  reservation: MessengerImageQuotaReservation;
  generationKind: GenerationKind;
  /** Revalidates the current Page binding immediately before quota commit. */
  assertCurrentBinding: () => Promise<void>;
}): Promise<MessengerImageQuotaCommitResult> {
  await input.assertCurrentBinding();
  const result = await commitMessengerImageQuotaSuccess(
    input.identity,
    input.reservation
  );
  if (!result.committed) {
    throw new MessengerQuotaReservationCommitError();
  }

  safeLog("quota_decision", {
    action: "commit_generation_success",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.generationKind,
    alreadyCommitted: result.alreadyCommitted,
    dailyRemaining: result.quotaStatus.daily.remaining,
    monthlyRemaining: result.quotaStatus.monthly.remaining,
    allowed: true,
  });
  return result;
}

export async function releaseMessengerGenerationQuota(input: {
  identity: MessengerImageQuotaIdentity;
  reservation: MessengerImageQuotaReservation;
}): Promise<void> {
  await releaseMessengerImageQuotaReservation(
    input.identity,
    input.reservation
  );
}

/** Keeps a billable image reservation alive while the provider is running. */
export function startMessengerGenerationQuotaLeaseHeartbeat(input: {
  identity: MessengerImageQuotaIdentity;
  reservation: MessengerImageQuotaReservation;
}): MessengerGenerationQuotaLeaseHeartbeat {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let renewalInFlight: Promise<void> | null = null;
  let failure: Error | undefined;
  let stopPromise: Promise<void> | null = null;
  const intervalMs = getMessengerImageQuotaReservationRenewIntervalMs();

  const renewOnce = async (): Promise<void> => {
    try {
      const owned = await renewMessengerImageQuotaReservation(
        input.identity,
        input.reservation
      );
      if (!owned && failure === undefined) {
        failure = new MessengerImageQuotaLeaseLostError();
      }
    } catch (error) {
      if (failure === undefined) {
        failure =
          error instanceof Error
            ? error
            : new MessengerImageQuotaLeaseLostError();
      }
    }
  };
  const schedule = (): void => {
    if (stopped || failure !== undefined) return;
    timer = setTimeout(() => {
      timer = null;
      renewalInFlight = renewOnce().finally(() => {
        renewalInFlight = null;
        schedule();
      });
    }, intervalMs);
    timer.unref?.();
  };

  // Renew immediately so a reservation made near a queue-lease boundary gets
  // a full provider window before the first scheduled heartbeat.
  renewalInFlight = renewOnce().finally(() => {
    renewalInFlight = null;
    schedule();
  });

  return {
    stopAndAssertOwned: () => {
      stopPromise ??= (async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (renewalInFlight) await renewalInFlight;
        if (failure !== undefined) throw failure;
        const owned = await renewMessengerImageQuotaReservation(
          input.identity,
          input.reservation
        );
        if (!owned) throw new MessengerImageQuotaLeaseLostError();
      })();
      return stopPromise;
    },
  };
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
      text: t(lang, "generationProviderUnavailable"),
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
