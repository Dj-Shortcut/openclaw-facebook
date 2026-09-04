import { createHash } from "node:crypto";
import type { MessengerSendOutcome } from "./messengerApi";
import type { ImageQuotaBalance } from "./botResponse";
import { safeLog } from "./messengerApi";
import { getGenerationMetrics } from "./image-generation/openAiImageClient";
import { executeGenerationFlow } from "./generationFlow";
import type { ProviderAttemptAdmission } from "./imageService";
import {
  buildFreeQuotaReachedResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
  buildImageQuotaBalanceResponse,
  buildStartpilotQuotaReachedResponse,
} from "./conversationActions";
import {
  admitStartpilotImageProviderAttempt,
  recoverStartpilotImageProviderAdmission,
} from "./startpilotImageProviderAdmission";
import {
  anonymizePsid,
  getOrCreateState,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
} from "./messengerState";
import { t } from "./i18n";
import { toLogUser } from "./privacy";
import { runGuardedGeneration } from "./generationGuard";
import {
  recordGenerationError,
  recordGenerationSuccess,
  recordMessengerDeliveryFailure,
  recordMessengerDuplicateSkip,
} from "./botRuntimeStats";
import { emitGenerationDiagnostic } from "./generationDiagnostics";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import type { GenerationKind } from "./image-generation/generationTypes";
import {
  hasQuotaBypass,
  MessengerQuotaReservationCommitError,
} from "./messengerQuota";
import {
  getMessengerImageQuotaStatus,
  type MessengerImageQuotaIdentity,
  type MessengerImageQuotaReservation,
  type MessengerImageQuotaStatus,
} from "./messengerImageQuotaStore";
import { isMessengerAdmin } from "./messengerAdmin";
import {
  buildGenerationFailureDiagnosticPayload,
  buildGenerationSuccessDiagnosticPayload,
  commitMessengerGenerationQuota,
  getGenerationFailureMessage,
  MessengerImageQuotaLeaseLostError,
  releaseMessengerGenerationQuota,
  reserveMessengerGenerationQuota,
  resolveGenerationKind,
  startMessengerGenerationQuotaLeaseHeartbeat,
  type MessengerGenerationQuotaLeaseHeartbeat,
} from "./generation/generationJobCore";
import {
  enqueueOrRunMessengerGenerationJob,
  isMessengerGenerationQueueEnabled,
} from "./messengerGenerationQueue";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
  markMessengerGenerationDeliveryAccepted,
  markMessengerGenerationDeliveryRetryable,
  markMessengerGenerationDeliveryStarted,
  markMessengerGenerationDelivered,
  markMessengerGenerationQuotaCommitted,
  markMessengerGenerationSuccessNoticeSent,
  type MessengerGenerationCompletion,
  type MessengerGenerationCompletionFence,
  type MessengerGenerationQuotaAccountingMode,
} from "./messengerGenerationCompletion";
import {
  MESSENGER_ASYNC_RESPONSE_QUEUED,
  MESSENGER_SEND_SKIPPED,
  combineMessengerSendOutcomes,
} from "./webhookFallback";
import { clearInFlightNotice } from "./webhookHandlerContext";
import type { HandlerContext } from "./webhookHandlerTypes";
import {
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  runWithMessengerRequestContext,
  setMessengerRequestOperationId,
} from "./messengerRequestContext";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
  resolveWorkspaceRuntimePolicy,
} from "./workspaceEntitlementRuntime";
import {
  assertMessengerPrivacySubject,
  MessengerPrivacyFenceError,
} from "./messengerPrivacySubject";
import {
  commitDeliveredPaidCreditGeneration,
  reservePaidCreditGeneration,
  type PaidCreditGenerationInput,
  type PaidCreditGenerationReservation,
} from "./billing/creditGenerationAdmission";
import {
  CreditCheckoutReservationError,
  reserveMessengerCreditCheckout,
  type ReservedMessengerCreditCheckout,
} from "./billing/creditCheckoutReservationService";
import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";
import { getUserKey } from "./messengerStateNormalization";

type GenerationJobRunner = {
  runImageGeneration: HandlerContext["runImageGeneration"];
  processMessengerGenerationJob: (
    input: MessengerGenerationJob
  ) => Promise<MessengerSendOutcome>;
  processMessengerGenerationJobDeadLetter: (
    input: MessengerGenerationJob
  ) => Promise<MessengerSendOutcome>;
};

type GenerationJobRunnerDeps = Pick<
  HandlerContext,
  | "maybeSendInFlightMessage"
  | "sendLoggedImage"
  | "sendLoggedActions"
  | "sendLoggedText"
>;

class MessengerGenerationDeliveryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Messenger image delivery failed");
    this.name = "MessengerGenerationDeliveryError";
    this.cause = cause;
  }
}

class MessengerGenerationNoticeDeliveryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Messenger generation balance notice delivery failed");
    this.name = "MessengerGenerationNoticeDeliveryError";
    this.cause = cause;
  }
}

class MessengerImageQuotaBusyError extends Error {
  constructor() {
    super("Messenger image quota reservation is busy");
    this.name = "MessengerImageQuotaBusyError";
  }
}

class StartpilotImageQuotaExhaustedError extends Error {
  constructor(readonly reason: "total_exhausted" | "daily_exhausted") {
    super("Startpilot image quota is exhausted");
    this.name = "StartpilotImageQuotaExhaustedError";
  }
}

class StartpilotProviderAdmissionRetryError extends Error {
  constructor(cause: unknown) {
    super("Startpilot provider admission must be retried", { cause });
    this.name = "StartpilotProviderAdmissionRetryError";
  }
}

function asStartpilotProviderAdmissionRetryError(
  error: unknown
): StartpilotProviderAdmissionRetryError | null {
  const seen = new Set<unknown>();
  const findRetryError = (
    candidate: unknown
  ): StartpilotProviderAdmissionRetryError | null => {
    if (candidate instanceof StartpilotProviderAdmissionRetryError) {
      return candidate;
    }
    if (
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      candidate === null ||
      seen.has(candidate)
    ) {
      return null;
    }
    seen.add(candidate);
    if (candidate instanceof AggregateError) {
      for (const nested of candidate.errors) {
        const retryError = findRetryError(nested);
        if (retryError) return retryError;
      }
    }
    if (candidate instanceof Error && candidate.cause !== undefined) {
      return findRetryError(candidate.cause);
    }
    return null;
  };

  const retryError = findRetryError(error);
  if (!retryError || retryError === error) return retryError;
  return new StartpilotProviderAdmissionRetryError(error);
}

class MessengerImageQuotaRecoveryError extends Error {
  constructor() {
    super(
      "Messenger image quota was committed without a recoverable completion"
    );
    this.name = "MessengerImageQuotaRecoveryError";
  }
}

type FreeGenerationQuotaDecision =
  | Readonly<{
      status: "reserved";
      reservation: MessengerImageQuotaReservation;
    }>
  | Readonly<{
      status: "exhausted";
      quotaStatus: MessengerImageQuotaStatus;
    }>;

const CREDIT_GENERATION_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const CREDIT_GENERATION_REQUEST_ID_MAX_LENGTH = 160;
const CREDIT_GENERATION_MAX_DATABASE_ID = 2_147_483_647;

function toConversationImageQuotaBalance(
  status: MessengerImageQuotaStatus
): ImageQuotaBalance {
  return {
    daily: { ...status.daily },
    monthly: { ...status.monthly },
  };
}

