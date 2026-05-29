import { safeLog, type MessengerSendOutcome } from "./messengerApi";
import { t, type Lang } from "./i18n";

export const MESSENGER_SEND_SKIPPED: MessengerSendOutcome = {
  sent: false,
  reason: "response_window_closed",
};

export const MESSENGER_ASYNC_RESPONSE_QUEUED: MessengerSendOutcome = {
  sent: true,
};

export type MaybeInFlightMessageResult =
  | { handled: false }
  | { handled: true; outcome?: MessengerSendOutcome };

export function combineMessengerSendOutcomes(
  ...outcomes: MessengerSendOutcome[]
): MessengerSendOutcome {
  return outcomes.some(outcome => outcome.sent)
    ? { sent: true }
    : MESSENGER_SEND_SKIPPED;
}

export function createResponseSentTracker() {
  let responseSent = false;

  return {
    responseSent: () => responseSent,
    markResponseSentFromOutcome: (
      outcome: MessengerSendOutcome | undefined
    ) => {
      if (outcome?.sent) {
        responseSent = true;
      }
    },
  };
}

export function logMessengerWebhookTrace(
  stage:
    | "webhook_received"
    | "selected_branch"
    | "before_send"
    | "after_send"
    | "top_level_catch",
  details: Record<string, unknown>
): void {
  safeLog("messenger_response_window_trace", { stage, ...details });
}

export async function sendFallbackTextIfNeeded(input: {
  isInboundUserEvent: boolean;
  isIntentionalSilentAck: boolean;
  isIntentionalSilentUnknownPayload: boolean;
  responseSent: () => boolean;
  sendLoggedText: (
    psid: string,
    text: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  psid: string;
  lang: Lang;
  reqId: string;
}): Promise<void> {
  if (
    input.isInboundUserEvent &&
    !input.isIntentionalSilentAck &&
    !input.isIntentionalSilentUnknownPayload &&
    !input.responseSent()
  ) {
    await input.sendLoggedText(
      input.psid,
      t(input.lang, "failure"),
      input.reqId
    );
  }
}
