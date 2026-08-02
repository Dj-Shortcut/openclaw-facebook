import { describe, expect, it } from "vitest";
import {
  ConversationIdentityError,
  revalidateConversationEndpoint,
  resolveConversationSenderId,
  resolveMessengerEndpoint,
  resolveMessengerWebhookEndpoint,
  resolveWhatsAppEndpoint,
  type ConversationIdentityErrorCode,
} from "./_core/conversationEndpoint";

function expectIdentityError(
  callback: () => unknown,
  code: ConversationIdentityErrorCode
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationIdentityError);
    expect(error).toMatchObject({
      name: "ConversationIdentityError",
      code,
      message: "Conversation identity is unavailable",
    });
    return;
  }
  throw new Error(`Expected conversation identity error: ${code}`);
}

describe("conversation endpoints", () => {
  it("accepts a Messenger Page only when entry and recipient agree", () => {
    const endpoint = resolveMessengerEndpoint({
      entryId: "123456789012345",
      recipientId: "123456789012345",
    });

    expect(endpoint).toEqual({
      channel: "messenger",
      pageId: "123456789012345",
    });
    expect(Object.isFrozen(endpoint)).toBe(true);
  });

  it("fails closed when Messenger entry and recipient identify different Pages", () => {
    expectIdentityError(
      () =>
        resolveMessengerEndpoint({
          entryId: "123456789012345",
          recipientId: "543210987654321",
        }),
      "endpoint_context_mismatch"
    );
  });

  it("requires both outer and inner Page context at a Messenger webhook boundary", () => {
    expect(
      resolveMessengerWebhookEndpoint({
        entryId: "123456789012345",
        recipientId: "123456789012345",
      })
    ).toEqual({
      channel: "messenger",
      pageId: "123456789012345",
    });

    expectIdentityError(
      () =>
        resolveMessengerWebhookEndpoint({
          recipientId: "123456789012345",
        }),
      "invalid_input"
    );
    expectIdentityError(
      () =>
        resolveMessengerWebhookEndpoint({
          entryId: "123456789012345",
        }),
      "invalid_input"
    );
    expectIdentityError(
      () =>
        resolveMessengerWebhookEndpoint({
          entryId: "123456789012345",
          recipientId: "543210987654321",
        }),
      "endpoint_context_mismatch"
    );
  });

  it.each([
    " 123",
    "123 ",
    "01",
    "0",
    "+1",
    "1.0",
    "1e3",
    "١٢٣",
    "1\n2",
    "1\u00002",
    "1".repeat(33),
    123,
    null,
  ])("rejects non-canonical Meta identifier %j", identifier => {
    expectIdentityError(
      () => resolveMessengerEndpoint({ entryId: identifier }),
      "invalid_input"
    );
    expectIdentityError(
      () => resolveConversationSenderId(identifier),
      "invalid_input"
    );
  });

  it("requires both decimal-only WhatsApp endpoint identifiers", () => {
    const endpoint = resolveWhatsAppEndpoint({
      wabaId: "123456789012345",
      phoneNumberId: "987654321098765",
    });

    expect(endpoint).toEqual({
      channel: "whatsapp",
      wabaId: "123456789012345",
      phoneNumberId: "987654321098765",
    });
    expect(Object.isFrozen(endpoint)).toBe(true);

    expectIdentityError(
      () =>
        resolveWhatsAppEndpoint({
          phoneNumberId: "987654321098765",
        }),
      "invalid_input"
    );
    expectIdentityError(
      () =>
        resolveWhatsAppEndpoint({
          wabaId: "123456789012345",
          phoneNumberId: "987654321098765 ",
        }),
      "invalid_input"
    );
  });

  it("revalidates stored Messenger and WhatsApp endpoints", () => {
    const messenger = resolveMessengerEndpoint({
      entryId: "123456789012345",
    });
    const whatsapp = resolveWhatsAppEndpoint({
      wabaId: "123456789012345",
      phoneNumberId: "987654321098765",
    });

    const revalidatedMessenger = revalidateConversationEndpoint(messenger);
    const revalidatedWhatsApp = revalidateConversationEndpoint(whatsapp);

    expect(revalidatedMessenger).toEqual(messenger);
    expect(revalidatedMessenger).not.toBe(messenger);
    expect(Object.isFrozen(revalidatedMessenger)).toBe(true);
    expect(revalidatedWhatsApp).toEqual(whatsapp);
    expect(revalidatedWhatsApp).not.toBe(whatsapp);
    expect(Object.isFrozen(revalidatedWhatsApp)).toBe(true);
  });

  it.each([
    { label: "unknown", endpoint: { channel: "sms" } },
    { label: "absent", endpoint: {} },
  ])("fails closed for an $label stored channel", ({ endpoint }) => {
    expectIdentityError(
      () =>
        revalidateConversationEndpoint(
          endpoint as Parameters<typeof revalidateConversationEndpoint>[0]
        ),
      "unsupported_channel"
    );
  });
});
