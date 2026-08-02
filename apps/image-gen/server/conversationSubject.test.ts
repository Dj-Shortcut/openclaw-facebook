import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseConversationIdentityConfig,
  type ConversationIdentityKey,
} from "./_core/conversationIdentityConfig";
import {
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
} from "./_core/conversationEndpoint";
import { deriveConversationSubjectV2 } from "./_core/conversationSubject";

const TEST_SECRET =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TEST_KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: TEST_SECRET,
});

function messengerSubject(
  overrides: {
    workspaceId?: number;
    channelConnectionId?: number;
    pageId?: string;
    senderId?: string;
    key?: ConversationIdentityKey;
  } = {}
) {
  return deriveConversationSubjectV2({
    workspaceId: overrides.workspaceId ?? 42,
    channelConnectionId: overrides.channelConnectionId ?? 7,
    endpoint: resolveMessengerEndpoint({
      entryId: overrides.pageId ?? "123456789012345",
    }),
    senderId: overrides.senderId ?? "987654321098765",
    key: overrides.key ?? TEST_KEY,
  });
}

function whatsappSubject(
  overrides: {
    workspaceId?: number;
    channelConnectionId?: number;
    wabaId?: string;
    phoneNumberId?: string;
    senderId?: string;
  } = {}
) {
  return deriveConversationSubjectV2({
    workspaceId: overrides.workspaceId ?? 42,
    channelConnectionId: overrides.channelConnectionId ?? 7,
    endpoint: resolveWhatsAppEndpoint({
      wabaId: overrides.wabaId ?? "123456789012345",
      phoneNumberId: overrides.phoneNumberId ?? "555555555555555",
    }),
    senderId: overrides.senderId ?? "987654321098765",
    key: TEST_KEY,
  });
}

