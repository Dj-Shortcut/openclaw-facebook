import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const databaseMocks = vi.hoisted(() => ({
  getDatabaseOrThrow: vi.fn(),
  select: vi.fn(),
}));

vi.mock("./db", () => ({
  getDatabaseOrThrow: databaseMocks.getDatabaseOrThrow,
}));

import { channelConnections } from "../drizzle/schema";
import { resetConversationIdentityConfigForTests } from "./_core/conversationIdentityConfig";
import {
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
} from "./_core/conversationEndpoint";
import { resolveConversationIdentityV2 } from "./_core/conversationIdentityResolver";

const originalKeyId = process.env.CONVERSATION_SCOPE_HMAC_KEY_ID;
const originalSecret = process.env.CONVERSATION_SCOPE_HMAC_SECRET;

function mockBindingQuery(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn((_predicate: SQL) => ({ limit }));
  const from = vi.fn(() => ({ where }));
  databaseMocks.select.mockReturnValue({ from });
  databaseMocks.getDatabaseOrThrow.mockResolvedValue({
    select: databaseMocks.select,
  });
  return { from, limit, where };
}

const mysqlDialect = new MySqlDialect();

function serializePredicate(predicate: SQL | undefined): {
  sql: string;
  params: unknown[];
} {
  if (!predicate) {
    throw new Error("Expected a database predicate");
  }
  const query = mysqlDialect.sqlToQuery(predicate);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONVERSATION_SCOPE_HMAC_KEY_ID = "k1";
  process.env.CONVERSATION_SCOPE_HMAC_SECRET = "22".repeat(32);
  resetConversationIdentityConfigForTests();
});

afterEach(() => {
  resetConversationIdentityConfigForTests();
  if (originalKeyId === undefined) {
    delete process.env.CONVERSATION_SCOPE_HMAC_KEY_ID;
  } else {
    process.env.CONVERSATION_SCOPE_HMAC_KEY_ID = originalKeyId;
  }
  if (originalSecret === undefined) {
    delete process.env.CONVERSATION_SCOPE_HMAC_SECRET;
  } else {
    process.env.CONVERSATION_SCOPE_HMAC_SECRET = originalSecret;
  }
});

describe("conversation identity database adapter", () => {
  it("selects only the Messenger binding boundary and caps ambiguity reads", async () => {
    const query = mockBindingQuery([
      {
        id: 7,
        workspaceId: 42,
        channel: "facebook_messenger",
        status: "connected",
        externalId: "123456789012345",
        providerAccountExternalId: null,
      },
    ]);

    const resolved = await resolveConversationIdentityV2(
      resolveMessengerEndpoint({ entryId: "123456789012345" }),
      "987654321098765"
    );

    expect(resolved.subject).toMatchObject({
      workspaceId: 42,
      channelConnectionId: 7,
      channel: "messenger",
    });
    expect(databaseMocks.getDatabaseOrThrow).toHaveBeenCalledOnce();
    expect(query.where).toHaveBeenCalledOnce();
    const messengerPredicate = query.where.mock.calls[0]?.[0];
    const expectedMessengerPredicate = and(
      eq(channelConnections.channel, "facebook_messenger"),
      eq(channelConnections.externalId, "123456789012345"),
      isNull(channelConnections.providerAccountExternalId)
    );
    expect(serializePredicate(messengerPredicate)).toEqual(
      serializePredicate(expectedMessengerPredicate)
    );
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(databaseMocks.select).toHaveBeenCalledWith({
      id: expect.anything(),
      workspaceId: expect.anything(),
      channel: expect.anything(),
      status: expect.anything(),
      externalId: expect.anything(),
      providerAccountExternalId: expect.anything(),
    });
    expect(
      Object.keys(databaseMocks.select.mock.calls[0]?.[0] ?? {})
    ).not.toContain("encryptedAccessToken");
  });

  it("requires both WhatsApp provider-account and phone-number fields", async () => {
    const query = mockBindingQuery([
      {
        id: 8,
        workspaceId: 84,
        channel: "whatsapp",
        status: "webhook_unhealthy",
        externalId: "444444444444444",
        providerAccountExternalId: "333333333333333",
      },
    ]);

    const resolved = await resolveConversationIdentityV2(
      resolveWhatsAppEndpoint({
        wabaId: "333333333333333",
        phoneNumberId: "444444444444444",
      }),
      "32470000001"
    );

    expect(resolved).toMatchObject({
      subject: { workspaceId: 84, channel: "whatsapp" },
      delivery: null,
      connectionStatus: "webhook_unhealthy",
    });
    expect(query.where).toHaveBeenCalledOnce();
    const whatsappPredicate = query.where.mock.calls[0]?.[0];
    const expectedWhatsAppPredicate = and(
      eq(channelConnections.channel, "whatsapp"),
      eq(channelConnections.externalId, "444444444444444"),
      eq(channelConnections.providerAccountExternalId, "333333333333333")
    );
    expect(serializePredicate(whatsappPredicate)).toEqual(
      serializePredicate(expectedWhatsAppPredicate)
    );
    expect(query.limit).toHaveBeenCalledWith(2);
  });
});