/** Creates the Messenger image-generation job runner and queue/dead-letter entry points. */
export function createMessengerGenerationJobRunner(
  deps: GenerationJobRunnerDeps
): GenerationJobRunner {
  async function executeImageGenerationJob(
    job: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    return await runWithMessengerRequestContext(
      job.pageId,
      () => {
        setMessengerRequestOperationId(job.reqId);
        return executeImageGenerationJobInPageContext(job);
      },
      job.workspaceId && job.channelConnectionId && job.bindingEpoch
        ? {
            channel: "facebook_messenger",
            workspaceId: job.workspaceId,
            channelConnectionId: job.channelConnectionId,
            bindingEpoch: job.bindingEpoch,
            userKey: job.userId,
            privacyEpoch: job.privacyEpoch,
          }
        : undefined
    );
  }

  async function executeImageGenerationJobInPageContext(
    job: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    const {
      psid,
      userId,
      generationKind,
      reqId,
      lang,
      sourceImageUrl,
      sourceImageUrls,
      promptHint,
      pageId,
    } = job;
    const resolvedGenerationKind = resolveGenerationKind({
      generationKind,
      sourceImageUrl,
    });
    const pendingRecovery = job.startpilotAdmissionRecovery;
    if (pendingRecovery) {
      if (
        !job.workspaceId ||
        !job.channelConnectionId ||
        !job.bindingEpoch ||
        (pendingRecovery.resumeGeneration && !job.pageId) ||
        (job.privacyEpoch !== undefined &&
          job.privacyEpoch !== pendingRecovery.privacyEpoch) ||
        pendingRecovery.providerOperation !== resolvedGenerationKind
      ) {
        throw new Error("Startpilot provider recovery job scope mismatch");
      }
      await recoverStartpilotImageProviderAdmission({
        fence: {
          leaseToken: pendingRecovery.leaseToken,
          attemptKeyHash: pendingRecovery.attemptKeyHash,
          channel: "facebook_messenger",
          workspaceId: job.workspaceId,
          channelConnectionId: job.channelConnectionId,
          bindingEpoch: job.bindingEpoch,
          pageId: job.pageId,
          userKey: job.userId,
          privacyEpoch: pendingRecovery.privacyEpoch,
          providerOperation: pendingRecovery.providerOperation,
          privacyMode: "active",
        },
        providerOperation: pendingRecovery.providerOperation,
        workspaceId: job.workspaceId,
        entitlementId: pendingRecovery.entitlementId,
        channelConnectionId: job.channelConnectionId,
        bindingEpoch: job.bindingEpoch,
        mode: pendingRecovery.mode,
        idempotencyKey: pendingRecovery.idempotencyKey,
        pageIdHash: pendingRecovery.pageIdHash,
      }).catch(error => {
        throw new StartpilotProviderAdmissionRetryError(error);
      });
      delete job.startpilotAdmissionRecovery;
      if (!pendingRecovery.resumeGeneration) {
        return MESSENGER_SEND_SKIPPED;
      }
    }
    // Current ownership/privacy gates decide whether generation may resume.
    // Compensation above cannot call a provider and independently proves the
    // immutable historical Page, receipt, and attempt-fence binding in SQL.
    await assertMessengerGenerationOwnership(job);
    await assertGenerationJobPrivacy(job);
    let sendOutcome: MessengerSendOutcome = MESSENGER_SEND_SKIPPED;
    const rememberSendOutcome = (outcome: MessengerSendOutcome) => {
      sendOutcome = combineMessengerSendOutcomes(sendOutcome, outcome);
      return outcome;
    };
    let durableGenerationRecoveryRequired = false;

    let didRun: Awaited<ReturnType<typeof runGuardedGeneration<void>>>;
    try {
      didRun = await runGuardedGeneration(psid, async () => {
        const workspacePolicy = await resolveWorkspaceRuntimePolicy(pageId);
        const ownerQuotaBypass = isMessengerAdmin(psid, userId);
        const quotaBypassApplied =
          ownerQuotaBypass || hasQuotaBypass(psid, userId);
        const successQuotaIdentity =
          workspacePolicy.kind === "free" && !quotaBypassApplied
            ? imageQuotaIdentityForJob(job)
            : undefined;
        if (
          await finishDuplicateGenerationIfCompleted({
            deps,
            psid,
            userId,
            reqId,
            lang,
            promptHint,
            resolvedGenerationKind,
            rememberSendOutcome,
            completionFence: completionFenceForJob(job),
            successQuotaIdentity,
            assertCurrentBinding: () => assertMessengerGenerationOwnership(job),
            onDurableCompletionFound: () => {
              durableGenerationRecoveryRequired = true;
            },
          })
        ) {
          return;
        }

        const freeQuotaDecision = successQuotaIdentity
          ? await reserveGenerationQuota({
              psid,
              reqId,
              identity: successQuotaIdentity,
            })
          : null;
        let paidCreditReservation: PaidCreditGenerationReservation | null =
          null;
        if (freeQuotaDecision?.status === "exhausted") {
          const paidInput = paidCreditGenerationInputForJob(job);
          if (paidInput) {
            const paidDecision = await reservePaidCreditGeneration(paidInput);
            if (paidDecision.available) {
              paidCreditReservation = paidDecision.reservation;
            } else if (paidDecision.reason === "empty") {
              const checkout = await tryReserveCreditCheckout(paidInput);
              if (checkout) {
                await sendCreditCheckoutNotice({
                  deps,
                  psid,
                  reqId,
                  lang,
                  rememberSendOutcome,
                  quotaStatus: freeQuotaDecision.quotaStatus,
                  checkout,
                });
                return;
              }
            } else if (
              paidDecision.reason === "request_in_progress" ||
              paidDecision.reason === "request_closed"
            ) {
              // Another execution already owns, or permanently resolved, this
              // deterministic request. Stay provider- and delivery-silent.
              return;
            }
          }
          if (!paidCreditReservation) {
            await sendFreeQuotaReachedNotice({
              deps,
              psid,
              reqId,
              lang,
              rememberSendOutcome,
              quotaStatus: freeQuotaDecision.quotaStatus,
            });
            return;
          }
        }

        const quotaReservation =
          freeQuotaDecision?.status === "reserved"
            ? freeQuotaDecision.reservation
            : null;

        let pendingQuotaReservation: MessengerImageQuotaReservation | null =
          quotaReservation;
        let quotaLeaseHeartbeat: MessengerGenerationQuotaLeaseHeartbeat | null =
          successQuotaIdentity && quotaReservation
            ? startMessengerGenerationQuotaLeaseHeartbeat({
                identity: successQuotaIdentity,
                reservation: quotaReservation,
              })
            : null;
        let paidCreditTransportStarted = false;
        let paidCreditReleasePromise: Promise<void> | null = null;
        let paidCreditProviderAcceptedPromise: Promise<void> | null = null;
        let paidCreditCommitPromise: Promise<void> | null = null;
        let paidCreditRejectedReleasePromise: Promise<void> | null = null;
        let paidCreditProviderRejected = false;
        const releasePaidCreditBeforeTransport = async (): Promise<void> => {
          if (
            !paidCreditReservation ||
            paidCreditTransportStarted ||
            paidCreditCommitPromise
          ) {
            return;
          }
          paidCreditReleasePromise ??=
            paidCreditReservation.releaseBeforeTransport();
          await paidCreditReleasePromise;
        };
        const markPaidCreditProviderAccepted = async (): Promise<void> => {
          if (!paidCreditReservation) return;
          paidCreditProviderAcceptedPromise ??=
            paidCreditReservation.markProviderAccepted();
          await paidCreditProviderAcceptedPromise;
        };
        const commitPaidCreditDeliveredOutput = async (): Promise<void> => {
          if (!paidCreditReservation) return;
          paidCreditCommitPromise ??=
            paidCreditReservation.commitDeliveredOutput();
          await paidCreditCommitPromise;
        };
        const releasePaidCreditProviderRejected = async (
          status: number
        ): Promise<void> => {
          if (!paidCreditReservation || !paidCreditTransportStarted) {
            throw new Error(
              "Paid credit provider rejection arrived before transport started"
            );
          }
          paidCreditRejectedReleasePromise ??=
            paidCreditReservation.releaseProviderRejected(status);
          await paidCreditRejectedReleasePromise;
          paidCreditProviderRejected = true;
        };
        let providerAttemptsStarted = 0;
        let providerFenceSequence = 0;
        const providerFences: MessengerProviderAttemptFence[] = [];
        try {
          await setFlowState(psid, "PROCESSING");
          await sendGenerationStartedAck({
            deps,
            psid,
            userId,
            reqId,
            lang,
            resolvedGenerationKind,
            rememberSendOutcome,
          });

          const state = await getOrCreateState(psid);
          const shouldSendSourceImage =
            resolvedGenerationKind === "source_image_edit";
          const sourceIsGeneratedResult = Boolean(
            shouldSendSourceImage &&
            sourceImageUrl &&
            (sourceImageUrl === state.lastGeneratedUrl ||
              sourceImageUrl === state.lastImageUrl)
          );
          const beginProviderAttempt =
            async (): Promise<ProviderAttemptAdmission> => {
              // A paid hold represents exactly one provider transport. Once
              // that transport may have reached OpenAI, a retry could create
              // a second billable image while only one credit is reserved.
              // Leave the hold for bounded reconciliation instead.
              if (paidCreditReservation && paidCreditTransportStarted) {
                throw new Error(
                  "Paid credit provider transport is already in progress"
                );
              }
              await assertMessengerGenerationOwnership(job);
              await assertGenerationJobPrivacy(job);
              providerFenceSequence += 1;
              const providerFence = await reserveMessengerProviderAttemptFence(
                job,
                resolvedGenerationKind,
                providerFenceSequence
              );
              let state: "reserved" | "started" | "terminal" = "reserved";
              let startPromise: Promise<void> | null = null;
              let paidAdmissionRecovery:
                | NonNullable<
                    MessengerGenerationJob["startpilotAdmissionRecovery"]
                  >
                | undefined;

              return Object.freeze({
                ...(paidCreditReservation
                  ? {
                      providerSpendBudget: Object.freeze({
                        estimatedCostUsd:
                          paidCreditReservation.providerMaxCostUsd,
                        estimateSource:
                          "operator_conservative_paid_image_max_v1",
                      }),
                    }
                  : {}),
                markTransportStarted: async () => {
                  if (state === "started") return;
                  if (state === "terminal") {
                    throw new Error("Provider attempt is already terminal");
                  }
                  if (
                    paidCreditReservation &&
                    (paidCreditReleasePromise ||
                      paidCreditCommitPromise ||
                      paidCreditRejectedReleasePromise)
                  ) {
                    throw new Error(
                      "Paid credit reservation is already terminal"
                    );
                  }
                  if (!startPromise) {
                    startPromise = (async () => {
                      if (
                        workspacePolicy.kind === "startpilot" &&
                        providerAttemptsStarted === 0
                      ) {
                        if (
                          job.workspaceId !== workspacePolicy.workspaceId ||
                          !job.channelConnectionId ||
                          !job.bindingEpoch
                        ) {
                          throw new Error(
                            "Startpilot generation scope mismatch"
                          );
                        }
                        const usage = await admitStartpilotImageProviderAttempt(
                          {
                            fence: providerFence,
                            providerOperation: resolvedGenerationKind,
                            workspaceId: workspacePolicy.workspaceId,
                            entitlementId: workspacePolicy.entitlementId,
                            channelConnectionId: job.channelConnectionId,
                            bindingEpoch: job.bindingEpoch,
                            mode: workspacePolicy.mode,
                            idempotencyKey:
                              startpilotImageUsageIdempotencyKey(job),
                          }
                        ).catch(error => {
                          if (
                            providerFence.leaseToken &&
                            providerFence.attemptKeyHash &&
                            providerFence.privacyEpoch &&
                            job.pageId
                          ) {
                            paidAdmissionRecovery = {
                              version: "startpilot_admission_recovery_v1",
                              resumeGeneration: true,
                              recoveryDeadlineAt:
                                Date.now() + 30 * 24 * 60 * 60_000,
                              pageIdHash: createHash("sha256")
                                .update(job.pageId)
                                .digest("hex"),
                              entitlementId: workspacePolicy.entitlementId,
                              mode: workspacePolicy.mode,
                              providerOperation: resolvedGenerationKind,
                              attemptKeyHash: providerFence.attemptKeyHash,
                              leaseToken: providerFence.leaseToken,
                              privacyEpoch: providerFence.privacyEpoch,
                              idempotencyKey:
                                startpilotImageUsageIdempotencyKey(job),
                            };
                          }
                          throw new StartpilotProviderAdmissionRetryError(
                            error
                          );
                        });
                        if (!usage.allowed) {
                          state = "terminal";
                          throw new StartpilotImageQuotaExhaustedError(
                            usage.reason
                          );
                        }
                      } else {
                        await markMessengerProviderAttemptStarted(
                          providerFence
                        );
                      }
                      if (paidCreditReservation) {
                        await paidCreditReservation.markTransportStarted();
                        paidCreditTransportStarted = true;
                      }
                      state = "started";
                      providerFences.push(providerFence);
                      providerAttemptsStarted += 1;
                    })();
                  }
                  await startPromise;
                },
                abortBeforeTransport: async () => {
                  if (state !== "reserved") return;
                  if (paidAdmissionRecovery) {
                    job.startpilotAdmissionRecovery = paidAdmissionRecovery;
                    try {
                      await recoverStartpilotImageProviderAdmission({
                        fence: providerFence,
                        providerOperation:
                          paidAdmissionRecovery.providerOperation,
                        workspaceId: job.workspaceId!,
                        entitlementId: paidAdmissionRecovery.entitlementId,
                        channelConnectionId: job.channelConnectionId!,
                        bindingEpoch: job.bindingEpoch!,
                        mode: paidAdmissionRecovery.mode,
                        idempotencyKey: paidAdmissionRecovery.idempotencyKey,
                        pageIdHash: paidAdmissionRecovery.pageIdHash,
                      });
                      delete job.startpilotAdmissionRecovery;
                      state = "terminal";
                      return;
                    } catch (error) {
                      throw new StartpilotProviderAdmissionRetryError(error);
                    }
                  }
                  const cleanupErrors: unknown[] = [];
                  try {
                    await finalizeMessengerProviderAttemptFence(
                      providerFence,
                      "known_failed"
                    );
                  } catch (error) {
                    cleanupErrors.push(error);
                  }
                  try {
                    await releasePaidCreditBeforeTransport();
                  } catch (error) {
                    cleanupErrors.push(error);
                  }
                  if (cleanupErrors.length > 0) {
                    throw new AggregateError(
                      cleanupErrors,
                      "Provider admission cleanup failed"
                    );
                  }
                  state = "terminal";
                },
              });
            };

          const generationResult = await executeGenerationFlow({
            generationKind: resolvedGenerationKind,
            userId,
            reqId,
            promptHint,
            sourceImageUrl: shouldSendSourceImage ? sourceImageUrl : undefined,
            sourceImageUrls: shouldSendSourceImage
              ? sourceImageUrls
              : undefined,
            lastPhotoUrl: shouldSendSourceImage
              ? sourceIsGeneratedResult
                ? sourceImageUrl
                : state.lastPhotoUrl
              : undefined,
            lastPhotoSource: shouldSendSourceImage
              ? sourceIsGeneratedResult
                ? "stored"
                : state.lastPhotoSource
              : undefined,
            onProviderAttempt: beginProviderAttempt,
            onProviderSuccess: paidCreditReservation
              ? markPaidCreditProviderAccepted
              : undefined,
            onProviderRejected: paidCreditReservation
              ? releasePaidCreditProviderRejected
              : undefined,
            bypassBudgetLimits: ownerQuotaBypass,
            costLedgerChannel: "facebook_messenger",
            costLedgerScope:
              job.workspaceId &&
              job.channelConnectionId &&
              job.bindingEpoch &&
              job.privacyEpoch
                ? {
                    workspaceId: job.workspaceId,
                    channelConnectionId: job.channelConnectionId,
                    bindingEpoch: job.bindingEpoch,
                    privacyEpoch: job.privacyEpoch,
                    userKey: userId,
                  }
                : undefined,
            imageModel:
              workspacePolicy.kind === "startpilot"
                ? workspacePolicy.imageModel
                : undefined,
            imageQuality:
              paidCreditReservation?.imageQuality ??
              (workspacePolicy.kind === "startpilot"
                ? workspacePolicy.imageQuality
                : undefined),
          });

          if (generationResult.kind === "success") {
            try {
              if (providerAttemptsStarted === 0) {
                const admission = await beginProviderAttempt();
                await admission.markTransportStarted();
              }
              await assertMessengerGenerationOwnership(job);
              await assertGenerationJobPrivacy(job);
              await handleGenerationSuccess({
                deps,
                generationResult,
                promptHint,
                psid,
                reqId,
                resolvedGenerationKind,
                userId,
                lang,
                rememberSendOutcome,
                completionFence: completionFenceForJob(job),
                successQuotaIdentity: paidCreditReservation
                  ? undefined
                  : successQuotaIdentity,
                quotaAccountingMode: paidCreditReservation
                  ? "paid_credit_delivery_v1"
                  : workspacePolicy.kind === "startpilot"
                    ? "startpilot_attempt_committed_v1"
                    : "success_only_v1",
                paidCreditMode: paidCreditReservation?.mode,
                quotaReservation: pendingQuotaReservation,
                quotaLeaseHeartbeat: paidCreditReservation
                  ? null
                  : quotaLeaseHeartbeat,
                assertCurrentBinding: () =>
                  assertMessengerGenerationOwnership(job),
                commitDeliveredOutput: paidCreditReservation
                  ? commitPaidCreditDeliveredOutput
                  : undefined,
                onDurableRecoveryRequired: () => {
                  durableGenerationRecoveryRequired = true;
                },
              });
              pendingQuotaReservation = null;
              quotaLeaseHeartbeat = null;
            } catch (error) {
              if (
                error instanceof MessengerPrivacyFenceError ||
                error instanceof MessengerImageQuotaLeaseLostError
              ) {
                const key = storageKeyFromPublicUrl(generationResult.imageUrl);
                if (key) await storageDelete(key);
              }
              throw error;
            }
            await Promise.all(
              providerFences.map(fence =>
                finalizeMessengerProviderAttemptFence(fence, "succeeded")
              )
            );
            providerFences.length = 0;
            return;
          }

          await Promise.all(
            providerFences.map(fence =>
              finalizeMessengerProviderAttemptFence(
                fence,
                paidCreditProviderRejected ? "known_failed" : "ambiguous"
              )
            )
          );
          providerFences.length = 0;

          if (
            generationResult.error instanceof StartpilotImageQuotaExhaustedError
          ) {
            await sendStartpilotQuotaReachedNotice({
              deps,
              psid,
              reqId,
              lang,
              reason: generationResult.error.reason,
              rememberSendOutcome,
            });
            return;
          }

          const providerAdmissionRetry =
            asStartpilotProviderAdmissionRetryError(generationResult.error);
          if (providerAdmissionRetry) throw providerAdmissionRetry;

          await handleGenerationFailure({
            deps,
            generationResult,
            psid,
            reqId,
            resolvedGenerationKind,
            lang,
            rememberSendOutcome,
          });
        } finally {
          await Promise.all(
            providerFences.map(fence =>
              finalizeMessengerProviderAttemptFence(fence, "ambiguous")
            )
          );
          let quotaLeaseError: Error | undefined;
          if (quotaLeaseHeartbeat) {
            try {
              await quotaLeaseHeartbeat.stopAndAssertOwned();
            } catch (error) {
              quotaLeaseError =
                error instanceof Error
                  ? error
                  : new MessengerQuotaReservationCommitError();
            }
          }
          if (pendingQuotaReservation) {
            await releaseMessengerGenerationQuota({
              identity: successQuotaIdentity ?? imageQuotaIdentityForJob(job),
              reservation: pendingQuotaReservation,
            });
          }
          await releasePaidCreditBeforeTransport();
          if (quotaLeaseError !== undefined) throw quotaLeaseError;
        }
      });
    } catch (error) {
      if (error instanceof MessengerPrivacyFenceError) {
        return MESSENGER_SEND_SKIPPED;
      }
      const providerAdmissionRetry =
        asStartpilotProviderAdmissionRetryError(error);
      if (providerAdmissionRetry) {
        safeLog("startpilot_provider_admission_requeued", {
          level: "error",
          reqId,
          user: toLogUser(userId),
          generationKind: resolvedGenerationKind,
        });
        throw providerAdmissionRetry;
      }
      if (error instanceof MessengerGenerationDeliveryError) {
        recordMessengerDeliveryFailure();
        safeLog("messenger_generation_image_delivery_failed", {
          level: "error",
          reqId,
          user: toLogUser(userId),
          generationKind: resolvedGenerationKind,
          queueEnabled: isMessengerGenerationQueueEnabled(),
          error: error.cause,
        });
        if (!isMessengerGenerationQueueEnabled()) {
          await setFlowState(psid, "IDLE");
          if (shouldPropagateInlineGenerationFailure()) throw error;
          return sendOutcome;
        }
        throw error;
      }
      if (error instanceof MessengerGenerationNoticeDeliveryError) {
        safeLog("messenger_generation_balance_notice_delivery_failed", {
          level: "error",
          reqId,
          user: toLogUser(userId),
          generationKind: resolvedGenerationKind,
          queueEnabled: isMessengerGenerationQueueEnabled(),
          error: error.cause,
        });
        if (!isMessengerGenerationQueueEnabled()) {
          await setFlowState(psid, "IDLE");
          if (shouldPropagateInlineGenerationFailure()) throw error;
          return sendOutcome;
        }
        throw error;
      }
      if (
        error instanceof MessengerImageQuotaBusyError ||
        error instanceof MessengerQuotaReservationCommitError ||
        error instanceof MessengerImageQuotaRecoveryError
      ) {
        if (isMessengerGenerationQueueEnabled()) throw error;
      }
      if (
        durableGenerationRecoveryRequired &&
        isMessengerGenerationQueueEnabled()
      ) {
        safeLog("messenger_generation_durable_recovery_requeued", {
          level: "error",
          reqId,
          user: toLogUser(userId),
          generationKind: resolvedGenerationKind,
          error,
        });
        throw error;
      }
      await recoverUnexpectedGenerationError({
        deps,
        error,
        psid,
        userId,
        reqId,
        lang,
        resolvedGenerationKind,
        rememberSendOutcome,
      });
      if (shouldPropagateInlineGenerationFailure()) throw error;
      return sendOutcome;
    } finally {
      clearInFlightNotice(psid);
    }

    if (didRun === null) {
      const result = await deps.maybeSendInFlightMessage(psid, reqId, lang);
      if ("outcome" in result && result.outcome) {
        rememberSendOutcome(result.outcome);
      }
      return sendOutcome;
    }
    return sendOutcome;
  }

  async function runImageGeneration(
    psid: string,
    userId: string,
    reqId: string,
    lang: MessengerGenerationJob["lang"],
    sourceImageUrl?: string,
    promptHint?: string,
    generationKind?: GenerationKind
  ): Promise<MessengerSendOutcome> {
    const resolvedGenerationKind = resolveGenerationKind({
      generationKind,
      sourceImageUrl,
    });
    const pageId = getMessengerRequestPageId();
    const ownership = await resolveMessengerGenerationOwnership(pageId);
    const requestPrivacy = getMessengerRequestPrivacySubject();
    if (requestPrivacy && requestPrivacy.userKey !== userId) {
      throw new MessengerPrivacyFenceError();
    }
    if (ownership && requestPrivacy) {
      await assertMessengerPrivacySubject({
        workspaceId: ownership.workspaceId,
        channelConnectionId: ownership.channelConnectionId,
        userKey: userId,
        privacyEpoch: requestPrivacy.privacyEpoch,
      });
    } else if (ownership && process.env.NODE_ENV === "production") {
      throw new MessengerPrivacyFenceError();
    }
    const privacyEpoch = requestPrivacy?.privacyEpoch;
    const currentState = await getOrCreateState(psid);
    const sourceImageUrls =
      resolvedGenerationKind === "source_image_edit" &&
      sourceImageUrl &&
      currentState.pendingImageUrls?.includes(sourceImageUrl)
        ? currentState.pendingImageUrls
        : sourceImageUrl
          ? [sourceImageUrl]
          : undefined;
    const result = await enqueueOrRunMessengerGenerationJob(
      {
        psid,
        userId,
        pageId,
        workspaceId: ownership?.workspaceId,
        channelConnectionId: ownership?.channelConnectionId,
        bindingEpoch: ownership?.bindingEpoch,
        privacyEpoch,
        generationKind: resolvedGenerationKind,
        reqId,
        lang,
        sourceImageUrl,
        sourceImageUrls,
        promptHint,
      },
      executeImageGenerationJob,
      { onDeadLetter: processMessengerGenerationJobDeadLetter }
    );

    if (result.mode === "inline") {
      return result.outcome as MessengerSendOutcome;
    }
    if (result.mode === "duplicate") {
      return MESSENGER_ASYNC_RESPONSE_QUEUED;
    }

    await setFlowState(psid, "PROCESSING");
    try {
      await deps.sendLoggedText(psid, t(lang, "generationQueued"), reqId);
    } catch (error) {
      safeLog("messenger_generation_queued_ack_failed", {
        reqId,
        user: toLogUser(userId),
        generationKind: resolvedGenerationKind,
        error,
      });
    }
    safeLog("messenger_generation_job_queued", {
      reqId,
      user: toLogUser(userId),
      generationKind: resolvedGenerationKind,
      queueEnabled: isMessengerGenerationQueueEnabled(),
    });
    return MESSENGER_ASYNC_RESPONSE_QUEUED;
  }

  async function processMessengerGenerationJobDeadLetter(
    input: MessengerGenerationJob
  ): Promise<MessengerSendOutcome> {
    if (input.startpilotAdmissionRecovery) {
      safeLog("messenger_generation_recovery_dead_lettered", {
        reqId: input.reqId,
        generationKind: input.generationKind ?? null,
        attempts: input.attempts ?? null,
      });
      return MESSENGER_SEND_SKIPPED;
    }
    return await runWithMessengerRequestContext(
      input.pageId,
      async () => {
        setMessengerRequestOperationId(input.reqId);
        try {
          await assertGenerationJobPrivacy(input);
        } catch (error) {
          if (error instanceof MessengerPrivacyFenceError) {
            return MESSENGER_SEND_SKIPPED;
          }
          throw error;
        }
        await setFlowState(input.psid, "FAILURE");
        return await deps.sendLoggedText(
          input.psid,
          t(input.lang, "generationGenericFailure"),
          input.reqId
        );
      },
      input.workspaceId && input.channelConnectionId && input.bindingEpoch
        ? {
            channel: "facebook_messenger",
            workspaceId: input.workspaceId,
            channelConnectionId: input.channelConnectionId,
            bindingEpoch: input.bindingEpoch,
            userKey: input.userId,
            privacyEpoch: input.privacyEpoch,
          }
        : undefined
    );
  }

  return {
    runImageGeneration,
    processMessengerGenerationJob: executeImageGenerationJob,
    processMessengerGenerationJobDeadLetter,
  };
}