describe("ConversationSubjectV2", () => {
  it("matches the fixed cross-implementation golden vector", () => {
    const subject = messengerSubject();

    expect(subject).toEqual({
      version: 2,
      keyId: "k1",
      workspaceId: 42,
      channel: "messenger",
      channelConnectionId: 7,
      tenantKey:
        "t2.k1.17f221b2e04f85ef949966c8e04e3f59e7ff05454a11278e98141e9f8cca5788",
      bindingKey:
        "b2.k1.192af338c114baffc2ab1bb61bc0df4009b3849eee42bbf3c32947284a500ddc",
      userKey:
        "u2.k1.7f85c44e9a5fabb61fdc537bdbef9d1845637928d9b66a3f45e43a848cf3de42",
    });
  });

  it("returns an immutable subject", () => {
    const subject = messengerSubject();

    expect(Object.isFrozen(subject)).toBe(true);
    expect(() => {
      (subject as { channel: string }).channel = "whatsapp";
    }).toThrow(TypeError);
    expect(subject.channel).toBe("messenger");
  });

  it("isolates the same sender across workspace, Page, connection, and channel", () => {
    const baseline = messengerSubject();
    const sameInput = messengerSubject();
    const otherWorkspace = messengerSubject({ workspaceId: 43 });
    const otherPage = messengerSubject({ pageId: "223456789012345" });
    const otherConnection = messengerSubject({ channelConnectionId: 8 });
    const otherChannel = whatsappSubject();

    expect(sameInput).toEqual(baseline);

    expect(otherWorkspace.tenantKey).not.toBe(baseline.tenantKey);
    expect(otherWorkspace.bindingKey).not.toBe(baseline.bindingKey);
    expect(otherWorkspace.userKey).not.toBe(baseline.userKey);

    expect(otherPage.tenantKey).toBe(baseline.tenantKey);
    expect(otherPage.bindingKey).not.toBe(baseline.bindingKey);
    expect(otherPage.userKey).not.toBe(baseline.userKey);

    expect(otherConnection.tenantKey).toBe(baseline.tenantKey);
    expect(otherConnection.bindingKey).not.toBe(baseline.bindingKey);
    expect(otherConnection.userKey).not.toBe(baseline.userKey);

    expect(otherChannel.tenantKey).toBe(baseline.tenantKey);
    expect(otherChannel.bindingKey).not.toBe(baseline.bindingKey);
    expect(otherChannel.userKey).not.toBe(baseline.userKey);
  });

  it("does not expose raw provider endpoint or sender identifiers", () => {
    const messengerPageId = "12345678901234567890123456789012";
    const messengerSenderId = "98765432109876543210987654321098";
    const whatsappWabaId = "22345678901234567890123456789012";
    const whatsappPhoneNumberId = "32345678901234567890123456789012";
    const whatsappSenderId = "42345678901234567890123456789012";
    const messenger = messengerSubject({
      pageId: messengerPageId,
      senderId: messengerSenderId,
    });
    const whatsapp = whatsappSubject({
      wabaId: whatsappWabaId,
      phoneNumberId: whatsappPhoneNumberId,
      senderId: whatsappSenderId,
    });
    const serializedSubjects = JSON.stringify([messenger, whatsapp]);

    expect(serializedSubjects).not.toContain(messengerPageId);
    expect(serializedSubjects).not.toContain(messengerSenderId);
    expect(serializedSubjects).not.toContain(whatsappWabaId);
    expect(serializedSubjects).not.toContain(whatsappPhoneNumberId);
    expect(serializedSubjects).not.toContain(whatsappSenderId);
    expect(messenger).not.toHaveProperty("pageId");
    expect(messenger).not.toHaveProperty("senderId");
    expect(whatsapp).not.toHaveProperty("wabaId");
    expect(whatsapp).not.toHaveProperty("phoneNumberId");
    expect(whatsapp).not.toHaveProperty("senderId");
  });

  it("uses purpose-separated, length-prefixed TLV framing", () => {
    const payloads: Buffer[] = [];
    const capturingKey: ConversationIdentityKey = {
      keyId: TEST_KEY.keyId,
      sign(payload): Buffer {
        const copy = Buffer.from(payload);
        payloads.push(copy);
        return createHash("sha256").update(copy).digest();
      },
    };

    messengerSubject({ key: capturingKey });

    expect(payloads).toHaveLength(3);
    expect(payloads.map(payload => decodeCanonicalInput(payload))).toEqual([
      {
        version: 2,
        purpose: 1,
        keyId: "k1",
        fields: [{ tag: 1, length: 8 }],
      },
      {
        version: 2,
        purpose: 2,
        keyId: "k1",
        fields: [
          { tag: 1, length: 8 },
          { tag: 2, length: 1 },
          { tag: 3, length: 8 },
          { tag: 4, length: 15 },
        ],
      },
      {
        version: 2,
        purpose: 3,
        keyId: "k1",
        fields: [
          { tag: 1, length: 8 },
          { tag: 2, length: 1 },
          { tag: 3, length: 8 },
          { tag: 4, length: 32 },
          { tag: 5, length: 15 },
        ],
      },
    ]);
  });
});

function decodeCanonicalInput(payload: Buffer): {
  version: number;
  purpose: number;
  keyId: string;
  fields: Array<{ tag: number; length: number }>;
} {
  const magic = Buffer.from("leaderbot.conversation.identity\0", "ascii");
  expect(payload.subarray(0, magic.length)).toEqual(magic);

  let offset = magic.length;
  const version = payload[offset++];
  const purpose = payload[offset++];
  const keyIdLength = payload.readUInt32BE(offset);
  offset += 4;
  const keyId = payload.subarray(offset, offset + keyIdLength).toString("utf8");
  offset += keyIdLength;

  const fields: Array<{ tag: number; length: number }> = [];
  while (offset < payload.length) {
    const tag = payload[offset++];
    const length = payload.readUInt32BE(offset);
    offset += 4;
    fields.push({ tag, length });
    offset += length;
  }
  expect(offset).toBe(payload.length);

  return { version, purpose, keyId, fields };
}
