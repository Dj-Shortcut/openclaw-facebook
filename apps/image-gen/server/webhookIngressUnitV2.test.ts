import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ConversationBoundaryEnvelopeError,
  type ConversationBoundaryScopeV2,
} from "./_core/conversationBoundaryEnvelope";
import {
  parseConversationIdentityConfig,
  type ConversationIdentityKey,
} from "./_core/conversationIdentityConfig";
import {
  ConversationIdentityError,
  type ConversationEndpoint,
  type ConversationSenderId,
} from "./_core/conversationEndpoint";
import type { ResolvedConversationIdentityV2 } from "./_core/conversationIdentityResolver";
import { deriveConversationSubjectV2 } from "./_core/conversationSubject";
import {
  MetaConversationIngressV2Error,
  authenticateMetaWebhookBodyV2,
  decodeMetaConversationPayloadV2,
  type VerifiedMetaWebhookBodyV2,
} from "./_core/meta/webhookIngressPayloadV2";
import {
  parseMetaConversationIngressUnitV2,
  requireVerifiedIngressReplayInputV2,
  sealVerifiedMetaConversationIngressBatchV2WithDeps,
  verifyQueuedMetaConversationIngressUnitV2WithDeps,
  type MetaConversationIngressSealerDepsV2,
  type MetaConversationIngressUnitV2,
  type VerifiedMetaConversationIngressUnitV2,
} from "./_core/meta/webhookIngressUnitV2";
import { parseWebhookReplayClaimIdV2 } from "./_core/webhookReplayProtectionV2";

const KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: "44".repeat(32),
});
const DRIFTED_KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: "55".repeat(32),
});
const NEW_EPOCH_KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k2",
  CONVERSATION_SCOPE_HMAC_SECRET: "66".repeat(32),
});
const PAGE_1 = "123456789012345";
const PAGE_2 = "123456789012346";
const SENDER_1 = "987654321098765";
const SENDER_2 = "987654321098766";
const WABA_1 = "223456789012345";
const WABA_2 = "223456789012346";
const PHONE_1 = "323456789012345";
const PHONE_2 = "323456789012346";
const META_MESSENGER_APP_SECRET = "test-messenger-app-secret";
const META_WHATSAPP_APP_SECRET = "test-whatsapp-app-secret";
const ORIGINAL_FB_APP_SECRET = process.env.FB_APP_SECRET;
const ORIGINAL_WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;

beforeAll(() => {
  process.env.FB_APP_SECRET = META_MESSENGER_APP_SECRET;
  process.env.WHATSAPP_APP_SECRET = META_WHATSAPP_APP_SECRET;
});

afterAll(() => {
  if (ORIGINAL_FB_APP_SECRET === undefined) {
    delete process.env.FB_APP_SECRET;
  } else {
    process.env.FB_APP_SECRET = ORIGINAL_FB_APP_SECRET;
  }
  if (ORIGINAL_WHATSAPP_APP_SECRET === undefined) {
    delete process.env.WHATSAPP_APP_SECRET;
  } else {
    process.env.WHATSAPP_APP_SECRET = ORIGINAL_WHATSAPP_APP_SECRET;
  }
});