async function sendStartpilotQuotaReachedNotice(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  reason: "total_exhausted" | "daily_exhausted";
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  const response = buildStartpilotQuotaReachedResponse(
    input.lang,
    input.reason
  );
  let outcome: MessengerSendOutcome;
  try {
    outcome = await input.deps.sendLoggedActions(
      input.psid,
      response.text ??
        t(
          input.lang,
          input.reason === "daily_exhausted"
            ? "startpilotDailyQuotaReached"
            : "startpilotQuotaReached"
        ),
      response.actions ?? [],
      input.reqId,
      { providerAttemptKey: "startpilot-quota-notice-v1" }
    );
  } catch (error) {
    // Meta has no idempotency key. Once delivery may have started, the exact
    // provider fence prevents a second call; settle the local conversation so
    // generic recovery cannot send contradictory failure actions.
    if (isMessengerDeliveryAmbiguous(error)) {
      await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
      return;
    }
    throw new MessengerGenerationNoticeDeliveryError(error);
  }
  input.rememberSendOutcome(outcome);
  if (!outcome.sent) {
    throw new MessengerGenerationNoticeDeliveryError(
      new Error(`Startpilot quota notice send skipped: ${outcome.reason}`)
    );
  }
  await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
}

function shouldPropagateInlineGenerationFailure(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    !isMessengerGenerationQueueEnabled()
  );
}

