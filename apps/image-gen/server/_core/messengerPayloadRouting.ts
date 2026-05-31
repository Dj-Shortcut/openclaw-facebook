import type { BotPayloadContext } from "./botContext";
import type { Lang } from "./i18n";
import type { MessengerUserState } from "./messengerState";

type PayloadFeature = {
  onPayload?: (
    context: BotPayloadContext
  ) => Promise<{ handled?: boolean } | void> | { handled?: boolean } | void;
};

type MessengerPayloadRoutingInput = {
  psid: string;
  userId: string;
  payload: string;
  reqId: string;
  lang: Lang;
  maybeSendInFlightMessage: (psid: string, reqId: string) => Promise<boolean>;
  getState: (psid: string) => Promise<MessengerUserState>;
  getFeatures: () => readonly PayloadFeature[];
  createFeaturePayloadContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerUserState,
    payload: string
  ) => BotPayloadContext;
  sendUnknownPayloadLog: (userId: string) => void;
};

async function tryHandleFeaturePayload(
  input: MessengerPayloadRoutingInput,
  state: MessengerUserState
): Promise<boolean> {
  for (const feature of input.getFeatures()) {
    const result = await feature.onPayload?.(
      input.createFeaturePayloadContext(
        input.psid,
        input.userId,
        input.reqId,
        input.lang,
        state,
        input.payload
      )
    );
    if (result?.handled) {
      return true;
    }
  }

  return false;
}

export async function handleMessengerPayload(
  input: MessengerPayloadRoutingInput
): Promise<void> {
  if (await input.maybeSendInFlightMessage(input.psid, input.reqId)) {
    return;
  }

  const state = await input.getState(input.psid);
  if (await tryHandleFeaturePayload(input, state)) {
    return;
  }

  input.sendUnknownPayloadLog(input.userId);
}
