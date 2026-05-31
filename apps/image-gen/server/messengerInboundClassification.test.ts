import { describe, expect, it } from "vitest";
import { classifyInboundEvent } from "./_core/messengerInboundClassification";
import type { FacebookWebhookEvent } from "./_core/webhookHelpers";

describe("messenger inbound classification", () => {
  it("recognizes channel-neutral conversation action payloads", () => {
    const event: FacebookWebhookEvent = {
      sender: { id: "psid-1" },
      message: {
        quick_reply: { payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding" },
      },
    };

    expect(classifyInboundEvent(event)).toEqual({
      isInboundUserEvent: true,
      eventPayload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
      isIntentionalSilentAck: false,
      isIntentionalSilentUnknownPayload: false,
    });
  });

  it.each([
    "CHOOSE_STYLE",
    "STYLE_DISCO",
    "STYLE_CATEGORY_ILLUSTRATED",
    "RETRY_STYLE_gold",
    "PRIVACY_INFO",
    "WHAT_IS_THIS",
  ])("does not preserve legacy Messenger quick-reply payload %s", payload => {
    const event: FacebookWebhookEvent = {
      sender: { id: "psid-legacy" },
      postback: { payload },
    };

    expect(classifyInboundEvent(event)).toEqual({
      isInboundUserEvent: true,
      eventPayload: payload,
      isIntentionalSilentAck: false,
      isIntentionalSilentUnknownPayload: true,
    });
  });
});
