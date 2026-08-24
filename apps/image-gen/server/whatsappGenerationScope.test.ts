import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveConversationIdentityV2: vi.fn(),
  getDatabaseOrThrow: vi.fn(),
  admitMessengerPrivacySubjectFromMetaEvent: vi.fn(),
  assertMessengerPrivacySubject: vi.fn(),
  toUserKey: vi.fn(() => "u:expected-subject"),
}));

vi.mock("./_core/conversationIdentityResolver", () => ({
  resolveConversationIdentityV2: mocks.resolveConversationIdentityV2,
}));

vi.mock("./db", () => ({
  getDatabaseOrThrow: mocks.getDatabaseOrThrow,
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  admitMessengerPrivacySubjectFromMetaEvent:
    mocks.admitMessengerPrivacySubjectFromMetaEvent,
  assertMessengerPrivacySubject: mocks.assertMessengerPrivacySubject,
}));

vi.mock("./_core/privacy", () => ({ toUserKey: mocks.toUserKey }));

import {
  resolveWhatsAppGenerationScope,
  WhatsAppGenerationScopeError,
} from "./_core/whatsappGenerationScope";

const ENDPOINT = Object.freeze({
  channel: "whatsapp" as const,
  wabaId: "303030303030303" as never,
  phoneNumberId: "404040404040404" as never,
});
const EVENT_OCCURRED_AT = new Date("2026-08-24T07:00:00.000Z");

function connectedIdentity() {
  return {
    subject: { workspaceId: 42 },
    delivery: {
      channel: "whatsapp" as const,
      channelConnectionId: 8,
      wabaId: ENDPOINT.wabaId,
      phoneNumberId: ENDPOINT.phoneNumberId,
      senderId: "32470000001",
    },
    connectionStatus: "connected" as const,
  };
}

function bindDatabase(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  mocks.getDatabaseOrThrow.mockResolvedValue({ select });
  return { select, from, where, limit };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("WhatsApp generation scope resolver", () => {
  it("returns the exact connected binding and active privacy epoch", async () => {
    mocks.resolveConversationIdentityV2.mockResolvedValue(connectedIdentity());
    const query = bindDatabase([{ bindingEpoch: 5 }]);
    mocks.admitMessengerPrivacySubjectFromMetaEvent.mockResolvedValue(3);
    mocks.assertMessengerPrivacySubject.mockResolvedValue(undefined);

    const result = await resolveWhatsAppGenerationScope({
      endpoint: ENDPOINT,
      senderId: "32470000001",
      userKey: "u:expected-subject",
      eventOccurredAt: EVENT_OCCURRED_AT,
    });

    expect(result).toEqual({
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 5,
      privacyEpoch: 3,
      userKey: "u:expected-subject",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(
      mocks.admitMessengerPrivacySubjectFromMetaEvent
    ).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: "u:expected-subject",
      eventOccurredAt: EVENT_OCCURRED_AT,
      allowReactivation: true,
      allowCreation: true,
    });
    expect(mocks.assertMessengerPrivacySubject).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: "u:expected-subject",
      privacyEpoch: 3,
    });
  });

  it("rejects a caller-supplied user key that does not match the sender", async () => {
    await expect(
      resolveWhatsAppGenerationScope({
        endpoint: ENDPOINT,
        senderId: "32470000001",
        userKey: "u:other-subject",
        eventOccurredAt: EVENT_OCCURRED_AT,
      })
    ).rejects.toBeInstanceOf(WhatsAppGenerationScopeError);

    expect(mocks.resolveConversationIdentityV2).not.toHaveBeenCalled();
    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
  });

  it("rejects disconnected ownership before privacy or generation state", async () => {
    mocks.resolveConversationIdentityV2.mockResolvedValue({
      subject: { workspaceId: 42 },
      delivery: null,
      connectionStatus: "webhook_unhealthy",
    });

    await expect(
      resolveWhatsAppGenerationScope({
        endpoint: ENDPOINT,
        senderId: "32470000001",
        userKey: "u:expected-subject",
        eventOccurredAt: EVENT_OCCURRED_AT,
      })
    ).rejects.toBeInstanceOf(WhatsAppGenerationScopeError);

    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
    expect(
      mocks.admitMessengerPrivacySubjectFromMetaEvent
    ).not.toHaveBeenCalled();
  });

  it("rejects a binding that changed before the final epoch read", async () => {
    mocks.resolveConversationIdentityV2.mockResolvedValue(connectedIdentity());
    bindDatabase([]);

    await expect(
      resolveWhatsAppGenerationScope({
        endpoint: ENDPOINT,
        senderId: "32470000001",
        userKey: "u:expected-subject",
        eventOccurredAt: EVENT_OCCURRED_AT,
      })
    ).rejects.toBeInstanceOf(WhatsAppGenerationScopeError);

    expect(
      mocks.admitMessengerPrivacySubjectFromMetaEvent
    ).not.toHaveBeenCalled();
  });
});
