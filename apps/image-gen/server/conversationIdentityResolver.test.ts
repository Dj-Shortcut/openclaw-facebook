import { describe, expect, it, vi } from "vitest";

import {
  ConversationIdentityError,
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
  type ConversationEndpoint,
  type ConversationIdentityErrorCode,
} from "./_core/conversationEndpoint";
import { parseConversationIdentityConfig } from "./_core/conversationIdentityConfig";
import {
  resolveConversationIdentityV2WithDeps,
  type ConversationBindingRecord,
  type ConversationIdentityResolverDeps,
} from "./_core/conversationIdentityResolver";

const MESSENGER_PAGE_ID = "101010101010101";
const MESSENGER_SENDER_ID = "202020202020202";
const WHATSAPP_WABA_ID = "303030303030303";
const WHATSAPP_PHONE_NUMBER_ID = "404040404040404";
const WHATSAPP_SENDER_ID = "32470000001";
const RAW_CONNECTION_TOKEN = "sealed-connection-token-must-not-escape";

const identityKey = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: "11".repeat(32),
});

function messengerBinding(
  overrides: Partial<ConversationBindingRecord> = {}
): ConversationBindingRecord {
  return {
    id: 7,
    workspaceId: 42,
    channel: "facebook_messenger",
    status: "connected",
    externalId: MESSENGER_PAGE_ID,
    providerAccountExternalId: null,
    ...overrides,
  };
}

function whatsAppBinding(
  overrides: Partial<ConversationBindingRecord> = {}
): ConversationBindingRecord {
  return {
    id: 8,
    workspaceId: 84,
    channel: "whatsapp",
    status: "connected",
    externalId: WHATSAPP_PHONE_NUMBER_ID,
    providerAccountExternalId: WHATSAPP_WABA_ID,
    ...overrides,
  };
}

function resolverDeps(result: readonly ConversationBindingRecord[] | Error): {
  deps: ConversationIdentityResolverDeps;
  findBindings: ReturnType<typeof vi.fn>;
  getIdentityKey: ReturnType<typeof vi.fn>;
} {
  const findBindings = vi.fn(async (_endpoint: ConversationEndpoint) => {
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  const getIdentityKey = vi.fn(() => identityKey);
  return {
    deps: { findBindings, getIdentityKey },
    findBindings,
    getIdentityKey,
  };
}

async function expectSafeIdentityFailure(
  action: () => Promise<unknown>,
  expected: {
    code: ConversationIdentityErrorCode;
    retryable?: boolean;
    rawValues?: readonly string[];
  }
): Promise<ConversationIdentityError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ConversationIdentityError);
  const identityError = caught as ConversationIdentityError;
  expect(identityError).toMatchObject({
    name: "ConversationIdentityError",
    message: "Conversation identity is unavailable",
    code: expected.code,
    retryable: expected.retryable ?? false,
  });
  expect(identityError).not.toHaveProperty("cause");

  const publicError = [
    identityError.name,
    identityError.message,
    identityError.code,
    String(identityError.retryable),
    JSON.stringify(identityError),
  ].join("|");
  for (const rawValue of expected.rawValues ?? []) {
    expect(publicError).not.toContain(rawValue);
  }

  return identityError;
}

