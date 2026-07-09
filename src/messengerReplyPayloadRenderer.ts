import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  renderMessengerActionPayload,
  renderMessengerInferredChoicePayload,
} from "./messengerActionPayloadRenderer.js";
import { renderMessengerPresentationPayload } from "./messengerPresentationRenderer.js";
import type { MessengerPresentationPayload } from "./messengerPresentationTypes.js";

export function renderMessengerReplyPayload(payload: ReplyPayload): MessengerPresentationPayload {
  const actionPayload = renderMessengerActionPayload(payload as MessengerPresentationPayload);
  if (actionPayload) {
    return actionPayload;
  }

  if (payload.presentation) {
    return renderMessengerPresentationPayload({
      payload,
      presentation: payload.presentation,
    }) ?? payload;
  }

  return renderMessengerInferredChoicePayload(payload as MessengerPresentationPayload) ?? payload;
}