function verifiedBody(
  signatureProvider: "messenger" | "whatsapp",
  payload: unknown
): VerifiedMetaWebhookBodyV2 {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const appSecret =
    signatureProvider === "messenger"
      ? META_MESSENGER_APP_SECRET
      : META_WHATSAPP_APP_SECRET;
  const signatureHeader = `sha256=${createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;
  return authenticateMetaWebhookBodyV2({
    signatureProvider,
    rawBody,
    signatureHeader,
  });
}

function messengerMessage(
  input: {
    pageId?: string;
    senderId?: string;
    messageId?: string;
    timestamp?: number;
    message?: Record<string, unknown>;
  } = {}
) {
  const pageId = input.pageId ?? PAGE_1;
  return {
    sender: { id: input.senderId ?? SENDER_1, locale: "nl_BE" },
    recipient: { id: pageId },
    timestamp: input.timestamp ?? 1_775_000_000_000,
    message: {
      ...(input.messageId === undefined
        ? { mid: "mid.default-1" }
        : input.messageId
          ? { mid: input.messageId }
          : {}),
      text: "Maak een rustige poster",
      ...(input.message ?? {}),
    },
  };
}

function messengerPayload(
  events: unknown[],
  pageId = PAGE_1
): Record<string, unknown> {
  return {
    object: "page",
    entry: [{ id: pageId, time: 1_775_000_000_001, messaging: events }],
  };
}

function whatsAppMessage(
  input: {
    senderId?: string;
    messageId?: string;
    type?: string;
    timestamp?: string;
    extra?: Record<string, unknown>;
  } = {}
) {
  return {
    from: input.senderId ?? SENDER_1,
    id: input.messageId ?? "wamid.default-1",
    timestamp: input.timestamp ?? "1775000000",
    type: input.type ?? "text",
    text: { body: "Maak een blauwe poster" },
    ...(input.extra ?? {}),
  };
}

function whatsAppPayload(
  input: {
    wabaId?: string;
    phoneNumberId?: string;
    messages?: unknown[];
    statuses?: unknown[];
  } = {}
): Record<string, unknown> {
  const value: Record<string, unknown> = {
    metadata: {
      phone_number_id: input.phoneNumberId ?? PHONE_1,
      display_phone_number: "+32 400 00 00 00",
    },
  };
  if (input.messages !== undefined) {
    value.messages = input.messages;
  }
  if (input.statuses !== undefined) {
    value.statuses = input.statuses;
  }
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId ?? WABA_1,
        changes: [{ field: "messages", value }],
      },
    ],
  };
}

function identityCoordinates(endpoint: ConversationEndpoint): {
  workspaceId: number;
  channelConnectionId: number;
} {
  if (endpoint.channel === "messenger") {
    return endpoint.pageId === PAGE_2
      ? { workspaceId: 43, channelConnectionId: 8 }
      : { workspaceId: 42, channelConnectionId: 7 };
  }
  return endpoint.wabaId === WABA_2 || endpoint.phoneNumberId === PHONE_2
    ? { workspaceId: 45, channelConnectionId: 10 }
    : { workspaceId: 44, channelConnectionId: 9 };
}

function resolvedIdentity(
  endpoint: ConversationEndpoint,
  senderId: ConversationSenderId,
  key: ConversationIdentityKey = KEY,
  coordinates = identityCoordinates(endpoint)
): ResolvedConversationIdentityV2 {
  const subject = deriveConversationSubjectV2({
    ...coordinates,
    endpoint,
    senderId,
    key,
  });
  const delivery =
    endpoint.channel === "messenger"
      ? Object.freeze({
          channel: "messenger" as const,
          channelConnectionId: coordinates.channelConnectionId,
          pageId: endpoint.pageId,
          senderId,
        })
      : Object.freeze({
          channel: "whatsapp" as const,
          channelConnectionId: coordinates.channelConnectionId,
          wabaId: endpoint.wabaId,
          phoneNumberId: endpoint.phoneNumberId,
          senderId,
        });
  return Object.freeze({
    subject,
    delivery,
    connectionStatus: "connected" as const,
  });
}

function claimId(index: number) {
  return parseWebhookReplayClaimIdV2(
    `rc2.${index.toString(16).padStart(32, "0")}`
  );
}

function sealerDeps(
  input: {
    key?: ConversationIdentityKey;
    resolveIdentity?: MetaConversationIngressSealerDepsV2["resolveIdentity"];
    claimIds?: ReturnType<typeof claimId>[];
    keyError?: Error;
    claimError?: Error;
  } = {}
) {
  const ids = [...(input.claimIds ?? [claimId(1), claimId(2), claimId(3)])];
  const resolveIdentity = vi.fn(
    input.resolveIdentity ??
      (async (endpoint, senderId) =>
        resolvedIdentity(endpoint, senderId, input.key ?? KEY))
  );
  const getIdentityKey = vi.fn(() => {
    if (input.keyError) throw input.keyError;
    return input.key ?? KEY;
  });
  const createReplayClaimId = vi.fn(() => {
    if (input.claimError) throw input.claimError;
    const id = ids.shift();
    if (!id) throw new Error("claim fixture exhausted");
    return id;
  });
  return {
    deps: { getIdentityKey, resolveIdentity, createReplayClaimId },
    createReplayClaimId,
    getIdentityKey,
    resolveIdentity,
  };
}

function scope(
  unit: MetaConversationIngressUnitV2
): ConversationBoundaryScopeV2 {
  return {
    tenantKey: unit.boundary.tenantKey,
    bindingKey: unit.boundary.bindingKey,
  };
}

async function verifyUnit(
  unit: MetaConversationIngressUnitV2,
  input: {
    key?: ConversationIdentityKey;
    resolveIdentity?: MetaConversationIngressSealerDepsV2["resolveIdentity"];
    expectedScope?: ConversationBoundaryScopeV2;
  } = {}
) {
  return await verifyQueuedMetaConversationIngressUnitV2WithDeps({
    unit,
    expectedScope: input.expectedScope ?? scope(unit),
    deps: {
      getIdentityKey: () => input.key ?? KEY,
      resolveIdentity:
        input.resolveIdentity ??
        (async (endpoint, senderId) =>
          resolvedIdentity(endpoint, senderId, input.key ?? KEY)),
    },
  });
}

async function expectIngressError(
  callback: () => unknown | Promise<unknown>,
  code: string,
  retryable = false,
  rawValues: readonly string[] = []
): Promise<void> {
  let caught: unknown;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MetaConversationIngressV2Error);
  expect(caught).toMatchObject({
    name: "MetaConversationIngressV2Error",
    code,
    retryable,
    message: "Meta conversation ingress is unavailable",
  });
  const serialized = JSON.stringify(caught);
  for (const rawValue of rawValues) {
    expect(serialized).not.toContain(rawValue);
  }
}

describe("V2 Meta conversation ingress units", () => {
  it("requires an exact signed raw body and a non-forgeable runtime brand", async () => {
    const payload = messengerPayload([messengerMessage()]);
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");

    await expectIngressError(
      () =>
        authenticateMetaWebhookBodyV2({
          signatureProvider: "messenger",
          rawBody,
          signatureHeader: `sha256=${"00".repeat(32)}`,
        }),
      "signature_verification_failed"
    );
    for (const [signatureProvider, wrongSecret] of [
      ["messenger", META_WHATSAPP_APP_SECRET],
      ["whatsapp", META_MESSENGER_APP_SECRET],
    ] as const) {
      await expectIngressError(
        () =>
          authenticateMetaWebhookBodyV2({
            signatureProvider,
            rawBody,
            signatureHeader: `sha256=${createHmac("sha256", wrongSecret)
              .update(rawBody)
              .digest("hex")}`,
          }),
        "signature_verification_failed"
      );
    }
    const whatsAppRawBody = Buffer.from(
      JSON.stringify(whatsAppPayload({ statuses: [{ id: "status" }] })),
      "utf8"
    );
    delete process.env.WHATSAPP_APP_SECRET;
    try {
      expect(
        authenticateMetaWebhookBodyV2({
          signatureProvider: "whatsapp",
          rawBody: whatsAppRawBody,
          signatureHeader: `sha256=${createHmac(
            "sha256",
            META_MESSENGER_APP_SECRET
          )
            .update(whatsAppRawBody)
            .digest("hex")}`,
        })
      ).toMatchObject({ signatureProvider: "whatsapp" });
    } finally {
      process.env.WHATSAPP_APP_SECRET = META_WHATSAPP_APP_SECRET;
    }
    const verified = verifiedBody("messenger", payload);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.payload)).toBe(true);
    expect(
      Object.isFrozen((verified.payload as { entry: unknown[] }).entry)
    ).toBe(true);
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          {
            signatureProvider: "messenger",
            payload,
          } as unknown as VerifiedMetaWebhookBodyV2,
          sealerDeps().deps
        ),
      "signature_verification_failed"
    );
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          {
            ...verified,
            payload: whatsAppPayload({ messages: [] }),
          } as VerifiedMetaWebhookBodyV2,
          sealerDeps().deps
        ),
      "signature_verification_failed"
    );
  });

  it("seals and verifies one minimal allowlisted Messenger event", async () => {
    const rawSenderSentinel = SENDER_1;
    const rawUrlSentinel = "https://lookaside.example/private-image.jpg";
    const event = messengerMessage({
      messageId: "mid.private-1",
      message: {
        quick_reply: { payload: "GENERATE_IMAGE", ignored: "drop-me" },
        attachments: [
          {
            type: "IMAGE",
            payload: {
              url: rawUrlSentinel,
              mime_type: "image/jpeg",
              sticker_id: "ignored",
            },
            ignored: "drop-me",
          },
          { type: "future-provider-type", payload: {} },
        ],
        ignored: "drop-me",
      },
    });
    const { deps, resolveIdentity } = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([event])),
      deps
    );

    expect(batch.kind).toBe("sealed");
    expect(batch.units).toHaveLength(1);
    const unit = batch.units[0]!;
    expect(unit).toMatchObject({
      version: 2,
      payloadKind: "meta_messenger_event",
      payloadEncoding: "base64url",
      replayClaimId: claimId(1),
    });
    expect(unit.authenticationTag).toMatch(/^i2\.k1\.[0-9a-f]{64}$/);
    expect(unit.boundary.authenticationTag).toMatch(/^e2\.k1\.[0-9a-f]{64}$/);
    expect(JSON.stringify(unit.boundary)).not.toContain(rawSenderSentinel);
    expect(JSON.stringify(unit.boundary)).not.toContain(rawUrlSentinel);
    expect(resolveIdentity).toHaveBeenCalledOnce();

    const verified = await verifyUnit(unit);
    expect(verified.payload).toEqual({
      version: 2,
      channel: "messenger",
      endpoint: { pageId: PAGE_1 },
      senderId: SENDER_1,
      event: {
        kind: "message",
        messageId: "mid.private-1",
        timestamp: 1_775_000_000_000,
        locale: "nl_BE",
        text: "Maak een rustige poster",
        quickReplyPayload: "GENERATE_IMAGE",
        attachments: [
          {
            type: "image",
            url: rawUrlSentinel,
            mimeType: "image/jpeg",
          },
          { type: "unknown" },
        ],
      },
    });
    expect(verified.eventIdentity).toEqual({
      kind: "meta_message_id",
      id: "mid.private-1",
    });
    expect(requireVerifiedIngressReplayInputV2(verified)).toMatchObject({
      replayClaimId: claimId(1),
      eventIdentity: { kind: "meta_message_id", id: "mid.private-1" },
    });
    expect(Object.isFrozen(unit)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it("preserves deterministic multi-Page order and tenant isolation", async () => {
    const body = {
      object: "page",
      entry: [
        { id: PAGE_1, messaging: [messengerMessage()] },
        {
          id: PAGE_2,
          messaging: [
            messengerMessage({
              pageId: PAGE_2,
              senderId: SENDER_2,
              messageId: "mid.page-2",
            }),
          ],
        },
      ],
    };
    const { deps, resolveIdentity } = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", body),
      deps
    );

    expect(batch.units).toHaveLength(2);
    expect(resolveIdentity.mock.calls.map(call => call[0])).toMatchObject([
      { channel: "messenger", pageId: PAGE_1 },
      { channel: "messenger", pageId: PAGE_2 },
    ]);
    expect(batch.units[0]!.boundary.workspaceId).toBe(42);
    expect(batch.units[1]!.boundary.workspaceId).toBe(43);
    expect(batch.units[0]!.boundary.bindingKey).not.toBe(
      batch.units[1]!.boundary.bindingKey
    );
  });

  it("does not mint subjects for Messenger metadata-only events", async () => {
    const events = [
      {
        sender: { id: PAGE_1 },
        recipient: { id: SENDER_1 },
        message: { is_echo: true, mid: "mid.echo" },
      },
      { sender: { id: SENDER_1 }, recipient: { id: PAGE_1 }, delivery: {} },
      { sender: { id: SENDER_1 }, recipient: { id: PAGE_1 }, read: {} },
      { sender: { id: SENDER_1 }, recipient: { id: PAGE_1 }, referral: {} },
    ];
    const tracked = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload(events)),
      tracked.deps
    );

    expect(batch).toMatchObject({
      kind: "empty",
      units: [],
      ignored: {
        messengerEchoes: 1,
        messengerDeliveries: 1,
        messengerReads: 1,
        messengerReferrals: 1,
      },
    });
    expect(tracked.getIdentityKey).not.toHaveBeenCalled();
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
    expect(tracked.createReplayClaimId).not.toHaveBeenCalled();
  });

  it("rejects a Messenger postback without a stable timestamp", async () => {
    const tracked = sealerDeps();
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody(
            "messenger",
            messengerPayload([
              {
                sender: { id: SENDER_1, locale: "nl_BE" },
                recipient: { id: PAGE_1 },
                postback: { payload: "CONTINUE" },
              },
            ])
          ),
          tracked.deps
        ),
      "invalid_event"
    );
    expect(tracked.getIdentityKey).not.toHaveBeenCalled();
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
  });

  it("rejects the whole Messenger batch before resolution on endpoint mismatch", async () => {
    const tracked = sealerDeps();
    const body = messengerPayload([
      messengerMessage(),
      {
        ...messengerMessage({ messageId: "mid.invalid" }),
        recipient: { id: PAGE_2 },
      },
    ]);

    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody("messenger", body),
          tracked.deps
        ),
      "invalid_endpoint_context"
    );
    expect(tracked.getIdentityKey).not.toHaveBeenCalled();
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "mixed primary kinds",
      event: { ...messengerMessage(), delivery: {} },
      code: "invalid_event",
    },
    {
      name: "noncanonical Page ID",
      event: messengerMessage({ pageId: ` ${PAGE_1}` }),
      pageId: ` ${PAGE_1}`,
      code: "invalid_endpoint_context",
    },
    {
      name: "missing fallback timestamp",
      event: (() => {
        const event = messengerMessage({ messageId: "", timestamp: 1 });
        delete (event as { timestamp?: number }).timestamp;
        return event;
      })(),
      code: "invalid_event",
    },
  ])("rejects Messenger $name", async ({ event, pageId, code }) => {
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody("messenger", messengerPayload([event], pageId)),
          sealerDeps().deps
        ),
      code
    );
  });

  it("creates stable fallback replay identity independent of provider key order", async () => {
    const first = messengerMessage({ messageId: "", timestamp: 1234 });
    const second = {
      message: {
        text: "Maak een rustige poster",
      },
      timestamp: 1234,
      recipient: { id: PAGE_1 },
      sender: { locale: "nl_BE", id: SENDER_1 },
    };
    const firstBatch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([first])),
      sealerDeps({ claimIds: [claimId(9)] }).deps
    );
    const secondBatch =
      await sealVerifiedMetaConversationIngressBatchV2WithDeps(
        verifiedBody("messenger", messengerPayload([second])),
        sealerDeps({ claimIds: [claimId(9)] }).deps
      );
    const firstUnit = firstBatch.units[0]!;
    const secondUnit = secondBatch.units[0]!;

    expect(firstUnit.payloadBytes).toBe(secondUnit.payloadBytes);
    const firstVerified = await verifyUnit(firstUnit);
    const secondVerified = await verifyUnit(secondUnit);
    expect(firstVerified.eventIdentity).toEqual(secondVerified.eventIdentity);
    expect(firstVerified.eventIdentity).toMatchObject({
      kind: "canonical_fallback_sha256",
    });
  });

  it("seals each WhatsApp message with its own WABA, phone and sender", async () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA_1,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_1 },
                messages: [
                  whatsAppMessage(),
                  whatsAppMessage({
                    senderId: SENDER_2,
                    messageId: "wamid.second",
                    type: "voice",
                    extra: {
                      voice: { id: "voice-private-1" },
                      text: undefined,
                    },
                  }),
                ],
                statuses: [{ id: "raw-status-id" }],
              },
            },
          ],
        },
        {
          id: WABA_2,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_2 },
                messages: [
                  whatsAppMessage({
                    senderId: "447700900123",
                    messageId: "wamid.third",
                  }),
                ],
              },
            },
          ],
        },
      ],
    };
    const tracked = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("whatsapp", body),
      tracked.deps
    );

    expect(batch.units).toHaveLength(3);
    expect(batch.ignored.whatsappStatuses).toBe(1);
    expect(
      tracked.resolveIdentity.mock.calls.map(call => call[0])
    ).toMatchObject([
      { channel: "whatsapp", wabaId: WABA_1, phoneNumberId: PHONE_1 },
      { channel: "whatsapp", wabaId: WABA_1, phoneNumberId: PHONE_1 },
      { channel: "whatsapp", wabaId: WABA_2, phoneNumberId: PHONE_2 },
    ]);
    const voice = await verifyUnit(batch.units[1]!);
    expect(voice.payload).toMatchObject({
      channel: "whatsapp",
      senderId: SENDER_2,
      event: { kind: "audio", mediaId: "voice-private-1" },
    });
  });

  it("preserves each WhatsApp change-specific phone endpoint under one WABA", async () => {
    const tracked = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("whatsapp", {
        object: "whatsapp_business_account",
        entry: [
          {
            id: WABA_1,
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_1 },
                  messages: [whatsAppMessage()],
                },
              },
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: PHONE_2 },
                  messages: [
                    whatsAppMessage({
                      senderId: SENDER_2,
                      messageId: "wamid.phone-2",
                    }),
                  ],
                },
              },
            ],
          },
        ],
      }),
      tracked.deps
    );

    expect(batch.units).toHaveLength(2);
    expect(tracked.resolveIdentity.mock.calls.map(call => call[0])).toEqual([
      { channel: "whatsapp", wabaId: WABA_1, phoneNumberId: PHONE_1 },
      { channel: "whatsapp", wabaId: WABA_1, phoneNumberId: PHONE_2 },
    ]);
  });

  it.each([
    {
      name: "text without a body",
      message: whatsAppMessage({ extra: { text: {} } }),
      expected: { kind: "text", messageId: "wamid.default-1" },
    },
    {
      name: "interactive title without an id",
      message: whatsAppMessage({
        type: "interactive",
        extra: {
          text: undefined,
          interactive: { button_reply: { title: "Ga verder" } },
        },
      }),
      expected: {
        kind: "interactive",
        messageId: "wamid.default-1",
        interactiveReplyTitle: "Ga verder",
      },
    },
    {
      name: "an empty interactive reply",
      message: whatsAppMessage({
        type: "interactive",
        extra: {
          text: undefined,
          interactive: { button_reply: {} },
        },
      }),
      expected: { kind: "interactive", messageId: "wamid.default-1" },
    },
  ])("round-trips WhatsApp $name", async ({ message, expected }) => {
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("whatsapp", whatsAppPayload({ messages: [message] })),
      sealerDeps().deps
    );

    expect(batch.units).toHaveLength(1);
    const verified = await verifyUnit(batch.units[0]!);
    expect(verified.payload.event).toMatchObject(expected);
  });

  it("keeps WhatsApp status-only deliveries metadata-only", async () => {
    const tracked = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody(
        "whatsapp",
        whatsAppPayload({
          statuses: [
            { id: "raw-id-1", recipient_id: SENDER_1 },
            { id: "raw-id-2", recipient_id: SENDER_2 },
          ],
        })
      ),
      tracked.deps
    );

    expect(batch).toMatchObject({
      kind: "empty",
      units: [],
      ignored: { whatsappStatuses: 2 },
    });
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
  });

  it("does not require or resolve endpoint metadata for status-only delivery", async () => {
    const tracked = sealerDeps();
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("whatsapp", {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: { statuses: [{ id: "status-only" }] },
              },
            ],
          },
        ],
      }),
      tracked.deps
    );

    expect(batch).toMatchObject({
      kind: "empty",
      units: [],
      ignored: { whatsappStatuses: 1 },
    });
    expect(tracked.getIdentityKey).not.toHaveBeenCalled();
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
    expect(tracked.createReplayClaimId).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing phone",
      payload: whatsAppPayload({
        phoneNumberId: "",
        messages: [whatsAppMessage()],
      }),
      code: "invalid_endpoint_context",
    },
    {
      name: "missing sender",
      payload: whatsAppPayload({
        messages: [{ ...whatsAppMessage(), from: undefined }],
      }),
      code: "invalid_sender",
    },
    {
      name: "ambiguous interactive reply",
      payload: whatsAppPayload({
        messages: [
          whatsAppMessage({
            type: "interactive",
            extra: {
              interactive: {
                button_reply: { id: "a" },
                list_reply: { id: "b" },
              },
            },
          }),
        ],
      }),
      code: "invalid_event",
    },
    {
      name: "unknown message type without a provider id",
      payload: whatsAppPayload({
        messages: [
          whatsAppMessage({
            messageId: "",
            type: "future-provider-type",
          }),
        ],
      }),
      code: "invalid_event",
    },
  ])("rejects WhatsApp $name", async ({ payload, code }) => {
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody("whatsapp", payload),
          sealerDeps().deps
        ),
      code
    );
  });

  it("bounds provider arrays before identity or key lookup", async () => {
    const tracked = sealerDeps();
    const entries = Array.from({ length: 101 }, () => ({
      id: PAGE_1,
      messaging: [],
    }));

    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody("messenger", { object: "page", entry: entries }),
          tracked.deps
        ),
      "batch_too_large"
    );
    expect(tracked.getIdentityKey).not.toHaveBeenCalled();
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
    expect(tracked.createReplayClaimId).not.toHaveBeenCalled();
  });

  it("accepts exactly 100 events but rejects 101 aggregated events", async () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      messengerMessage({ messageId: `mid.batch-${index}` })
    );
    const accepted = sealerDeps({
      claimIds: Array.from({ length: 100 }, (_, index) => claimId(index + 1)),
    });
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload(events)),
      accepted.deps
    );
    expect(batch.units).toHaveLength(100);

    const rejected = sealerDeps();
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody("messenger", {
            object: "page",
            entry: [
              { id: PAGE_1, messaging: events },
              {
                id: PAGE_1,
                messaging: [messengerMessage({ messageId: "mid.batch-100" })],
              },
            ],
          }),
          rejected.deps
        ),
      "batch_too_large"
    );
    expect(rejected.getIdentityKey).not.toHaveBeenCalled();
    expect(rejected.resolveIdentity).not.toHaveBeenCalled();
    expect(rejected.createReplayClaimId).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "messenger" as const,
      payload: whatsAppPayload({ messages: [] }),
    },
    {
      provider: "whatsapp" as const,
      payload: messengerPayload([]),
    },
  ])("rejects a $provider signature-provider/root mismatch", async input => {
    const tracked = sealerDeps();
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody(input.provider, input.payload),
          tracked.deps
        ),
      "provider_mismatch"
    );
    expect(tracked.getIdentityKey).not.toHaveBeenCalled();
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
    expect(tracked.createReplayClaimId).not.toHaveBeenCalled();
  });

  it("authenticates replay claim, payload and boundary as one unit", async () => {
    const first = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([messengerMessage()])),
      sealerDeps({ claimIds: [claimId(1)] }).deps
    );
    const second = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody(
        "messenger",
        messengerPayload([
          messengerMessage({ senderId: SENDER_2, messageId: "mid.second" }),
        ])
      ),
      sealerDeps({ claimIds: [claimId(2)] }).deps
    );
    const unit = first.units[0]!;
    const other = second.units[0]!;

    for (const tampered of [
      { ...unit, replayClaimId: claimId(2) },
      { ...unit, payloadBytes: other.payloadBytes },
      { ...unit, boundary: other.boundary },
      {
        ...unit,
        authenticationTag: unit.authenticationTag.replace(/.$/, "0"),
      },
    ]) {
      await expectIngressError(
        () => verifyUnit(tampered as MetaConversationIngressUnitV2),
        "unit_authentication_failed"
      );
    }
  });

  it("rejects physical scope transplant after authenticating the unit", async () => {
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([messengerMessage()])),
      sealerDeps().deps
    );
    const unit = batch.units[0]!;
    const otherBatch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody(
        "messenger",
        messengerPayload(
          [messengerMessage({ pageId: PAGE_2, senderId: SENDER_2 })],
          PAGE_2
        )
      ),
      sealerDeps().deps
    );

    await expect(
      verifyUnit(unit, { expectedScope: scope(otherBatch.units[0]!) })
    ).rejects.toMatchObject({
      name: "ConversationBoundaryEnvelopeError",
      code: "scope_mismatch",
    });
  });

  it("rejects stale reassigned bindings during authoritative verification", async () => {
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([messengerMessage()])),
      sealerDeps().deps
    );
    const unit = batch.units[0]!;

    await expect(
      verifyUnit(unit, {
        resolveIdentity: async (endpoint, senderId) =>
          resolvedIdentity(endpoint, senderId, KEY, {
            workspaceId: 99,
            channelConnectionId: 7,
          }),
      })
    ).rejects.toMatchObject({
      name: "ConversationBoundaryEnvelopeError",
      code: "binding_reassigned",
    });
  });

  it("rejects same-key secret drift and unknown key epochs before DB lookup", async () => {
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([messengerMessage()])),
      sealerDeps().deps
    );
    const unit = batch.units[0]!;
    const resolver = vi.fn(async (endpoint, senderId) =>
      resolvedIdentity(endpoint, senderId)
    );

    await expectIngressError(
      () => verifyUnit(unit, { key: DRIFTED_KEY, resolveIdentity: resolver }),
      "unit_authentication_failed"
    );
    await expectIngressError(
      () => verifyUnit(unit, { key: NEW_EPOCH_KEY, resolveIdentity: resolver }),
      "unit_authentication_failed"
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("strictly parses the persisted unit wrapper", async () => {
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([messengerMessage()])),
      sealerDeps().deps
    );
    const unit = batch.units[0]!;
    expect(parseMetaConversationIngressUnitV2(unit)).toEqual(unit);

    for (const invalid of [
      { ...unit, version: 3 },
      { ...unit, extra: true },
      { ...unit, payloadEncoding: "base64" },
      { ...unit, payloadBytes: `${unit.payloadBytes}=` },
      { ...unit, payloadBytes: "A".repeat(349_527) },
      { ...unit, replayClaimId: "rc2.invalid" },
    ]) {
      await expectIngressError(
        () => parseMetaConversationIngressUnitV2(invalid),
        "invalid_unit"
      );
    }
  });

  it("rejects noncanonical and invalid UTF-8 payload bytes", async () => {
    const canonical = JSON.stringify({
      version: 2,
      channel: "messenger",
      endpoint: { pageId: PAGE_1 },
      senderId: SENDER_1,
      event: {
        kind: "message",
        messageId: "mid-1",
        attachments: [],
      },
    });
    await expectIngressError(
      () =>
        decodeMetaConversationPayloadV2(
          "meta_messenger_event",
          Buffer.from(` ${canonical}`, "utf8")
        ),
      "noncanonical_payload"
    );
    await expectIngressError(
      () =>
        decodeMetaConversationPayloadV2(
          "meta_messenger_event",
          Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(canonical),
          ])
        ),
      "noncanonical_payload"
    );
    await expectIngressError(
      () =>
        decodeMetaConversationPayloadV2(
          "meta_messenger_event",
          Buffer.from([0xff, 0xfe])
        ),
      "invalid_payload_encoding"
    );
  });

  it.each([
    {
      name: "an unknown payload kind",
      payloadKind: "meta_unknown_event",
      payload: {
        version: 2,
        channel: "messenger",
        endpoint: { pageId: PAGE_1 },
        senderId: SENDER_1,
        event: { kind: "message", messageId: "mid-1", attachments: [] },
      },
    },
    {
      name: "Messenger bytes labeled as WhatsApp",
      payloadKind: "meta_whatsapp_message",
      payload: {
        version: 2,
        channel: "messenger",
        endpoint: { pageId: PAGE_1 },
        senderId: SENDER_1,
        event: { kind: "message", messageId: "mid-1", attachments: [] },
      },
    },
    {
      name: "WhatsApp bytes labeled as Messenger",
      payloadKind: "meta_messenger_event",
      payload: {
        version: 2,
        channel: "whatsapp",
        endpoint: { wabaId: WABA_1, phoneNumberId: PHONE_1 },
        senderId: SENDER_1,
        event: {
          kind: "text",
          messageId: "wamid-1",
          textBody: "hello",
        },
      },
    },
  ])("rejects $name", async ({ payloadKind, payload }) => {
    await expectIngressError(
      () =>
        decodeMetaConversationPayloadV2(
          payloadKind as "meta_messenger_event",
          Buffer.from(JSON.stringify(payload), "utf8")
        ),
      "noncanonical_payload"
    );
  });

  it.each([
    {
      kind: "text",
      extra: { mediaId: "media-1" },
    },
    {
      kind: "interactive",
      extra: { textBody: "ambiguous" },
    },
    {
      kind: "image",
      extra: { textBody: "ambiguous" },
    },
    {
      kind: "unknown",
      extra: { mediaId: "media-1" },
    },
  ])("rejects contradictory WhatsApp $kind bytes", async ({ kind, extra }) => {
    await expectIngressError(
      () =>
        decodeMetaConversationPayloadV2(
          "meta_whatsapp_message",
          Buffer.from(
            JSON.stringify({
              version: 2,
              channel: "whatsapp",
              endpoint: { wabaId: WABA_1, phoneNumberId: PHONE_1 },
              senderId: SENDER_1,
              event: { kind, messageId: "wamid-1", ...extra },
            }),
            "utf8"
          )
        ),
      "noncanonical_payload"
    );
  });

  it("fails all-or-nothing on duplicate claim IDs before identity reads", async () => {
    const duplicate = claimId(7);
    const tracked = sealerDeps({ claimIds: [duplicate, duplicate] });
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody(
            "messenger",
            messengerPayload([
              messengerMessage(),
              messengerMessage({ senderId: SENDER_2, messageId: "mid-2" }),
            ])
          ),
          tracked.deps
        ),
      "claim_id_unavailable",
      true
    );
    expect(tracked.resolveIdentity).not.toHaveBeenCalled();
  });

  it("fails the whole batch when the second identity resolution rejects", async () => {
    let resolution = 0;
    const tracked = sealerDeps({
      resolveIdentity: async (endpoint, senderId) => {
        resolution += 1;
        if (resolution === 2) {
          throw new ConversationIdentityError("binding_not_found");
        }
        return resolvedIdentity(endpoint, senderId);
      },
    });

    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          verifiedBody(
            "messenger",
            messengerPayload([
              messengerMessage(),
              messengerMessage({ senderId: SENDER_2, messageId: "mid-2" }),
            ])
          ),
          tracked.deps
        ),
      "identity_rejected"
    );
    expect(tracked.resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it("maps unavailable key, claim and identity dependencies without raw values", async () => {
    const body = verifiedBody(
      "messenger",
      messengerPayload([messengerMessage()])
    );
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          body,
          sealerDeps({ keyError: new Error("raw-key-sentinel") }).deps
        ),
      "key_unavailable",
      true,
      ["raw-key-sentinel"]
    );
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          body,
          sealerDeps({ claimError: new Error("raw-claim-sentinel") }).deps
        ),
      "claim_id_unavailable",
      true,
      ["raw-claim-sentinel"]
    );
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          body,
          sealerDeps({
            resolveIdentity: async () => {
              throw new ConversationIdentityError(
                "binding_lookup_failed",
                true
              );
            },
          }).deps
        ),
      "identity_unavailable",
      true
    );
    await expectIngressError(
      () =>
        sealVerifiedMetaConversationIngressBatchV2WithDeps(
          body,
          sealerDeps({
            resolveIdentity: async () => {
              throw new ConversationIdentityError("binding_lookup_failed");
            },
          }).deps
        ),
      "identity_unavailable"
    );
  });

  it("does not accept a structurally forged verified ingress result", async () => {
    await expectIngressError(
      () =>
        requireVerifiedIngressReplayInputV2(
          {} as VerifiedMetaConversationIngressUnitV2
        ),
      "invalid_unit"
    );

    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody("messenger", messengerPayload([messengerMessage()])),
      sealerDeps().deps
    );
    const verified = await verifyUnit(batch.units[0]!);
    const reflectedClone = {
      ...verified,
      replayClaimId: claimId(9),
    };
    for (const symbol of Object.getOwnPropertySymbols(verified)) {
      Object.defineProperty(reflectedClone, symbol, {
        value: Reflect.get(verified, symbol),
      });
    }
    await expectIngressError(
      () =>
        requireVerifiedIngressReplayInputV2(
          reflectedClone as VerifiedMetaConversationIngressUnitV2
        ),
      "invalid_unit"
    );
  });

  it("pins a full deterministic unit authentication vector", async () => {
    const batch = await sealVerifiedMetaConversationIngressBatchV2WithDeps(
      verifiedBody(
        "messenger",
        messengerPayload([
          messengerMessage({ messageId: "mid.golden", timestamp: 1234 }),
        ])
      ),
      sealerDeps({ claimIds: [claimId(15)] }).deps
    );
    const unit = batch.units[0]!;
    expect(unit.payloadBytes).toBe(
      "eyJ2ZXJzaW9uIjoyLCJjaGFubmVsIjoibWVzc2VuZ2VyIiwiZW5kcG9pbnQiOnsicGFnZUlkIjoiMTIzNDU2Nzg5MDEyMzQ1In0sInNlbmRlcklkIjoiOTg3NjU0MzIxMDk4NzY1IiwiZXZlbnQiOnsia2luZCI6Im1lc3NhZ2UiLCJtZXNzYWdlSWQiOiJtaWQuZ29sZGVuIiwidGltZXN0YW1wIjoxMjM0LCJsb2NhbGUiOiJubF9CRSIsInRleHQiOiJNYWFrIGVlbiBydXN0aWdlIHBvc3RlciIsImF0dGFjaG1lbnRzIjpbXX19"
    );
    expect(unit.authenticationTag).toBe(
      "i2.k1.4b1755238b1777924b4e8b4b9d29e8aa93201e3ca9de6f4cebc0ee2999f41aaa"
    );
  });
});
