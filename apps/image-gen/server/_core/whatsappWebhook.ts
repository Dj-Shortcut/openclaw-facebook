import { createHash } from "node:crypto";
import { normalizeLang, t } from "./i18n";
import { getOrCreateState, setLastUserMessageAt } from "./messengerState";
import { toLogUser } from "./privacy";
import {
  deleteUserDataAndSendResult,
  handleWhatsAppConsentGate,
  isDeleteCommand,
  isWhatsAppPrivacyOrConsentControl,
} from "./consentService";
import { GDPR_DELETE_CONFIRM } from "./consentActionIds";
import {
  extractWhatsAppEvents,
  logWhatsAppWebhookPayload,
} from "./inbound/whatsappInbound";
import { handleWhatsAppImageEvent } from "./whatsappHandlers/imageHandler";
import { handleWhatsAppAudioEvent } from "./whatsappHandlers/audioHandler";
import { handleWhatsAppInteractiveEvent } from "./whatsappHandlers/interactiveHandler";
import { handleWhatsAppTextEvent } from "./whatsappHandlers/textHandler";
import {
  hasAmbiguousWhatsAppTransportOutcome,
  hasPreTransportWhatsAppTransportOutcome,
} from "../whatsappTransportBoundary";
import {
  sendWhatsAppErasureControlTextReply,
  sendWhatsAppButtonsReply,
  sendWhatsAppTextReply,
} from "./whatsappResponseService";
import {
  claimWhatsAppWebhookReplayLease,
  completeWhatsAppWebhookReplayLease,
  markWhatsAppWebhookEffectsStarted,
  markWhatsAppWebhookFallbackPending,
  releaseWhatsAppWebhookReplayLease,
  runWithWhatsAppWebhookReplayLeaseHeartbeat,
  type WhatsAppWebhookReplayLease,
} from "./webhookReplayProtection";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";
import type { WhatsAppHandlerContext } from "./whatsappTypes";
import type { CostLedgerTenantScope } from "./costLedger";
import {
  admitWhatsAppGenerationScope,
  assertWhatsAppGenerationScopeActive,
  resolveWhatsAppGenerationOwnership,
  WhatsAppGenerationScopeError,
  type WhatsAppGenerationOwnership,
} from "./whatsappGenerationScope";
import {
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestErasurePrivacySubject,
  setMessengerRequestOperationId,
  setMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import {
  getErasingMessengerPrivacySubject,
  type MessengerErasingPrivacySubject,
} from "./messengerPrivacySubject";
import { safeLog } from "./logger";

const DEFAULT_LANG = normalizeLang(process.env.DEFAULT_MESSENGER_LANG);

type WhatsAppEventContext = WhatsAppHandlerContext &
  Readonly<{
    erasure?: MessengerErasingPrivacySubject;
    replayLease: WhatsAppWebhookReplayLease;
  }>;

function normalizeWhatsAppEvents(payload: unknown): NormalizedWhatsAppEvent[] {
  return extractWhatsAppEvents(payload).filter(
    (event): event is NormalizedWhatsAppEvent => event.channel === "whatsapp"
  );
}

function getStableWhatsAppEventId(event: NormalizedWhatsAppEvent): string {
  return (
    event.messageId?.trim() ||
    createHash("sha256")
      .update(
        [
          event.senderId,
          event.timestamp ?? "no-ts",
          event.rawMessageType ?? "unknown",
          event.imageId ?? event.audioId ?? event.textBody ?? "no-body",
        ].join(":"),
        "utf8"
      )
      .digest("hex")
  );
}

function createNonReversibleReqId(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership
): string {
  return createHash("sha256")
    .update("whatsapp:req:v2", "utf8")
    .update("\0")
    .update(String(ownership.workspaceId))
    .update("\0")
    .update(String(ownership.channelConnectionId))
    .update("\0")
    .update(String(ownership.bindingEpoch))
    .update("\0")
    .update(ownership.userKey)
    .update("\0")
    .update(getStableWhatsAppEventId(event))
    .digest("hex");
}

function parseWhatsAppEventOccurredAt(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WhatsAppGenerationScopeError();
  }
  const eventOccurredAt = new Date(value);
  if (!Number.isSafeInteger(eventOccurredAt.getTime())) {
    throw new WhatsAppGenerationScopeError();
  }
  return eventOccurredAt;
}

