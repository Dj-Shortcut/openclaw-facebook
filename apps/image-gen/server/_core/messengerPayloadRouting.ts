import type { BotPayloadContext } from "./botContext";
import type { Lang } from "./i18n";
import type { MessengerUserState } from "./messengerState";
import type { Style, StyleCategory } from "./messengerStyles";
import {
  normalizeStyle,
  parseStyle,
  styleCategoryPayloadToCategory,
  stylePayloadToStyle,
} from "./webhookHelpers";

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
  runStyleGeneration: (
    psid: string,
    userId: string,
    style: Style,
    reqId: string,
    lang: Lang
  ) => Promise<void>;
  handleStyleSelection: (
    psid: string,
    userId: string,
    style: Style,
    reqId: string,
    lang: Lang
  ) => Promise<void>;
  showStylePicker: (psid: string, lang: Lang, reqId: string) => Promise<void>;
  showStyleCategory: (
    psid: string,
    category: StyleCategory,
    lang: Lang,
    reqId: string
  ) => Promise<void>;
  sendFlowExplanation: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<void>;
  sendPrivacyInfo: (psid: string, lang: Lang, reqId: string) => Promise<void>;
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

async function tryHandleRetryPayload(
  input: MessengerPayloadRoutingInput
): Promise<boolean> {
  if (input.payload.startsWith("RETRY_STYLE_")) {
    const retryStyle = normalizeStyle(
      input.payload.slice("RETRY_STYLE_".length)
    );
    if (retryStyle) {
      await input.runStyleGeneration(
        input.psid,
        input.userId,
        retryStyle,
        input.reqId,
        input.lang
      );
      return true;
    }
  }

  if (input.payload !== "RETRY_STYLE") {
    return false;
  }

  const chosenStyle = (await input.getState(input.psid)).selectedStyle;
  const retryStyle = chosenStyle ? parseStyle(chosenStyle) : undefined;
  if (retryStyle) {
    await input.handleStyleSelection(
      input.psid,
      input.userId,
      retryStyle,
      input.reqId,
      input.lang
    );
    return true;
  }

  await input.showStylePicker(input.psid, input.lang, input.reqId);
  return true;
}

async function tryHandleStylePayload(
  input: MessengerPayloadRoutingInput
): Promise<boolean> {
  const selectedStyle = stylePayloadToStyle(input.payload);
  if (selectedStyle) {
    await input.handleStyleSelection(
      input.psid,
      input.userId,
      selectedStyle,
      input.reqId,
      input.lang
    );
    return true;
  }

  const selectedCategory = styleCategoryPayloadToCategory(input.payload);
  if (!selectedCategory) {
    return false;
  }

  await input.showStyleCategory(
    input.psid,
    selectedCategory,
    input.lang,
    input.reqId
  );
  return true;
}

async function tryHandleUtilityPayload(
  input: MessengerPayloadRoutingInput
): Promise<boolean> {
  switch (input.payload) {
    case "CHOOSE_STYLE":
      await input.showStylePicker(input.psid, input.lang, input.reqId);
      return true;
    case "WHAT_IS_THIS":
      await input.sendFlowExplanation(input.psid, input.lang, input.reqId);
      return true;
    case "PRIVACY_INFO":
      await input.sendPrivacyInfo(input.psid, input.lang, input.reqId);
      return true;
    default:
      return false;
  }
}

export async function handleMessengerPayload(
  input: MessengerPayloadRoutingInput
): Promise<void> {
  if (await input.maybeSendInFlightMessage(input.psid, input.reqId)) {
    return;
  }

  const state = await input.getState(input.psid);
  if (
    (await tryHandleFeaturePayload(input, state)) ||
    (await tryHandleRetryPayload(input)) ||
    (await tryHandleStylePayload(input)) ||
    (await tryHandleUtilityPayload(input))
  ) {
    return;
  }

  input.sendUnknownPayloadLog(input.userId);
}
