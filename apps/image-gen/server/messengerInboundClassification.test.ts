import { describe, expect, it, vi } from "vitest";
import { classifyInboundEvent } from "./_core/messengerInboundClassification";
import { sendFallbackTextIfNeeded } from "./_core/webhookFallback";
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

  it.each([
    "GDPR_CONSENT_AGREE",
    "GDPR_CONSENT_DECLINE",
    "GDPR_DELETE_CONFIRM",
    "GDPR_DELETE_CANCEL",
  ])("recognizes GDPR postback payload %s", payload => {
    const event: FacebookWebhookEvent = {
      sender: { id: "psid-gdpr" },
      postback: { payload },
    };

    expect(classifyInboundEvent(event)).toEqual({
      isInboundUserEvent: true,
      eventPayload: payload,
      isIntentionalSilentAck: false,
      isIntentionalSilentUnknownPayload: false,
    });
  });

  it("keeps the failure fallback eligible for a GDPR postback", async () => {
    const classification = classifyInboundEvent({
      sender: { id: "psid-gdpr-failure" },
      postback: { payload: "GDPR_CONSENT_AGREE" },
    });
    const sendLoggedText = vi.fn(async () => ({ sent: true as const }));

    await sendFallbackTextIfNeeded({
      isInboundUserEvent: classification.isInboundUserEvent,
      isIntentionalSilentAck: classification.isIntentionalSilentAck,
      isIntentionalSilentUnknownPayload:
        classification.isIntentionalSilentUnknownPayload,
      responseSent: () => false,
      sendLoggedText,
      psid: "psid-gdpr-failure",
      lang: "nl",
      reqId: "req-gdpr-failure",
    });

    expect(sendLoggedText).toHaveBeenCalledTimes(1);
  });
});