async function createWhatsAppEventContext(
  event: NormalizedWhatsAppEvent,
  privacyOrConsentControl: boolean,
  deletionRetryControl: boolean,
  expectedScope?: CostLedgerTenantScope,
  expectedErasure?: MessengerErasingPrivacySubject
): Promise<WhatsAppEventContext | null> {
  const ownership = await resolveWhatsAppGenerationOwnership({
    endpoint: event.endpoint,
    senderId: event.senderId,
    userKey: event.userId,
  });
  if (
    expectedScope &&
    (expectedScope.workspaceId !== ownership.workspaceId ||
      expectedScope.channelConnectionId !== ownership.channelConnectionId ||
      expectedScope.bindingEpoch !== ownership.bindingEpoch ||
      expectedScope.userKey !== ownership.userKey)
  ) {
    throw new WhatsAppGenerationScopeError();
  }
  if (deletionRetryControl) {
    const activeErasure = await getErasingMessengerPrivacySubject(ownership);
    if (
      activeErasure &&
      expectedErasure &&
      (activeErasure.privacyEpoch !== expectedErasure.privacyEpoch ||
        activeErasure.dataPrivacyEpoch !== expectedErasure.dataPrivacyEpoch)
    ) {
      throw new WhatsAppGenerationScopeError();
    }
    // A durable erasure-control delivery keeps its immutable erasure epoch
    // after deletion has committed and the subject has become `erased`. That
    // stored scope is the only retry authority for the outcome reply.
    const erasure = activeErasure ?? expectedErasure;
    if (erasure) {
      if (
        expectedScope &&
        expectedScope.privacyEpoch !== erasure.privacyEpoch
      ) {
        throw new WhatsAppGenerationScopeError();
      }
      const replayLease = await claimWhatsAppEventReplayOrLog(event, ownership);
      if (!replayLease) {
        return null;
      }
      return Object.freeze({
        reqId: createNonReversibleReqId(event, ownership),
        lang: DEFAULT_LANG,
        costLedgerScope: Object.freeze({
          ...ownership,
          privacyEpoch: erasure.privacyEpoch,
        }),
        erasure,
        replayLease,
      });
    }
  }
  let costLedgerScope: CostLedgerTenantScope;
  if (expectedScope) {
    await assertWhatsAppGenerationScopeActive({
      endpoint: event.endpoint,
      scope: expectedScope,
    });
    costLedgerScope = expectedScope;
  } else {
    costLedgerScope = await admitWhatsAppGenerationScope({
      endpoint: event.endpoint,
      ownership,
      eventOccurredAt: parseWhatsAppEventOccurredAt(event.timestamp),
      allowReactivation: !privacyOrConsentControl,
      allowCreation: true,
    });
  }
  const replayLease = await claimWhatsAppEventReplayOrLog(event, ownership);
  if (!replayLease) {
    return null;
  }
  return Object.freeze({
    reqId: createNonReversibleReqId(event, ownership),
    lang: DEFAULT_LANG,
    costLedgerScope,
    replayLease,
  });
}

async function sendUnsupportedMessageReply(
  event: NormalizedWhatsAppEvent,
  lang: typeof DEFAULT_LANG,
  operationId: string
): Promise<void> {
  safeLog("whatsapp_unsupported_inbound_message_type", {
    level: "warn",
    user: toLogUser(event.userId),
    rawMessageType: event.rawMessageType,
  });
  await sendWhatsAppTextReply(
    event.senderId,
    t(lang, "unsupportedMedia"),
    operationId,
    "unsupported-media"
  );
}

async function dispatchWhatsAppEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  if (event.messageType === "image") {
    await handleWhatsAppImageEvent(event, context);
    return;
  }

  if (event.messageType === "audio") {
    await handleWhatsAppAudioEvent(event, context);
    return;
  }

  if (event.audioId) {
    await handleWhatsAppAudioEvent(event, context);
    return;
  }

  if (event.rawMessageType === "interactive") {
    await handleWhatsAppInteractiveEvent(event, context);
    return;
  }

  if (event.messageType === "text") {
    await handleWhatsAppTextEvent(event, context);
    return;
  }

  if (event.messageType === "unknown") {
    await sendUnsupportedMessageReply(event, context.lang, context.reqId);
    return;
  }

  safeLog("whatsapp_no_handler_for_inbound_event", {
    level: "warn",
    user: toLogUser(event.userId),
    messageType: event.messageType,
    rawMessageType: event.rawMessageType,
  });
}

