import { describe, expect, it, vi } from "vitest";
import {
  ConversationBoundaryEnvelopeError,
  createConversationBoundaryEnvelopeV2WithKey,
  parseConversationBoundaryEnvelopeV2,
  requireConnectedConversationDeliveryV2,
  requireVerifiedConversationSubjectV2,
  requireVerifiedQueuedConversationSubjectV2,
  verifyQueuedConversationBoundaryEnvelopeV2WithDeps,
  verifyConversationBoundaryEnvelopeV2WithDeps,
  type ConversationBoundaryEnvelopeErrorCode,
  type ConversationBoundaryEnvelopeV2,
  type ConversationBoundaryVerifierDeps,
} from "./_core/conversationBoundaryEnvelope";
import {
  parseConversationIdentityConfig,
  type ConversationIdentityKey,
} from "./_core/conversationIdentityConfig";
import {
  ConversationIdentityError,
  resolveConversationSenderId,
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
  type ConversationEndpoint,
  type ConversationSenderId,
} from "./_core/conversationEndpoint";
import type { ResolvedConversationIdentityV2 } from "./_core/conversationIdentityResolver";
import { deriveConversationSubjectV2 } from "./_core/conversationSubject";

const KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: "11".repeat(32),
});
const DRIFTED_KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: "22".repeat(32),
});
const ROTATED_KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k2",
  CONVERSATION_SCOPE_HMAC_SECRET: "33".repeat(32),
});
const MESSENGER_ENDPOINT = resolveMessengerEndpoint({
  entryId: "123456789012345",
});
const MESSENGER_SENDER_ID = resolveConversationSenderId("987654321098765");
const WHATSAPP_ENDPOINT = resolveWhatsAppEndpoint({
  wabaId: "223456789012345",
  phoneNumberId: "323456789012345",
});
const WHATSAPP_SENDER_ID = resolveConversationSenderId("447700900123");
const PAYLOAD = Buffer.from(
  JSON.stringify({ messageId: "mid-1", text: "private prompt" }),
  "utf8"
);

type ConnectionStatus =
  "connected" | "missing_permissions" | "token_expired" | "webhook_unhealthy";

function identity(
  input: {
    endpoint?: ConversationEndpoint;
    senderId?: ConversationSenderId;
    workspaceId?: number;
    channelConnectionId?: number;
    status?: ConnectionStatus;
    key?: ConversationIdentityKey;
  } = {}
): ResolvedConversationIdentityV2 {
  const endpoint = input.endpoint ?? MESSENGER_ENDPOINT;
  const senderId = input.senderId ?? MESSENGER_SENDER_ID;
  const workspaceId = input.workspaceId ?? 42;
  const channelConnectionId = input.channelConnectionId ?? 7;
  const status = input.status ?? "connected";
  const subject = deriveConversationSubjectV2({
    workspaceId,
    channelConnectionId,
    endpoint,
    senderId,
    key: input.key ?? KEY,
  });

  if (status !== "connected") {
    return Object.freeze({
      subject,
      delivery: null,
      connectionStatus: status,
    });
  }

  const delivery =
    endpoint.channel === "messenger"
      ? Object.freeze({
          channel: "messenger" as const,
          channelConnectionId,
          pageId: endpoint.pageId,
          senderId,
        })
      : Object.freeze({
          channel: "whatsapp" as const,
          channelConnectionId,
          wabaId: endpoint.wabaId,
          phoneNumberId: endpoint.phoneNumberId,
          senderId,
        });
  return Object.freeze({
    subject,
    delivery,
    connectionStatus: status,
  });
}

function envelope(
  input: {
    resolved?: ResolvedConversationIdentityV2;
    endpoint?: ConversationEndpoint;
    senderId?: ConversationSenderId;
    payload?: Uint8Array;
    payloadKind?: "meta_messenger_event" | "meta_whatsapp_message";
    key?: ConversationIdentityKey;
  } = {}
): ConversationBoundaryEnvelopeV2 {
  const endpoint = input.endpoint ?? MESSENGER_ENDPOINT;
  const senderId = input.senderId ?? MESSENGER_SENDER_ID;
  const resolved =
    input.resolved ?? identity({ endpoint, senderId, key: input.key });
  return createConversationBoundaryEnvelopeV2WithKey({
    subject: resolved.subject,
    payloadKind:
      input.payloadKind ??
      (endpoint.channel === "messenger"
        ? "meta_messenger_event"
        : "meta_whatsapp_message"),
    endpoint,
    senderId,
    payload: input.payload ?? PAYLOAD,
    key: input.key ?? KEY,
  });
}