async function assertGenerationJobPrivacy(
  job: MessengerGenerationJob
): Promise<void> {
  if (
    job.workspaceId &&
    job.channelConnectionId &&
    job.privacyEpoch &&
    job.userId
  ) {
    await assertMessengerPrivacySubject({
      workspaceId: job.workspaceId,
      channelConnectionId: job.channelConnectionId,
      userKey: job.userId,
      privacyEpoch: job.privacyEpoch,
    });
    return;
  }
  if (process.env.NODE_ENV === "production") {
    throw new MessengerPrivacyFenceError();
  }
}

async function sendGenerationStartedAck(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  userId: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  resolvedGenerationKind: GenerationKind;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  try {
    input.rememberSendOutcome(
      await input.deps.sendLoggedText(
        input.psid,
        t(input.lang, "generatingImagePrompt"),
        input.reqId
      )
    );
  } catch (error) {
    logMessengerGenerationRecoveryEvent(
      "messenger_generation_started_ack_failed",
      {
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        error,
      }
    );
  }
}

async function recoverUnexpectedGenerationError(input: {
  deps: GenerationJobRunnerDeps;
  error: unknown;
  psid: string;
  userId: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  resolvedGenerationKind: GenerationKind;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  try {
    await setFlowState(input.psid, "FAILURE");
  } catch (stateError) {
    logMessengerGenerationRecoveryEvent(
      "messenger_generation_recovery_state_failed",
      {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        error: stateError,
      }
    );
    return;
  }

  logMessengerGenerationRecoveryEvent("messenger_generation_unexpected_error", {
    level: "error",
    reqId: input.reqId,
    user: toLogUser(input.userId),
    generationKind: input.resolvedGenerationKind,
    error: input.error,
  });
  recordGenerationError();

  try {
    const failureResponse = buildGenerationFailureResponse(
      input.lang,
      t(input.lang, "generationGenericFailure")
    );
    input.rememberSendOutcome(
      await input.deps.sendLoggedActions(
        input.psid,
        failureResponse.text ?? "",
        failureResponse.actions ?? [],
        input.reqId
      )
    );
  } catch (sendError) {
    logMessengerGenerationRecoveryEvent(
      "messenger_generation_recovery_send_failed",
      {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        error: sendError,
      }
    );
  }
}

function logMessengerGenerationRecoveryEvent(
  event: string,
  details: Record<string, unknown>
): void {
  try {
    safeLog(event, details);
  } catch {
    // Recovery logging must never prevent flow-state recovery.
  }
}

async function finishDuplicateGenerationIfCompleted(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  userId: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  promptHint?: string;
  resolvedGenerationKind: GenerationKind;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  completionFence?: MessengerGenerationCompletionFence;
  successQuotaIdentity?: MessengerImageQuotaIdentity;
  assertCurrentBinding: () => Promise<void>;
  onDurableCompletionFound: () => void;
}): Promise<boolean> {
  const completedGeneration = await Promise.resolve(
    getMessengerGenerationCompletion(input.reqId, input.completionFence)
  );
  if (!completedGeneration) {
    return false;
  }

  if (
    completedGeneration.userKey &&
    completedGeneration.userKey !== input.userId
  ) {
    safeLog("messenger_generation_job_duplicate_user_mismatch", {
      reqId: input.reqId,
      expectedUser: toLogUser(input.userId),
      completionUser: toLogUser(completedGeneration.userKey),
      generationKind: input.resolvedGenerationKind,
    });
    return false;
  }
  input.onDurableCompletionFound();

  safeLog("messenger_generation_job_duplicate_completed", {
    reqId: input.reqId,
    user: toLogUser(input.userId),
    generationKind: input.resolvedGenerationKind,
    deliveryStatus: completedGeneration.deliveryStatus ?? "legacy_completed",
  });
  recordMessengerDuplicateSkip();
  let quotaStatus = completedGeneration.quotaStatus;
  let successNoticeStatus = completedGeneration.successNoticeStatus;
  let deliveryStatus = completedGeneration.deliveryStatus ?? "delivered";
  const recoveryQuotaIdentity = quotaIdentityForCompletionRecovery(
    completedGeneration,
    input.successQuotaIdentity
  );
  if (recoveryQuotaIdentity && !quotaStatus) {
    const decision = await reserveMessengerGenerationQuota({
      psid: input.psid,
      identity: recoveryQuotaIdentity,
      requestId: input.reqId,
    });
    if (decision.status === "busy") throw new MessengerImageQuotaBusyError();
    if (
      decision.status === "reserved" ||
      decision.status === "already_committed"
    ) {
      const committed = await commitMessengerGenerationQuota({
        psid: input.psid,
        identity: recoveryQuotaIdentity,
        reservation: decision.reservation,
        generationKind: input.resolvedGenerationKind,
        assertCurrentBinding: input.assertCurrentBinding,
      });
      quotaStatus = committed.quotaStatus;
    } else if (isLegacyQuotaGrandfatherAllowed(completedGeneration)) {
      // This image predates success-only accounting and is already durable.
      // When today's limit is full, preserve the result and snapshot the
      // current balance without incrementing beyond either hard limit.
      quotaStatus = decision.quotaStatus;
      safeLog("messenger_generation_legacy_quota_grandfathered", {
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        reason: decision.status,
        dailyUsed: quotaStatus.daily.used,
        dailyLimit: quotaStatus.daily.limit,
        monthlyUsed: quotaStatus.monthly.used,
        monthlyLimit: quotaStatus.monthly.limit,
      });
    } else {
      safeLog("messenger_generation_quota_recovery_blocked", {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
        reason: decision.status,
        accountingMode:
          completedGeneration.quotaAccountingMode ?? "unversioned",
        deliveryStatus: completedGeneration.deliveryStatus ?? "unversioned",
      });
      throw new MessengerImageQuotaRecoveryError();
    }
    await markMessengerGenerationQuotaCommitted(
      input.reqId,
      completedGeneration.imageUrl,
      input.userId,
      quotaStatus,
      Date.now(),
      input.completionFence
    );
  }
  if (deliveryStatus === "delivered" && successNoticeStatus === undefined) {
    // Legacy completions were written only after their image and success text
    // had already been delivered. Persist that fact without sending an old
    // notice again.
    await markMessengerGenerationSuccessNoticeSent(
      input.reqId,
      completedGeneration.imageUrl,
      input.userId,
      Date.now(),
      input.completionFence
    );
    successNoticeStatus = "sent";
  }
  await setLastGenerated(input.psid, completedGeneration.imageUrl);
  await setLastGenerationContext(input.psid, { prompt: input.promptHint });
  let imageDeliveryAmbiguous = false;
  if (
    completedGeneration.deliveryStatus === "pending" ||
    completedGeneration.deliveryStatus === "transport_started"
  ) {
    safeLog("messenger_generation_job_duplicate_delivery_recovered", {
      reqId: input.reqId,
      user: toLogUser(input.userId),
      generationKind: input.resolvedGenerationKind,
      priorDeliveryStatus: completedGeneration.deliveryStatus,
    });
    try {
      const recoveredDelivery = await deliverGenerationImage({
        deps: input.deps,
        psid: input.psid,
        imageUrl: completedGeneration.imageUrl,
        reqId: input.reqId,
        userId: input.userId,
        rememberSendOutcome: input.rememberSendOutcome,
        completionFence: input.completionFence,
        requireDeliveryReceipt:
          completedGeneration.quotaAccountingMode === "paid_credit_delivery_v1",
      });
      deliveryStatus = recoveredDelivery.deliveryStatus;
    } catch (error) {
      if (!isAmbiguousGenerationDeliveryFailure(error)) throw error;
      imageDeliveryAmbiguous = true;
      safeLog("messenger_generation_delivery_ambiguous_not_retried", {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        generationKind: input.resolvedGenerationKind,
      });
    }
  }
  if (imageDeliveryAmbiguous) {
    if (successNoticeStatus !== "sent") {
      await sendGenerationAmbiguousBalanceNotice({
        deps: input.deps,
        psid: input.psid,
        reqId: input.reqId,
        userId: input.userId,
        imageUrl: completedGeneration.imageUrl,
        lang: input.lang,
        rememberSendOutcome: input.rememberSendOutcome,
        quotaIdentity: recoveryQuotaIdentity,
        completionFence: input.completionFence,
      });
    }
    await setFlowState(input.psid, "IDLE");
    return true;
  }
  if (
    completedGeneration.quotaAccountingMode === "paid_credit_delivery_v1" &&
    deliveryStatus === "delivered"
  ) {
    await commitPaidCreditFromDeliveredCompletion({
      reqId: input.reqId,
      userId: input.userId,
      imageUrl: completedGeneration.imageUrl,
      completionFence: input.completionFence,
      paidCreditMode: completedGeneration.paidCreditMode,
    });
  }
  const shouldSendSuccessNotice = successNoticeStatus !== "sent";
  if (shouldSendSuccessNotice) {
    if (recoveryQuotaIdentity) {
      // A retry can happen after another successful photo or after the local
      // day rolled over. Never send the stale balance captured at commit time.
      quotaStatus = await refreshGenerationQuotaSnapshot({
        identity: recoveryQuotaIdentity,
        reqId: input.reqId,
        imageUrl: completedGeneration.imageUrl,
        userId: input.userId,
        completionFence: input.completionFence,
      });
    }
    await sendGenerationSuccessActions({
      deps: input.deps,
      psid: input.psid,
      reqId: input.reqId,
      lang: input.lang,
      rememberSendOutcome: input.rememberSendOutcome,
      quotaStatus,
    });
    await markMessengerGenerationSuccessNoticeSent(
      input.reqId,
      completedGeneration.imageUrl,
      input.userId,
      Date.now(),
      input.completionFence
    );
  }
  await setFlowState(input.psid, "IDLE");
  return true;
}