async function processSingleWhatsAppEvent(
  event: NormalizedWhatsAppEvent,
  expectedScope?: CostLedgerTenantScope,
  expectedErasure?: MessengerErasingPrivacySubject
): Promise<void> {
  const privacyOrConsentControl = isWhatsAppPrivacyOrConsentControl(event);
  const interactiveReplyId =
    typeof event.rawEventMeta?.interactiveReplyId === "string"
      ? event.rawEventMeta.interactiveReplyId
      : undefined;
  const deletionRetryControl =
    interactiveReplyId === GDPR_DELETE_CONFIRM ||
    isDeleteCommand(event.textBody) ||
    isDeleteCommand(interactiveReplyId);
  const context = await createWhatsAppEventContext(
    event,
    privacyOrConsentControl,
    deletionRetryControl,
    expectedScope,
    expectedErasure
  );
  if (!context) {
    return;
  }
  let effectsMayHaveStarted = false;
  let fallbackRetryPending = false;
  try {
    await runWithWhatsAppWebhookReplayLeaseHeartbeat(context.replayLease, () =>
      runWithMessengerRequestContext(
        event.endpoint.phoneNumberId,
        async () => {
          setMessengerRequestOperationId(context.reqId);
          if (context.erasure) {
            setMessengerRequestErasurePrivacySubject({
              userKey: context.costLedgerScope.userKey,
              ...context.erasure,
            });
            effectsMayHaveStarted = true;
            await deleteUserDataAndSendResult(
              event.senderId,
              context.lang,
              text =>
                runWithMessengerErasureControlDelivery(() =>
                  sendWhatsAppErasureControlTextReply(
                    event.senderId,
                    text,
                    context.reqId
                  )
                )
            );
            return;
          }
          setMessengerRequestPrivacySubject({
            userKey: event.userId,
            privacyEpoch: context.costLedgerScope.privacyEpoch,
          });
          if (context.replayLease.mode === "fallback") {
            effectsMayHaveStarted = true;
            await sendWhatsAppTextReply(
              event.senderId,
              t(context.lang, "errorFallback"),
              context.reqId,
              "error-fallback"
            );
            return;
          }
          // This transition is deliberately outside the handler catch. If it
          // cannot be durably recorded, no ordinary effect or fallback may run
          // and the event owner can be released for a safe full retry.
          await markWhatsAppWebhookEffectsStarted(context.replayLease);
          effectsMayHaveStarted = true;
          try {
            const state = await Promise.resolve(
              getOrCreateState(event.senderId)
            );

            safeLog("whatsapp_normalized_inbound_event", {
              channel: event.channel,
              user: toLogUser(event.userId),
              messageType: event.messageType,
              rawMessageType: event.rawMessageType,
            });

            if (
              await handleWhatsAppConsentGate({
                event,
                lang: context.lang,
                state,
                sendText: text =>
                  sendWhatsAppTextReply(
                    event.senderId,
                    text,
                    context.reqId,
                    "consent-text"
                  ),
                sendDeletionOutcome: text =>
                  runWithMessengerErasureControlDelivery(() =>
                    sendWhatsAppErasureControlTextReply(
                      event.senderId,
                      text,
                      context.reqId
                    )
                  ),
                sendButtons: (text, options) =>
                  sendWhatsAppButtonsReply(
                    event.senderId,
                    text,
                    options,
                    context.reqId,
                    "consent-buttons"
                  ),
              })
            ) {
              return;
            }

            // Consent and deletion controls may be answered, but must never open
            // the paid handoff/recovery window.
            if (privacyOrConsentControl) {
              return;
            }
            await Promise.resolve(
              setLastUserMessageAt(
                event.senderId,
                event.timestamp ?? Date.now()
              )
            );

            await dispatchWhatsAppEvent(event, context);
          } catch (error) {
            if (error instanceof WhatsAppGenerationScopeError) {
              throw error;
            }
            if (hasAmbiguousWhatsAppTransportOutcome(error)) {
              throw error;
            }
            safeLog("whatsapp_reply_failed", {
              level: "error",
              user: toLogUser(event.userId),
              error: error instanceof Error ? error.name : "unknown_error",
            });
            try {
              await sendWhatsAppTextReply(
                event.senderId,
                t(context.lang, "errorFallback"),
                context.reqId,
                "error-fallback"
              );
            } catch (fallbackError) {
              fallbackRetryPending =
                hasPreTransportWhatsAppTransportOutcome(fallbackError);
              throw new AggregateError(
                [error, fallbackError],
                "WhatsApp handler and fallback delivery failed",
                { cause: error }
              );
            }
          }
        },
        {
          channel: "whatsapp",
          workspaceId: context.costLedgerScope.workspaceId,
          channelConnectionId: context.costLedgerScope.channelConnectionId,
          bindingEpoch: context.costLedgerScope.bindingEpoch,
        }
      )
    );
  } catch (error) {
    if (context.replayLease.mode === "fallback") {
      try {
        if (hasPreTransportWhatsAppTransportOutcome(error)) {
          await releaseWhatsAppWebhookReplayLease(context.replayLease);
        } else {
          await completeWhatsAppWebhookReplayLease(context.replayLease);
        }
      } catch (replayError) {
        throw new AggregateError(
          [error, replayError],
          "WhatsApp fallback replay transition failed",
          { cause: error }
        );
      }
      throw error;
    }

    if (fallbackRetryPending && effectsMayHaveStarted) {
      try {
        // Atomically keep the durable fallback phase and release the event
        // owner so the next ingress attempt can immediately claim fallback.
        await markWhatsAppWebhookFallbackPending(context.replayLease);
      } catch (transitionError) {
        throw new AggregateError(
          [error, transitionError],
          "WhatsApp fallback replay release failed",
          { cause: error }
        );
      }
      throw error;
    }

    if (!effectsMayHaveStarted) {
      try {
        await releaseWhatsAppWebhookReplayLease(context.replayLease);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "WhatsApp replay lease release failed",
          { cause: error }
        );
      }
      throw error;
    }

    try {
      await completeWhatsAppWebhookReplayLease(context.replayLease);
    } catch (completionError) {
      throw new AggregateError(
        [error, completionError],
        "WhatsApp replay lease completion failed",
        { cause: error }
      );
    }
    throw error;
  }

  await completeWhatsAppWebhookReplayLease(context.replayLease);
}