function verifierDeps(
  input: {
    key?: ConversationIdentityKey;
    resolveIdentity?: ConversationBoundaryVerifierDeps["resolveIdentity"];
  } = {}
) {
  const resolveIdentity =
    input.resolveIdentity ??
    vi.fn(
      async (endpoint: ConversationEndpoint, senderId: ConversationSenderId) =>
        identity({ endpoint, senderId, key: input.key ?? KEY })
    );
  return {
    deps: {
      getIdentityKey: () => input.key ?? KEY,
      resolveIdentity,
    } satisfies ConversationBoundaryVerifierDeps,
    resolveIdentity,
  };
}

async function expectBoundaryError(
  callback: () => Promise<unknown>,
  code: ConversationBoundaryEnvelopeErrorCode,
  retryable = false,
  rawValues: readonly string[] = []
): Promise<ConversationBoundaryEnvelopeError> {
  let caught: unknown;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConversationBoundaryEnvelopeError);
  const boundaryError = caught as ConversationBoundaryEnvelopeError;
  expect(boundaryError).toMatchObject({
    name: "ConversationBoundaryEnvelopeError",
    code,
    retryable,
    message: "Conversation boundary is unavailable",
  });
  const serialized = JSON.stringify(boundaryError);
  for (const rawValue of rawValues) {
    expect(serialized).not.toContain(rawValue);
    expect(boundaryError.message).not.toContain(rawValue);
  }
  return boundaryError;
}