export async function commitPaidCreditFromDeliveredCompletion(input: {
  reqId: string;
  userId: string;
  imageUrl: string;
  completionFence?: MessengerGenerationCompletionFence;
  paidCreditMode?: "test" | "live";
}): Promise<void> {
  if (!input.completionFence || !input.paidCreditMode) {
    throw new MessengerImageQuotaRecoveryError();
  }
  const durable = await getMessengerGenerationCompletion(
    input.reqId,
    input.completionFence
  );
  if (
    !durable ||
    durable.reqId !== input.reqId ||
    durable.imageUrl !== input.imageUrl ||
    durable.userKey !== input.userId ||
    durable.deliveryStatus !== "delivered" ||
    durable.deliveryProof !== "meta_delivery_receipt_v1" ||
    !Number.isFinite(durable.receiptConfirmedAt) ||
    !/^[a-f0-9]{64}$/.test(durable.messengerMessageIdHash ?? "") ||
    durable.quotaAccountingMode !== "paid_credit_delivery_v1" ||
    durable.paidCreditMode !== input.paidCreditMode ||
    durable.workspaceId !== input.completionFence.workspaceId ||
    durable.channelConnectionId !== input.completionFence.channelConnectionId ||
    durable.bindingEpoch !== input.completionFence.bindingEpoch ||
    durable.privacyEpoch !== input.completionFence.privacyEpoch ||
    durable.pageId !== input.completionFence.pageId ||
    input.completionFence.channel !== "facebook_messenger" ||
    durable.channel !== "facebook_messenger"
  ) {
    throw new MessengerImageQuotaRecoveryError();
  }
  await commitDeliveredPaidCreditGeneration({
    workspaceId: input.completionFence.workspaceId,
    channelConnectionId: input.completionFence.channelConnectionId,
    bindingEpoch: input.completionFence.bindingEpoch,
    privacyEpoch: input.completionFence.privacyEpoch,
    userKey: input.userId,
    requestId: input.reqId,
    mode: input.paidCreditMode,
  });
}