function getWhatsAppEventReplayKey(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership
): string {
  const scopeDigest = createHash("sha256")
    .update(String(ownership.workspaceId))
    .update("\0")
    .update(String(ownership.channelConnectionId))
    .update("\0")
    .update(String(ownership.bindingEpoch))
    .update("\0")
    .update(ownership.userKey)
    .digest("hex");
  const eventDigest = createHash("sha256")
    .update(getStableWhatsAppEventId(event))
    .digest("hex");
  return `whatsapp:v2:${scopeDigest}:${eventDigest}`;
}

async function claimWhatsAppEventReplayOrLog(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership
): Promise<WhatsAppWebhookReplayLease | null> {
  const replayKey = getWhatsAppEventReplayKey(event, ownership);
  const claim = await claimWhatsAppWebhookReplayLease(replayKey);
  if (claim.status === "acquired") {
    return claim.lease;
  }

  safeLog("whatsapp_replay_ignored", {
    user: toLogUser(event.userId),
  });
  return null;
}

async function safelyProcessSingleWhatsAppEvent(
  event: NormalizedWhatsAppEvent,
  expectedScope?: CostLedgerTenantScope,
  expectedErasure?: MessengerErasingPrivacySubject
): Promise<void> {
  try {
    await processSingleWhatsAppEvent(event, expectedScope, expectedErasure);
  } catch (error) {
    safeLog("whatsapp_reply_failed", {
      level: "error",
      user: toLogUser(event.userId),
      error: error instanceof Error ? error.name : "unknown_error",
    });
    if (error instanceof WhatsAppGenerationScopeError) {
      if (!error.retryable) {
        return;
      }
    }
    // No immutable tenant context exists here. Let the durable ingress queue
    // retry infrastructure/replay-store failures instead of attempting a
    // contextless Graph send or permanently consuming the delivery.
    throw error;
  }
}

export async function processWhatsAppWebhookPayload(
  payload: unknown,
  options: {
    expectedScope?: CostLedgerTenantScope;
    expectedErasure?: MessengerErasingPrivacySubject;
  } = {}
): Promise<void> {
  logWhatsAppWebhookPayload(payload);

  const events = normalizeWhatsAppEvents(payload);
  if (events.length === 0) {
    safeLog("whatsapp_no_inbound_messages_found");
    return;
  }

  for (const event of events) {
    await safelyProcessSingleWhatsAppEvent(
      event,
      options.expectedScope,
      options.expectedErasure
    );
  }
}
