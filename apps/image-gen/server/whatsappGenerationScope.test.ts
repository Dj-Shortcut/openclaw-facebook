import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MessengerPrivacyFenceError extends Error {
    constructor() {
      super("Messenger privacy fence is unavailable");
      this.name = "MessengerPrivacyFenceError";
    }
  }
  return {
    resolveConversationIdentityV2: vi.fn(),
    getDatabaseOrThrow: vi.fn(),
    admitMessengerPrivacySubjectFromMetaEvent: vi.fn(),
    assertMessengerPrivacySubject: vi.fn(),
    toUserKey: vi.fn(() => "u:expected-subject"),
    MessengerPrivacyFenceError,
  };
});

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
  MessengerPrivacyFenceError: mocks.MessengerPrivacyFenceError,
}));

vi.mock("./_core/privacy", () => ({ toUserKey: mocks.toUserKey }));

import {
  resolveWhatsAppGenerationScope,
  WhatsAppGenerationScopeError,
} from "./_core/whatsappGenerationScope";
import {
  ConversationIdentityError,
  resolveWhatsAppEndpoint,
} from "./_core/conversationEndpoint";

const ENDPOINT = resolveWhatsAppEndpoint({
  wabaId: "303030303030303",
  phoneNumberId: "404040404040404",
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
  const database = { select };
  mocks.getDatabaseOrThrow.mockResolvedValue(database);
  return { database, select, from, where, limit };
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

  it("rejects a binding lost after privacy admission", async () => {
    mocks.resolveConversationIdentityV2.mockResolvedValue(connectedIdentity());
    const firstBinding = bindDatabase([{ bindingEpoch: 5 }]);
    const postAdmissionBinding = bindDatabase([]);
    mocks.getDatabaseOrThrow
      .mockResolvedValueOnce(firstBinding.database)
      .mockResolvedValueOnce(postAdmissionBinding.database);
    mocks.admitMessengerPrivacySubjectFromMetaEvent.mockResolvedValue(3);

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
    ).toHaveBeenCalledOnce();
    expect(mocks.assertMessengerPrivacySubject).not.toHaveBeenCalled();
  });

  it("marks a transient identity lookup failure as retryable", async () => {
    mocks.resolveConversationIdentityV2.mockRejectedValue(
      new ConversationIdentityError("binding_lookup_failed", true)
    );

    const error = await resolveWhatsAppGenerationScope({
      endpoint: ENDPOINT,
      senderId: "32470000001",
      userKey: "u:expected-subject",
      eventOccurredAt: EVENT_OCCURRED_AT,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WhatsAppGenerationScopeError);
    expect(error).toMatchObject({ retryable: true });
  });

  it("marks an unexpected privacy-store failure as retryable", async () => {
    mocks.resolveConversationIdentityV2.mockResolvedValue(connectedIdentity());
    bindDatabase([{ bindingEpoch: 5 }]);
    mocks.admitMessengerPrivacySubjectFromMetaEvent.mockRejectedValue(
      new Error("database unavailable")
    );

    const error = await resolveWhatsAppGenerationScope({
      endpoint: ENDPOINT,
      senderId: "32470000001",
      userKey: "u:expected-subject",
      eventOccurredAt: EVENT_OCCURRED_AT,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WhatsAppGenerationScopeError);
    expect(error).toMatchObject({ retryable: true });
  });

  it("keeps privacy-fence rejection terminal", async () => {
    mocks.resolveConversationIdentityV2.mockResolvedValue(connectedIdentity());
    bindDatabase([{ bindingEpoch: 5 }]);
    mocks.admitMessengerPrivacySubjectFromMetaEvent.mockRejectedValue(
      new mocks.MessengerPrivacyFenceError()
    );

    const error = await resolveWhatsAppGenerationScope({
      endpoint: ENDPOINT,
      senderId: "32470000001",
      userKey: "u:expected-subject",
      eventOccurredAt: EVENT_OCCURRED_AT,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WhatsAppGenerationScopeError);
    expect(error).toMatchObject({ retryable: false });
  });
});