describe("ConversationBoundaryEnvelopeV2", () => {
  it.each([
    {
      name: "Messenger",
      endpoint: MESSENGER_ENDPOINT,
      senderId: MESSENGER_SENDER_ID,
    },
    {
      name: "WhatsApp",
      endpoint: WHATSAPP_ENDPOINT,
      senderId: WHATSAPP_SENDER_ID,
    },
  ])("creates, parses, and authoritatively verifies $name", async input => {
    const resolved = identity(input);
    const created = envelope({ ...input, resolved });
    const parsed = parseConversationBoundaryEnvelopeV2(
      JSON.parse(JSON.stringify(created))
    );
    const { deps, resolveIdentity } = verifierDeps({
      resolveIdentity: vi.fn(async () => resolved),
    });

    const verified = await verifyQueuedConversationBoundaryEnvelopeV2WithDeps({
      envelope: parsed,
      expectedPayloadKind:
        input.endpoint.channel === "messenger"
          ? "meta_messenger_event"
          : "meta_whatsapp_message",
      endpoint: input.endpoint,
      senderId: input.senderId,
      payload: PAYLOAD,
      expectedScope: {
        tenantKey: created.tenantKey,
        bindingKey: created.bindingKey,
      },
      deps,
    });

    expect(verified).toMatchObject({ envelope: parsed, identity: resolved });
    expect(requireVerifiedConversationSubjectV2(verified)).toBe(
      resolved.subject
    );
    expect(requireVerifiedQueuedConversationSubjectV2(verified)).toBe(
      resolved.subject
    );
    expect(resolveIdentity).toHaveBeenCalledWith(
      input.endpoint,
      input.senderId
    );
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(created.authenticationTag).toMatch(/^e2\.k1\.[0-9a-f]{64}$/);
    const reflectedClone = { ...verified };
    for (const symbol of Object.getOwnPropertySymbols(verified)) {
      Object.defineProperty(reflectedClone, symbol, {
        value: Reflect.get(verified, symbol),
      });
    }
    expect(() =>
      requireVerifiedConversationSubjectV2(reflectedClone)
    ).toThrowError(
      expect.objectContaining({
        name: "ConversationBoundaryEnvelopeError",
        code: "invalid_envelope",
      })
    );
    if (verified.identity.connectionStatus === "connected") {
      expect(requireConnectedConversationDeliveryV2(verified)).toBe(
        verified.identity.delivery
      );
    }
  });

  it("persists no raw endpoint, sender, credentials, or message content", () => {
    const created = envelope();
    const serialized = JSON.stringify(created);

    expect(serialized).not.toContain(MESSENGER_ENDPOINT.pageId);
    expect(serialized).not.toContain(MESSENGER_SENDER_ID);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("accessToken");
    expect(created).not.toHaveProperty("payload");
  });

  it("binds the authentication tag to the exact persisted payload bytes", async () => {
    const created = envelope();
    const semanticallyEqualPayload = Buffer.from(
      '{"text":"private prompt","messageId":"mid-1"}',
      "utf8"
    );
    const { deps, resolveIdentity } = verifierDeps();

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: semanticallyEqualPayload,
          deps,
        }),
      "authentication_failed",
      false,
      ["private prompt", MESSENGER_SENDER_ID]
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("rejects replay into a different authenticated payload purpose", async () => {
    const created = envelope();
    const { deps, resolveIdentity } = verifierDeps();

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_whatsapp_message",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          deps,
        }),
      "payload_kind_mismatch"
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("rejects same-key-id secret drift before authoritative lookup", async () => {
    const created = envelope();
    const { deps, resolveIdentity } = verifierDeps({ key: DRIFTED_KEY });

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          deps,
        }),
      "authentication_failed"
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("rejects a physical queue scope mismatch before authoritative lookup", async () => {
    const created = envelope();
    const other = identity({ workspaceId: 99 });
    const { deps, resolveIdentity } = verifierDeps();

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          expectedScope: {
            tenantKey: other.subject.tenantKey,
            bindingKey: other.subject.bindingKey,
          },
          deps,
        }),
      "scope_mismatch"
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("makes physical scope mandatory for the queued verifier", async () => {
    const created = envelope();
    const { deps, resolveIdentity } = verifierDeps();

    await expectBoundaryError(
      () =>
        verifyQueuedConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          expectedScope: undefined as never,
          deps,
        }),
      "scope_mismatch"
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("rejects an unavailable key epoch without trying an old key", async () => {
    const rotatedIdentity = identity({ key: ROTATED_KEY });
    const created = envelope({ resolved: rotatedIdentity, key: ROTATED_KEY });
    const { deps, resolveIdentity } = verifierDeps({ key: KEY });

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          deps,
        }),
      "key_id_unknown"
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it("classifies active-key configuration failure as retryable", async () => {
    const created = envelope();
    const resolveIdentity = vi.fn();

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          deps: {
            getIdentityKey: () => {
              throw new Error("secret manager temporarily unavailable");
            },
            resolveIdentity,
          },
        }),
      "key_configuration_unavailable",
      true,
      ["secret manager temporarily unavailable"]
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["workspaceId", 43],
    ["channelConnectionId", 8],
    ["tenantKey", `t2.k1.${"a".repeat(64)}`],
    ["bindingKey", `b2.k1.${"b".repeat(64)}`],
    ["userKey", `u2.k1.${"c".repeat(64)}`],
  ] as const)(
    "detects authenticated-field tampering in %s",
    async (field, value) => {
      const created = envelope();
      const tampered = { ...created, [field]: value };
      const { deps, resolveIdentity } = verifierDeps();

      await expectBoundaryError(
        () =>
          verifyConversationBoundaryEnvelopeV2WithDeps({
            envelope: tampered,
            expectedPayloadKind: "meta_messenger_event",
            endpoint: MESSENGER_ENDPOINT,
            senderId: MESSENGER_SENDER_ID,
            payload: PAYLOAD,
            deps,
          }),
        "authentication_failed"
      );
      expect(resolveIdentity).not.toHaveBeenCalled();
    }
  );

  it("rejects stale or reassigned authoritative bindings", async () => {
    const created = envelope();
    for (const { current, code } of [
      {
        current: identity({ workspaceId: 99 }),
        code: "binding_reassigned" as const,
      },
      {
        current: identity({ channelConnectionId: 8 }),
        code: "binding_stale" as const,
      },
    ]) {
      const { deps } = verifierDeps({
        resolveIdentity: vi.fn(async () => current),
      });
      await expectBoundaryError(
        () =>
          verifyConversationBoundaryEnvelopeV2WithDeps({
            envelope: created,
            expectedPayloadKind: "meta_messenger_event",
            endpoint: MESSENGER_ENDPOINT,
            senderId: MESSENGER_SENDER_ID,
            payload: PAYLOAD,
            deps,
          }),
        code
      );
    }
  });

  it("re-derives identity from the supplied endpoint and sender", async () => {
    const created = envelope();
    const otherEndpoint = resolveMessengerEndpoint({
      entryId: "423456789012345",
    });
    const otherSender = resolveConversationSenderId("587654321098765");
    for (const [endpoint, senderId] of [
      [otherEndpoint, MESSENGER_SENDER_ID],
      [MESSENGER_ENDPOINT, otherSender],
    ] as const) {
      const { deps } = verifierDeps();
      await expectBoundaryError(
        () =>
          verifyConversationBoundaryEnvelopeV2WithDeps({
            envelope: created,
            expectedPayloadKind: "meta_messenger_event",
            endpoint,
            senderId,
            payload: PAYLOAD,
            deps,
          }),
        "identity_mismatch"
      );
    }
  });

  it("preserves degraded ownership but never restores a delivery target", async () => {
    const created = envelope();
    const degraded = identity({ status: "token_expired" });
    const { deps } = verifierDeps({
      resolveIdentity: vi.fn(async () => degraded),
    });

    const verified = await verifyConversationBoundaryEnvelopeV2WithDeps({
      envelope: created,
      expectedPayloadKind: "meta_messenger_event",
      endpoint: MESSENGER_ENDPOINT,
      senderId: MESSENGER_SENDER_ID,
      payload: PAYLOAD,
      deps,
    });

    expect(verified.identity).toMatchObject({
      connectionStatus: "token_expired",
      delivery: null,
    });
    expect(() => requireConnectedConversationDeliveryV2(verified)).toThrowError(
      expect.objectContaining({
        name: "ConversationBoundaryEnvelopeError",
        code: "delivery_unavailable",
        message: "Conversation boundary is unavailable",
      })
    );
  });

  it("maps database availability failure to a safe retryable error", async () => {
    const rawDriverMessage = "database host customer-primary.internal failed";
    const created = envelope();
    const { deps } = verifierDeps({
      resolveIdentity: vi.fn(async () => {
        const error = new ConversationIdentityError(
          "binding_lookup_failed",
          true
        );
        Object.defineProperty(error, "cause", {
          value: new Error(rawDriverMessage),
        });
        throw error;
      }),
    });

    await expectBoundaryError(
      () =>
        verifyConversationBoundaryEnvelopeV2WithDeps({
          envelope: created,
          expectedPayloadKind: "meta_messenger_event",
          endpoint: MESSENGER_ENDPOINT,
          senderId: MESSENGER_SENDER_ID,
          payload: PAYLOAD,
          deps,
        }),
      "identity_unavailable",
      true,
      [rawDriverMessage]
    );
  });

  it.each([
    ["binding_not_found", "binding_stale"],
    ["binding_ambiguous", "binding_ambiguous"],
    ["binding_inactive", "binding_inactive"],
  ] as const)(
    "maps resolver %s to safe quarantine code %s",
    async (identityCode, boundaryCode) => {
      const created = envelope();
      const { deps } = verifierDeps({
        resolveIdentity: vi.fn(async () => {
          throw new ConversationIdentityError(identityCode);
        }),
      });

      await expectBoundaryError(
        () =>
          verifyConversationBoundaryEnvelopeV2WithDeps({
            envelope: created,
            expectedPayloadKind: "meta_messenger_event",
            endpoint: MESSENGER_ENDPOINT,
            senderId: MESSENGER_SENDER_ID,
            payload: PAYLOAD,
            deps,
          }),
        boundaryCode
      );
    }
  );

  it.each([
    null,
    [],
    {},
    { ...envelope(), version: 1 },
    { ...envelope(), keyId: "k01" },
    { ...envelope(), payloadKind: "meta_whatsapp_message" },
    { ...envelope(), workspaceId: 0 },
    { ...envelope(), channel: "web" },
    { ...envelope(), channelConnectionId: 0 },
    { ...envelope(), tenantKey: `t2.k2.${"a".repeat(64)}` },
    { ...envelope(), bindingKey: `b2.k1.${"A".repeat(64)}` },
    { ...envelope(), authenticationTag: `e2.k1.${"a".repeat(63)}` },
    { ...envelope(), encryptedAccessToken: "must-not-pass" },
  ])("strictly rejects malformed or expanded envelope %#", value => {
    expect(() => parseConversationBoundaryEnvelopeV2(value)).toThrowError(
      expect.objectContaining({
        name: "ConversationBoundaryEnvelopeError",
        code: "invalid_envelope",
        message: "Conversation boundary is unavailable",
      })
    );
  });

  it("rejects creation when subject, endpoint, or sender do not agree", () => {
    const resolved = identity();

    expect(() =>
      createConversationBoundaryEnvelopeV2WithKey({
        subject: resolved.subject,
        payloadKind: "meta_messenger_event",
        endpoint: resolveMessengerEndpoint({
          entryId: "423456789012345",
        }),
        senderId: MESSENGER_SENDER_ID,
        payload: PAYLOAD,
        key: KEY,
      })
    ).toThrowError(ConversationBoundaryEnvelopeError);
    expect(() =>
      createConversationBoundaryEnvelopeV2WithKey({
        subject: resolved.subject,
        payloadKind: "meta_messenger_event",
        endpoint: MESSENGER_ENDPOINT,
        senderId: " 987654321098765 ",
        payload: PAYLOAD,
        key: KEY,
      })
    ).toThrowError(ConversationBoundaryEnvelopeError);
  });

  it("does not accept a structurally forged verified result", () => {
    const resolved = identity();
    const forged = {
      envelope: envelope(),
      identity: resolved,
    };

    expect(() => requireVerifiedConversationSubjectV2(forged)).toThrowError(
      expect.objectContaining({
        name: "ConversationBoundaryEnvelopeError",
        code: "invalid_envelope",
      })
    );
    expect(() =>
      requireConnectedConversationDeliveryV2(forged as never)
    ).toThrowError(
      expect.objectContaining({
        name: "ConversationBoundaryEnvelopeError",
        code: "invalid_envelope",
      })
    );
  });
});