function isLegacyQuotaGrandfatherAllowed(
  completion: MessengerGenerationCompletion
): boolean {
  if (completion.quotaAccountingMode === "legacy_pre_success_v1") {
    return true;
  }
  // Unversioned completions are only grandfathered after delivery: the image
  // has already left our control, so quota reconciliation may not retract it.
  // An unversioned pending image fails closed instead of becoming photo 6.
  return (
    completion.quotaAccountingMode === undefined &&
    (completion.deliveryStatus === "delivered" ||
      completion.deliveryStatus === undefined)
  );
}

async function reserveGenerationQuota(input: {
  psid: string;
  reqId: string;
  identity: MessengerImageQuotaIdentity;
}): Promise<FreeGenerationQuotaDecision> {
  const decision = await reserveMessengerGenerationQuota({
    psid: input.psid,
    identity: input.identity,
    requestId: input.reqId,
  });
  if (decision.status === "reserved") {
    return { status: "reserved", reservation: decision.reservation };
  }
  if (decision.status === "already_committed") {
    throw new MessengerImageQuotaRecoveryError();
  }
  if (decision.status === "busy") throw new MessengerImageQuotaBusyError();

  return { status: "exhausted", quotaStatus: decision.quotaStatus };
}

function paidCreditGenerationInputForJob(
  job: MessengerGenerationJob
): PaidCreditGenerationInput | null {
  const databaseIds = [
    job.workspaceId,
    job.channelConnectionId,
    job.bindingEpoch,
    job.privacyEpoch,
  ];
  if (
    databaseIds.some(
      value =>
        !Number.isSafeInteger(value) ||
        Number(value) < 1 ||
        Number(value) > CREDIT_GENERATION_MAX_DATABASE_ID
    ) ||
    !CREDIT_GENERATION_USER_KEY_PATTERN.test(job.userId) ||
    typeof job.reqId !== "string" ||
    job.reqId.length < 1 ||
    job.reqId.length > CREDIT_GENERATION_REQUEST_ID_MAX_LENGTH
  ) {
    return null;
  }
  return Object.freeze({
    workspaceId: job.workspaceId!,
    channelConnectionId: job.channelConnectionId!,
    bindingEpoch: job.bindingEpoch!,
    privacyEpoch: job.privacyEpoch!,
    // `webhookEventContext` already derives this once with `toUserKey(psid)`;
    // the durable generation job carries that canonical privacy key unchanged.
    userKey: job.userId,
    requestId: job.reqId,
  });
}

async function tryReserveCreditCheckout(
  input: PaidCreditGenerationInput
): Promise<ReservedMessengerCreditCheckout | null> {
  try {
    return await reserveMessengerCreditCheckout(input);
  } catch (error) {
    if (error instanceof CreditCheckoutReservationError) return null;
    throw error;
  }
}

async function sendFreeQuotaReachedNotice(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  quotaStatus: MessengerImageQuotaStatus;
}): Promise<void> {
  const response = buildFreeQuotaReachedResponse(
    input.lang,
    toConversationImageQuotaBalance(input.quotaStatus)
  );
  await sendQuotaOrCheckoutNotice({
    ...input,
    text: response.text ?? t(input.lang, "outOfFreeCredits"),
    actions: response.actions ?? [],
  });
}

async function sendCreditCheckoutNotice(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  quotaStatus: MessengerImageQuotaStatus;
  checkout: ReservedMessengerCreditCheckout;
}): Promise<void> {
  const quotaResponse = buildFreeQuotaReachedResponse(
    input.lang,
    toConversationImageQuotaBalance(input.quotaStatus)
  );
  const offerText =
    input.lang === "nl"
      ? "Koop eenmalig 9 premiumcredits voor € 5,00. Eén succesvol geleverde bruikbare premium afbeelding of bewerking verbruikt één credit. Credits vervallen niet. Geen abonnement of automatische verlenging. Of wacht tot je gratis tegoed opnieuw beschikbaar is."
      : "Buy 9 premium credits once for €5.00. One successfully delivered usable premium image or edit uses one credit. Credits never expire. No subscription or automatic renewal. Or wait until your free allowance is available again.";
  await sendQuotaOrCheckoutNotice({
    ...input,
    text: `${quotaResponse.text ?? t(input.lang, "outOfFreeCredits")}\n\n${offerText}`,
    actions: [
      {
        id: "buy_premium_image_credits",
        label: input.lang === "nl" ? "Koop 9 credits" : "Buy 9 credits",
        url: input.checkout.actionUrl,
      },
    ],
    // This is a transport-idempotency namespace, not an offer-copy version.
    // Keep it stable when catalog versions change so the same durable message
    // cannot send a second commercial CTA after a rolling deployment.
    providerAttemptKey: "premium-credit-checkout-offer-v1",
  });
}

async function sendQuotaOrCheckoutNotice(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  text: string;
  actions: Array<{
    id: string;
    label: string;
    inputText?: string;
    url?: string;
  }>;
  providerAttemptKey?: string;
}): Promise<void> {
  const outcome = input.providerAttemptKey
    ? await input.deps.sendLoggedActions(
        input.psid,
        input.text,
        input.actions,
        input.reqId,
        { providerAttemptKey: input.providerAttemptKey }
      )
    : await input.deps.sendLoggedActions(
        input.psid,
        input.text,
        input.actions,
        input.reqId
      );
  input.rememberSendOutcome(outcome);
  if (!outcome.sent) {
    throw new MessengerGenerationNoticeDeliveryError(
      new Error(`Messenger quota notice send skipped: ${outcome.reason}`)
    );
  }
  await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
}