describe("conversation identity resolver", () => {
  it("resolves a Messenger binding to an opaque subject and frozen credential-free delivery", async () => {
    const endpoint = resolveMessengerEndpoint({ entryId: MESSENGER_PAGE_ID });
    const bindingWithCredentials = {
      ...messengerBinding(),
      encryptedAccessToken: RAW_CONNECTION_TOKEN,
      grantedScopes: ["pages_messaging"],
    };
    const { deps, findBindings, getIdentityKey } = resolverDeps([
      bindingWithCredentials,
    ]);

    const resolved = await resolveConversationIdentityV2WithDeps(
      endpoint,
      MESSENGER_SENDER_ID,
      deps
    );

    expect(findBindings).toHaveBeenCalledOnce();
    expect(findBindings).toHaveBeenCalledWith(endpoint);
    expect(getIdentityKey).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      subject: {
        version: 2,
        keyId: "k1",
        workspaceId: 42,
        channel: "messenger",
        channelConnectionId: 7,
      },
      delivery: {
        channel: "messenger",
        channelConnectionId: 7,
        pageId: MESSENGER_PAGE_ID,
        senderId: MESSENGER_SENDER_ID,
      },
      connectionStatus: "connected",
    });
    expect(resolved.subject.tenantKey).toMatch(/^t2\.k1\.[a-f0-9]{64}$/);
    expect(resolved.subject.bindingKey).toMatch(/^b2\.k1\.[a-f0-9]{64}$/);
    expect(resolved.subject.userKey).toMatch(/^u2\.k1\.[a-f0-9]{64}$/);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.subject)).toBe(true);
    expect(Object.isFrozen(resolved.delivery)).toBe(true);
    expect(resolved.delivery).not.toHaveProperty("encryptedAccessToken");
    expect(resolved.delivery).not.toHaveProperty("grantedScopes");
    expect(JSON.stringify(resolved)).not.toContain(RAW_CONNECTION_TOKEN);
  });

  it("resolves an exact WhatsApp WABA and phone-number binding", async () => {
    const endpoint = resolveWhatsAppEndpoint({
      wabaId: WHATSAPP_WABA_ID,
      phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
    });
    const bindingWithCredentials = {
      ...whatsAppBinding(),
      encryptedAccessToken: RAW_CONNECTION_TOKEN,
    };
    const { deps, findBindings, getIdentityKey } = resolverDeps([
      bindingWithCredentials,
    ]);

    const resolved = await resolveConversationIdentityV2WithDeps(
      endpoint,
      WHATSAPP_SENDER_ID,
      deps
    );

    expect(findBindings).toHaveBeenCalledWith(endpoint);
    expect(getIdentityKey).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      subject: {
        version: 2,
        keyId: "k1",
        workspaceId: 84,
        channel: "whatsapp",
        channelConnectionId: 8,
      },
      delivery: {
        channel: "whatsapp",
        channelConnectionId: 8,
        wabaId: WHATSAPP_WABA_ID,
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
        senderId: WHATSAPP_SENDER_ID,
      },
      connectionStatus: "connected",
    });
    expect(resolved.subject.tenantKey).toMatch(/^t2\.k1\.[a-f0-9]{64}$/);
    expect(resolved.subject.bindingKey).toMatch(/^b2\.k1\.[a-f0-9]{64}$/);
    expect(resolved.subject.userKey).toMatch(/^u2\.k1\.[a-f0-9]{64}$/);
    expect(Object.isFrozen(resolved.delivery)).toBe(true);
    expect(resolved.delivery).not.toHaveProperty("encryptedAccessToken");
    expect(JSON.stringify(resolved)).not.toContain(RAW_CONNECTION_TOKEN);
  });

  it.each([
    "connected",
    "missing_permissions",
    "token_expired",
    "webhook_unhealthy",
  ] as const)(
    "preserves %s as an ownership status instead of losing the tenant binding",
    async status => {
      const endpoint = resolveMessengerEndpoint({
        entryId: MESSENGER_PAGE_ID,
      });
      const { deps } = resolverDeps([messengerBinding({ status })]);

      const resolved = await resolveConversationIdentityV2WithDeps(
        endpoint,
        MESSENGER_SENDER_ID,
        deps
      );

      expect(resolved).toMatchObject({
        subject: { workspaceId: 42, channelConnectionId: 7 },
        connectionStatus: status,
      });
      if (status === "connected") {
        expect(resolved.delivery).toMatchObject({ channel: "messenger" });
      } else {
        expect(resolved.delivery).toBeNull();
      }
    }
  );

  it.each([
    {
      name: "no binding",
      bindings: [] as ConversationBindingRecord[],
      code: "binding_not_found" as const,
    },
    {
      name: "more than one binding",
      bindings: [
        messengerBinding(),
        messengerBinding({ id: 9, workspaceId: 99 }),
      ],
      code: "binding_ambiguous" as const,
    },
  ])("fails closed for $name", async ({ bindings, code }) => {
    const endpoint = resolveMessengerEndpoint({ entryId: MESSENGER_PAGE_ID });
    const { deps, findBindings, getIdentityKey } = resolverDeps(bindings);

    await expectSafeIdentityFailure(
      () =>
        resolveConversationIdentityV2WithDeps(
          endpoint,
          MESSENGER_SENDER_ID,
          deps
        ),
      {
        code,
        rawValues: [MESSENGER_PAGE_ID, MESSENGER_SENDER_ID],
      }
    );

    expect(findBindings).toHaveBeenCalledOnce();
    expect(getIdentityKey).not.toHaveBeenCalled();
  });

  it("sanitizes database lookup failures and marks them retryable", async () => {
    const endpoint = resolveMessengerEndpoint({ entryId: MESSENGER_PAGE_ID });
    const rawDriverMessage = `driver failed for ${MESSENGER_PAGE_ID} and ${MESSENGER_SENDER_ID}`;
    const driverError = new Error(rawDriverMessage, {
      cause: new Error("raw nested database cause"),
    });
    const { deps, findBindings, getIdentityKey } = resolverDeps(driverError);

    await expectSafeIdentityFailure(
      () =>
        resolveConversationIdentityV2WithDeps(
          endpoint,
          MESSENGER_SENDER_ID,
          deps
        ),
      {
        code: "binding_lookup_failed",
        retryable: true,
        rawValues: [
          rawDriverMessage,
          "raw nested database cause",
          MESSENGER_PAGE_ID,
          MESSENGER_SENDER_ID,
        ],
      }
    );

    expect(findBindings).toHaveBeenCalledOnce();
    expect(getIdentityKey).not.toHaveBeenCalled();
  });

  it("rejects a disconnected binding without deriving a subject", async () => {
    const endpoint = resolveMessengerEndpoint({ entryId: MESSENGER_PAGE_ID });
    const { deps, getIdentityKey } = resolverDeps([
      messengerBinding({ status: "disconnected" }),
    ]);

    await expectSafeIdentityFailure(
      () =>
        resolveConversationIdentityV2WithDeps(
          endpoint,
          MESSENGER_SENDER_ID,
          deps
        ),
      {
        code: "binding_inactive",
        rawValues: [MESSENGER_PAGE_ID, MESSENGER_SENDER_ID],
      }
    );
    expect(getIdentityKey).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Messenger Page",
      endpoint: resolveMessengerEndpoint({ entryId: MESSENGER_PAGE_ID }),
      senderId: MESSENGER_SENDER_ID,
      binding: messengerBinding({ externalId: "909090909090909" }),
      rawValues: [MESSENGER_PAGE_ID, "909090909090909"],
    },
    {
      name: "WhatsApp WABA",
      endpoint: resolveWhatsAppEndpoint({
        wabaId: WHATSAPP_WABA_ID,
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
      }),
      senderId: WHATSAPP_SENDER_ID,
      binding: whatsAppBinding({
        providerAccountExternalId: "808080808080808",
      }),
      rawValues: [WHATSAPP_WABA_ID, "808080808080808"],
    },
    {
      name: "WhatsApp phone number",
      endpoint: resolveWhatsAppEndpoint({
        wabaId: WHATSAPP_WABA_ID,
        phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
      }),
      senderId: WHATSAPP_SENDER_ID,
      binding: whatsAppBinding({ externalId: "707070707070707" }),
      rawValues: [WHATSAPP_PHONE_NUMBER_ID, "707070707070707"],
    },
  ])(
    "fails closed when the stored $name does not match the endpoint",
    async ({ endpoint, senderId, binding, rawValues }) => {
      const { deps, getIdentityKey } = resolverDeps([binding]);

      await expectSafeIdentityFailure(
        () => resolveConversationIdentityV2WithDeps(endpoint, senderId, deps),
        {
          code: "binding_lookup_failed",
          rawValues: [...rawValues, senderId],
        }
      );
      expect(getIdentityKey).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: "invalid Messenger endpoint",
      endpoint: {
        channel: "messenger",
        pageId: "raw-invalid-page-id",
      } as unknown as ConversationEndpoint,
      senderId: MESSENGER_SENDER_ID,
      code: "invalid_input" as const,
      rawValue: "raw-invalid-page-id",
    },
    {
      name: "invalid sender",
      endpoint: resolveMessengerEndpoint({ entryId: MESSENGER_PAGE_ID }),
      senderId: "raw-invalid-sender-id",
      code: "invalid_input" as const,
      rawValue: "raw-invalid-sender-id",
    },
    {
      name: "unsupported channel",
      endpoint: { channel: "email" } as unknown as ConversationEndpoint,
      senderId: MESSENGER_SENDER_ID,
      code: "unsupported_channel" as const,
      rawValue: "email",
    },
  ])(
    "does not query the database for $name",
    async ({ endpoint, senderId, code, rawValue }) => {
      const { deps, findBindings, getIdentityKey } = resolverDeps([
        messengerBinding(),
      ]);

      await expectSafeIdentityFailure(
        () => resolveConversationIdentityV2WithDeps(endpoint, senderId, deps),
        { code, rawValues: [rawValue] }
      );

      expect(findBindings).not.toHaveBeenCalled();
      expect(getIdentityKey).not.toHaveBeenCalled();
    }
  );
});
