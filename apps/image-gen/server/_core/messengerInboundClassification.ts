import {
  FACE_MEMORY_CONSENT_NO,
  FACE_MEMORY_CONSENT_YES,
} from "./faceMemory";
import {
  detectAck,
  type FacebookWebhookEvent,
} from "./webhookHelpers";
import { decodeMessengerActionInput } from "./messengerActionPayload";

export type InboundEventClassification = {
  isInboundUserEvent: boolean;
  eventPayload: string | undefined;
  isIntentionalSilentAck: boolean;
  isIntentionalSilentUnknownPayload: boolean;
};

function isKnownMessengerPayload(payload: string | undefined): boolean {
  if (!payload) {
    return false;
  }

  return Boolean(
      payload === FACE_MEMORY_CONSENT_YES ||
      payload === FACE_MEMORY_CONSENT_NO ||
      Boolean(decodeMessengerActionInput(payload))
  );
}

export function classifyInboundEvent(
  event: FacebookWebhookEvent
): InboundEventClassification {
  const isInboundUserEvent = Boolean(
    event.postback || (event.message && !event.message.is_echo)
  );
  const isIntentionalSilentAck = Boolean(detectAck(event.message?.text));
  const eventPayload = event.message?.quick_reply?.payload ?? event.postback?.payload;
  const isIntentionalSilentUnknownPayload = Boolean(
    eventPayload && !isKnownMessengerPayload(eventPayload)
  );

  return {
    isInboundUserEvent,
    eventPayload,
    isIntentionalSilentAck,
    isIntentionalSilentUnknownPayload,
  };
}