async function handleGenerationSuccess(input: {
  deps: GenerationJobRunnerDeps;
  generationResult: Extract<
    Awaited<ReturnType<typeof executeGenerationFlow>>,
    { kind: "success" }
  >;
  promptHint?: string;
  psid: string;
  reqId: string;
  resolvedGenerationKind: GenerationKind;
  userId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  completionFence?: MessengerGenerationCompletionFence;
  successQuotaIdentity?: MessengerImageQuotaIdentity;
  quotaAccountingMode: MessengerGenerationQuotaAccountingMode;
  paidCreditMode?: "test" | "live";
  quotaReservation: MessengerImageQuotaReservation | null;
  quotaLeaseHeartbeat: MessengerGenerationQuotaLeaseHeartbeat | null;
  assertCurrentBinding: () => Promise<void>;
  commitDeliveredOutput?: () => Promise<void>;
  onDurableRecoveryRequired: () => void;
}): Promise<void> {
  const { imageUrl, metrics, mode, proof } = input.generationResult;
  safeLog("messenger_send_image_url", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.resolvedGenerationKind,
    imageLocation: summarizeSensitiveUrl(imageUrl),
  });
  safeLog("generation_summary", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    mode,
    generationKind: input.resolvedGenerationKind,
    ok: true,
    fb_image_fetch_ms: metrics.fbImageFetchMs ?? 0,
    prompt_build_ms: metrics.promptBuildMs ?? 0,
    openai_payload_build_ms: metrics.openAiPayloadBuildMs ?? 0,
    openai_ms: metrics.openAiMs ?? 0,
    openai_parse_ms: metrics.openAiParseMs ?? 0,
    upload_or_serve_ms: metrics.uploadOrServeMs ?? 0,
    total_ms: metrics.totalMs,
  });
  safeLog("proof_summary", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.resolvedGenerationKind,
    incomingLen: proof.incomingLen,
    incomingSha256: proof.incomingSha256,
    openaiInputLen: proof.openaiInputLen,
    openaiInputSha256: proof.openaiInputSha256,
    outputLocation: summarizeSensitiveUrl(imageUrl),
    totalMs: metrics.totalMs,
    ok: true,
  });

  if (input.successQuotaIdentity) {
    if (!input.quotaReservation || !input.quotaLeaseHeartbeat) {
      throw new MessengerQuotaReservationCommitError();
    }
    await input.quotaLeaseHeartbeat.stopAndAssertOwned();
  }

  input.onDurableRecoveryRequired();
  await Promise.resolve(
    markMessengerGenerationCompleted(
      input.reqId,
      imageUrl,
      input.userId,
      Date.now(),
      input.completionFence,
      input.quotaAccountingMode,
      input.successQuotaIdentity ?? null,
      input.paidCreditMode
    )
  );
  let quotaStatus: MessengerImageQuotaStatus | undefined;
  if (input.successQuotaIdentity) {
    const committed = await commitMessengerGenerationQuota({
      psid: input.psid,
      identity: input.successQuotaIdentity,
      reservation: input.quotaReservation!,
      generationKind: input.resolvedGenerationKind,
      assertCurrentBinding: input.assertCurrentBinding,
    });
    quotaStatus = committed.quotaStatus;
    await markMessengerGenerationQuotaCommitted(
      input.reqId,
      imageUrl,
      input.userId,
      quotaStatus,
      Date.now(),
      input.completionFence
    );
  }
  await setLastGenerated(input.psid, imageUrl);
  await setLastGenerationContext(input.psid, { prompt: input.promptHint });

  let delivery: Awaited<ReturnType<typeof deliverGenerationImage>>;
  try {
    delivery = await deliverGenerationImage({
      deps: input.deps,
      psid: input.psid,
      imageUrl,
      reqId: input.reqId,
      userId: input.userId,
      rememberSendOutcome: input.rememberSendOutcome,
      completionFence: input.completionFence,
      requireDeliveryReceipt: Boolean(input.commitDeliveredOutput),
    });
  } catch (error) {
    if (!isAmbiguousGenerationDeliveryFailure(error)) throw error;
    recordGenerationSuccess(input.resolvedGenerationKind, metrics.totalMs);
    await sendGenerationAmbiguousBalanceNotice({
      deps: input.deps,
      psid: input.psid,
      reqId: input.reqId,
      userId: input.userId,
      imageUrl,
      lang: input.lang,
      rememberSendOutcome: input.rememberSendOutcome,
      quotaIdentity: input.successQuotaIdentity,
      completionFence: input.completionFence,
    });
    emitGenerationDiagnostic(
      buildGenerationSuccessDiagnosticPayload({
        reqId: input.reqId,
        psid: input.psid,
        generationKind: input.resolvedGenerationKind,
        metrics,
        messengerSendMs: 0,
      })
    );
    await setFlowState(input.psid, "IDLE");
    return;
  }
  if (delivery.deliveryStatus === "delivered" && input.commitDeliveredOutput) {
    await commitPaidCreditFromDeliveredCompletion({
      reqId: input.reqId,
      userId: input.userId,
      imageUrl,
      completionFence: input.completionFence,
      paidCreditMode: input.paidCreditMode,
    });
  }
  recordGenerationSuccess(input.resolvedGenerationKind, metrics.totalMs);
  await sendGenerationSuccessActions({
    deps: input.deps,
    psid: input.psid,
    reqId: input.reqId,
    lang: input.lang,
    rememberSendOutcome: input.rememberSendOutcome,
    quotaStatus,
  });
  await markMessengerGenerationSuccessNoticeSent(
    input.reqId,
    imageUrl,
    input.userId,
    Date.now(),
    input.completionFence
  );
  emitGenerationDiagnostic(
    buildGenerationSuccessDiagnosticPayload({
      reqId: input.reqId,
      psid: input.psid,
      generationKind: input.resolvedGenerationKind,
      metrics,
      messengerSendMs: delivery.messengerSendMs,
    })
  );
  await setFlowState(input.psid, "IDLE");
}

async function deliverGenerationImage(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  imageUrl: string;
  reqId: string;
  userId: string;
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  completionFence?: MessengerGenerationCompletionFence;
  requireDeliveryReceipt: boolean;
}): Promise<{
  messengerSendMs: number;
  deliveryStatus: "receipt_pending" | "delivered";
}> {
  const messengerSendStartedAt = Date.now();
  const deliveryStart = await markMessengerGenerationDeliveryStarted(
    input.reqId,
    input.imageUrl,
    input.userId,
    Date.now(),
    input.completionFence
  );
  if (deliveryStart === "already_delivered") {
    return { messengerSendMs: 0, deliveryStatus: "delivered" };
  }
  if (deliveryStart === "receipt_pending") {
    return { messengerSendMs: 0, deliveryStatus: "receipt_pending" };
  }

  let outcome: MessengerSendOutcome;
  try {
    // The completion marker alone is not proof that Meta was contacted. The
    // durable DB provider fence inside sendLoggedImage is the final arbiter:
    // reserved work is CAS-recoverable, while started/ambiguous work is held.
    outcome = await input.deps.sendLoggedImage(
      input.psid,
      input.imageUrl,
      input.reqId
    );
  } catch (error) {
    if (!isMessengerDeliveryAmbiguous(error)) {
      try {
        await markMessengerGenerationDeliveryRetryable(
          input.reqId,
          input.imageUrl,
          input.userId,
          Date.now(),
          input.completionFence
        );
      } catch (markerError) {
        safeLog("messenger_generation_delivery_retry_marker_failed", {
          level: "error",
          reqId: input.reqId,
          user: toLogUser(input.userId),
          error: markerError,
        });
      }
    }
    throw new MessengerGenerationDeliveryError(error);
  }

  input.rememberSendOutcome(outcome);
  if (!outcome.sent) {
    try {
      await markMessengerGenerationDeliveryRetryable(
        input.reqId,
        input.imageUrl,
        input.userId,
        Date.now(),
        input.completionFence
      );
    } catch (markerError) {
      safeLog("messenger_generation_delivery_retry_marker_failed", {
        level: "error",
        reqId: input.reqId,
        user: toLogUser(input.userId),
        error: markerError,
      });
    }
    throw new MessengerGenerationDeliveryError(
      new Error(`Messenger image send skipped: ${outcome.reason}`)
    );
  }

  try {
    if (input.requireDeliveryReceipt) {
      if (!outcome.messageId || !input.completionFence) {
        throw markGenerationDeliveryAmbiguous(
          new Error("Messenger accepted image without a delivery message ID")
        );
      }
      const acceptance = await markMessengerGenerationDeliveryAccepted(
        input.reqId,
        input.imageUrl,
        outcome.messageId,
        input.userId,
        Date.now(),
        input.completionFence
      );
      return {
        messengerSendMs: Date.now() - messengerSendStartedAt,
        deliveryStatus: acceptance,
      };
    }
    await markMessengerGenerationDelivered(
      input.reqId,
      input.imageUrl,
      input.userId,
      Date.now(),
      input.completionFence
    );
  } catch (error) {
    safeLog("messenger_generation_delivery_marker_failed", {
      level: "error",
      reqId: input.reqId,
      user: toLogUser(input.userId),
      error,
    });
    throw new MessengerGenerationDeliveryError(
      input.requireDeliveryReceipt
        ? markGenerationDeliveryAmbiguous(error)
        : error
    );
  }
  return {
    messengerSendMs: Date.now() - messengerSendStartedAt,
    deliveryStatus: "delivered",
  };
}

function markGenerationDeliveryAmbiguous(error: unknown): Error {
  const ambiguous = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(ambiguous, "messengerDeliveryAmbiguous", {
    value: true,
  });
  return ambiguous;
}

function isMessengerDeliveryAmbiguous(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { messengerDeliveryAmbiguous?: boolean })
      .messengerDeliveryAmbiguous === true
  );
}

function isAmbiguousGenerationDeliveryFailure(error: unknown): boolean {
  return (
    error instanceof MessengerGenerationDeliveryError &&
    isMessengerDeliveryAmbiguous(error.cause)
  );
}

async function refreshGenerationQuotaSnapshot(input: {
  identity: MessengerImageQuotaIdentity;
  reqId: string;
  imageUrl: string;
  userId: string;
  completionFence?: MessengerGenerationCompletionFence;
}): Promise<MessengerImageQuotaStatus> {
  const quotaStatus = await getMessengerImageQuotaStatus(input.identity);
  await markMessengerGenerationQuotaCommitted(
    input.reqId,
    input.imageUrl,
    input.userId,
    quotaStatus,
    Date.now(),
    input.completionFence
  );
  return quotaStatus;
}

async function sendGenerationAmbiguousBalanceNotice(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  userId: string;
  imageUrl: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  quotaIdentity?: MessengerImageQuotaIdentity;
  completionFence?: MessengerGenerationCompletionFence;
}): Promise<void> {
  if (!input.quotaIdentity) {
    await markMessengerGenerationSuccessNoticeSent(
      input.reqId,
      input.imageUrl,
      input.userId,
      Date.now(),
      input.completionFence
    );
    return;
  }
  const quotaStatus = await refreshGenerationQuotaSnapshot({
    identity: input.quotaIdentity,
    reqId: input.reqId,
    imageUrl: input.imageUrl,
    userId: input.userId,
    completionFence: input.completionFence,
  });
  const response = buildImageQuotaBalanceResponse(
    input.lang,
    toConversationImageQuotaBalance(quotaStatus)
  );
  let outcome: MessengerSendOutcome;
  try {
    outcome = await input.deps.sendLoggedText(
      input.psid,
      response.text ?? "",
      input.reqId,
      { providerAttemptKey: "generation-ambiguous-balance-notice-v1" }
    );
  } catch (error) {
    // Meta offers no idempotency key. If transport may have started, settle
    // this logical notice so a replay cannot send a duplicate.
    if (isMessengerDeliveryAmbiguous(error)) {
      await markMessengerGenerationSuccessNoticeSent(
        input.reqId,
        input.imageUrl,
        input.userId,
        Date.now(),
        input.completionFence
      );
      return;
    }
    throw new MessengerGenerationNoticeDeliveryError(error);
  }
  input.rememberSendOutcome(outcome);
  if (!outcome.sent) {
    throw new MessengerGenerationNoticeDeliveryError(
      new Error(`Messenger balance notice send skipped: ${outcome.reason}`)
    );
  }
  await markMessengerGenerationSuccessNoticeSent(
    input.reqId,
    input.imageUrl,
    input.userId,
    Date.now(),
    input.completionFence
  );
}

function completionFenceForJob(
  job: MessengerGenerationJob
): MessengerGenerationCompletionFence | undefined {
  if (
    !job.workspaceId ||
    !job.channelConnectionId ||
    !job.bindingEpoch ||
    !job.privacyEpoch
  ) {
    if (process.env.NODE_ENV !== "production") return undefined;
    throw new MessengerPrivacyFenceError();
  }
  return {
    workspaceId: job.workspaceId,
    channelConnectionId: job.channelConnectionId,
    bindingEpoch: job.bindingEpoch,
    privacyEpoch: job.privacyEpoch,
    userKey: job.userId,
    pageId: job.pageId ?? "",
    channel: "facebook_messenger",
  };
}

function imageQuotaIdentityForJob(
  job: MessengerGenerationJob
): MessengerImageQuotaIdentity {
  if (
    job.workspaceId &&
    job.channelConnectionId &&
    job.bindingEpoch &&
    job.privacyEpoch
  ) {
    return {
      workspaceId: job.workspaceId,
      channelConnectionId: job.channelConnectionId,
      bindingEpoch: job.bindingEpoch,
      privacyEpoch: job.privacyEpoch,
      userKey: getUserKey(job.userId),
    };
  }
  if (process.env.NODE_ENV === "production") {
    throw new MessengerPrivacyFenceError();
  }
  return {
    workspaceId: 1,
    channelConnectionId: 1,
    bindingEpoch: 1,
    privacyEpoch: 1,
    userKey: getUserKey(job.userId),
  };
}

function quotaIdentityForCompletionRecovery(
  completion: MessengerGenerationCompletion,
  currentFreeIdentity: MessengerImageQuotaIdentity | undefined
): MessengerImageQuotaIdentity | undefined {
  if (completion.quotaAccountingMode === "startpilot_attempt_committed_v1") {
    return undefined;
  }
  if (!Object.hasOwn(completion, "quotaIdentity")) {
    return currentFreeIdentity;
  }
  const identity = completion.quotaIdentity;
  if (identity === null) return undefined;
  if (
    !identity ||
    !Number.isSafeInteger(identity.workspaceId) ||
    identity.workspaceId <= 0 ||
    !Number.isSafeInteger(identity.channelConnectionId) ||
    identity.channelConnectionId <= 0 ||
    !Number.isSafeInteger(identity.bindingEpoch) ||
    identity.bindingEpoch <= 0 ||
    !Number.isSafeInteger(identity.privacyEpoch) ||
    identity.privacyEpoch <= 0 ||
    !/^[a-f0-9]{64}$/i.test(identity.userKey) ||
    (completion.workspaceId !== undefined &&
      completion.workspaceId !== identity.workspaceId) ||
    (completion.channelConnectionId !== undefined &&
      completion.channelConnectionId !== identity.channelConnectionId) ||
    (completion.bindingEpoch !== undefined &&
      completion.bindingEpoch !== identity.bindingEpoch) ||
    (completion.privacyEpoch !== undefined &&
      completion.privacyEpoch !== identity.privacyEpoch) ||
    (completion.userKey !== undefined &&
      getUserKey(completion.userKey) !== identity.userKey)
  ) {
    throw new MessengerImageQuotaRecoveryError();
  }
  return identity;
}

function startpilotImageUsageIdempotencyKey(
  job: Pick<MessengerGenerationJob, "reqId" | "userId" | "privacyEpoch">
): string {
  return `startpilot-image:${createHash("sha256")
    .update("leaderbot-startpilot-image-v2\n")
    .update(job.userId)
    .update("\0")
    .update(String(job.privacyEpoch ?? 0))
    .update("\0")
    .update(job.reqId)
    .digest("hex")}`;
}

async function sendGenerationSuccessActions(input: {
  deps: GenerationJobRunnerDeps;
  psid: string;
  reqId: string;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
  quotaStatus?: MessengerImageQuotaStatus;
}): Promise<void> {
  const successResponse = buildGenerationSuccessResponse(
    input.lang,
    input.quotaStatus
      ? toConversationImageQuotaBalance(input.quotaStatus)
      : undefined
  );
  let outcome: MessengerSendOutcome;
  try {
    outcome = await input.deps.sendLoggedActions(
      input.psid,
      successResponse.text ?? "",
      successResponse.actions ?? [],
      input.reqId,
      { providerAttemptKey: "generation-success-notice-v1" }
    );
  } catch (error) {
    if (isMessengerDeliveryAmbiguous(error)) {
      // The durable provider fence prevents a second Meta call. Treat this
      // notice as settled; exactly-once acknowledgement is not available.
      return;
    }
    throw new MessengerGenerationNoticeDeliveryError(error);
  }
  input.rememberSendOutcome(outcome);
  if (!outcome.sent) {
    throw new MessengerGenerationNoticeDeliveryError(
      new Error(`Messenger success notice send skipped: ${outcome.reason}`)
    );
  }
}

async function handleGenerationFailure(input: {
  deps: GenerationJobRunnerDeps;
  generationResult: Extract<
    Awaited<ReturnType<typeof executeGenerationFlow>>,
    { kind: "error" }
  >;
  psid: string;
  reqId: string;
  resolvedGenerationKind: GenerationKind;
  lang: MessengerGenerationJob["lang"];
  rememberSendOutcome: (outcome: MessengerSendOutcome) => MessengerSendOutcome;
}): Promise<void> {
  const error = input.generationResult.error;
  safeLog("openai_call_error", {
    level: "error",
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    error,
  });

  const errorClass =
    error instanceof Error ? error.constructor.name : "UnknownError";
  const metrics = input.generationResult.metrics ??
    getGenerationMetrics(error) ?? { totalMs: 0 };

  safeLog("proof_summary", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    generationKind: input.resolvedGenerationKind,
    ok: false,
    errorCode: errorClass,
    totalMs: metrics.totalMs,
  });
  emitGenerationDiagnostic(
    buildGenerationFailureDiagnosticPayload({
      reqId: input.reqId,
      psid: input.psid,
      generationKind: input.resolvedGenerationKind,
      metrics,
      failureReason: input.generationResult.errorKind,
    })
  );
  recordGenerationError();

  const failure = getGenerationFailureMessage(
    input.generationResult.errorKind,
    input.lang
  );
  if (failure.handled) {
    input.rememberSendOutcome(
      await input.deps.sendLoggedText(input.psid, failure.text, input.reqId)
    );
    await setFlowState(input.psid, failure.nextState);
    return;
  }

  if (failure.sendGenericFailureLead) {
    input.rememberSendOutcome(
      await input.deps.sendLoggedText(
        input.psid,
        t(input.lang, "failure"),
        input.reqId
      )
    );
  }
  await setFlowState(input.psid, "FAILURE");

  const failureResponse = buildGenerationFailureResponse(
    input.lang,
    failure.failureText
  );
  input.rememberSendOutcome(
    await input.deps.sendLoggedActions(
      input.psid,
      failureResponse.text ?? "",
      failureResponse.actions ?? [],
      input.reqId
    )
  );
}
