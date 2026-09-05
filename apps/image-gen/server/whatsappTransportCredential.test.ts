import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const mocks = vi.hoisted(() => ({
  getDatabaseOrThrow: vi.fn(),
  unsealFacebookPageToken: vi.fn(),
  assertMessengerErasureControlDelivery: vi.fn(),
  assertMessengerPrivacySubject: vi.fn(),
}));

vi.mock("./db", () => ({
  getDatabaseOrThrow: mocks.getDatabaseOrThrow,
}));

vi.mock("./_core/facebookPageToken", () => ({
  unsealFacebookPageToken: mocks.unsealFacebookPageToken,
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerErasureControlDelivery:
    mocks.assertMessengerErasureControlDelivery,
  assertMessengerPrivacySubject: mocks.assertMessengerPrivacySubject,
}));

import {
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  resolveWhatsAppTransportCredential,
  WhatsAppTransportBindingError,
} from "./_core/whatsappTransportCredential";
import { channelConnections } from "../drizzle/schema";

const originalNodeEnv = process.env.NODE_ENV;
const originalGlobalToken = process.env.WHATSAPP_ACCESS_TOKEN;
const originalGlobalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

function bindDatabaseRows(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn((_predicate: SQL) => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  mocks.getDatabaseOrThrow.mockResolvedValue({ select });
  return { select, from, where, limit };
}

const mysqlDialect = new MySqlDialect();

function serializePredicate(predicate: SQL | undefined): {
  sql: string;
  params: unknown[];
} {
  if (!predicate) throw new Error("Expected a database predicate");
  const query = mysqlDialect.sqlToQuery(predicate);
  return { sql: query.sql, params: query.params };
}

async function withScope<T>(
  input: {
    phoneNumberId: string;
    workspaceId: number;
    channelConnectionId: number;
    bindingEpoch: number;
    userKey: string;
    privacyEpoch: number;
  },
  action: () => Promise<T>
): Promise<T> {
  return await runWithMessengerRequestContext(
    input.phoneNumberId,
    async () => {
      setMessengerRequestPrivacySubject({
        userKey: input.userKey,
        privacyEpoch: input.privacyEpoch,
      });
      return await action();
    },
    {
      channel: "whatsapp",
      workspaceId: input.workspaceId,
      channelConnectionId: input.channelConnectionId,
      bindingEpoch: input.bindingEpoch,
    }
  );
}

describe("WhatsApp transport credential boundary", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.WHATSAPP_ACCESS_TOKEN = "global-token-must-not-be-used";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "999999999999999";
    mocks.assertMessengerErasureControlDelivery.mockResolvedValue(undefined);
    mocks.assertMessengerPrivacySubject.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalGlobalToken === undefined) {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    } else {
      process.env.WHATSAPP_ACCESS_TOKEN = originalGlobalToken;
    }
    if (originalGlobalPhone === undefined) {
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    } else {
      process.env.WHATSAPP_PHONE_NUMBER_ID = originalGlobalPhone;
    }
  });

  it("opens only the exact connected tenant credential and binding epoch", async () => {
    const query = bindDatabaseRows([
      {
        encryptedAccessToken: "sealed-tenant-a",
        phoneNumberId: "404040404040404",
        wabaId: "303030303030303",
      },
    ]);
    mocks.unsealFacebookPageToken.mockReturnValue("tenant-token-a");

    const credential = await withScope(
      {
        phoneNumberId: "404040404040404",
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: "user-key-a",
        privacyEpoch: 2,
      },
      resolveWhatsAppTransportCredential
    );

    expect(credential).toEqual({
      accessToken: "tenant-token-a",
      phoneNumberId: "404040404040404",
      userKey: "user-key-a",
    });
    expect(Object.isFrozen(credential)).toBe(true);
    expect(query.limit).toHaveBeenCalledWith(2);
    expect(serializePredicate(query.where.mock.calls[0]?.[0])).toEqual(
      serializePredicate(
        and(
          eq(channelConnections.id, 8),
          eq(channelConnections.workspaceId, 42),
          eq(channelConnections.channel, "whatsapp"),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.externalId, "404040404040404"),
          eq(channelConnections.bindingEpoch, 3)
        )
      )
    );
    expect(mocks.assertMessengerPrivacySubject).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: "user-key-a",
      privacyEpoch: 2,
    });
    expect(mocks.unsealFacebookPageToken).toHaveBeenCalledWith(
      "sealed-tenant-a"
    );
  });

  it("permits only the exact erased subject for a deletion outcome", async () => {
    bindDatabaseRows([
      {
        encryptedAccessToken: "sealed-tenant-a",
        phoneNumberId: "404040404040404",
        wabaId: "303030303030303",
      },
    ]);
    mocks.unsealFacebookPageToken.mockReturnValue("tenant-token-a");

    await withScope(
      {
        phoneNumberId: "404040404040404",
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: "user-key-a",
        privacyEpoch: 2,
      },
      () =>
        runWithMessengerErasureControlDelivery(
          resolveWhatsAppTransportCredential
        )
    );

    expect(mocks.assertMessengerErasureControlDelivery).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 8,
      userKey: "user-key-a",
      privacyEpoch: 2,
    });
    expect(mocks.assertMessengerPrivacySubject).not.toHaveBeenCalled();
  });

  it("rejects a disconnected or rebound row instead of using global credentials", async () => {
    bindDatabaseRows([]);

    await expect(
      withScope(
        {
          phoneNumberId: "404040404040404",
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          userKey: "user-key-a",
          privacyEpoch: 2,
        },
        resolveWhatsAppTransportCredential
      )
    ).rejects.toBeInstanceOf(WhatsAppTransportBindingError);

    expect(mocks.unsealFacebookPageToken).not.toHaveBeenCalled();
  });

  it("preserves an unexpected binding failure as the redacted error cause", async () => {
    const databaseError = new TypeError("database temporarily unavailable");
    mocks.getDatabaseOrThrow.mockRejectedValue(databaseError);

    const error = await withScope(
      {
        phoneNumberId: "404040404040404",
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: "user-key-a",
        privacyEpoch: 2,
      },
      resolveWhatsAppTransportCredential
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WhatsAppTransportBindingError);
    expect((error as WhatsAppTransportBindingError).cause).toBe(databaseError);
  });

  it("rejects duplicate matching rows before unsealing a credential", async () => {
    const row = {
      encryptedAccessToken: "sealed-tenant-a",
      phoneNumberId: "404040404040404",
      wabaId: "303030303030303",
    };
    bindDatabaseRows([row, { ...row }]);

    await expect(
      withScope(
        {
          phoneNumberId: row.phoneNumberId,
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          userKey: "user-key-a",
          privacyEpoch: 2,
        },
        resolveWhatsAppTransportCredential
      )
    ).rejects.toBeInstanceOf(WhatsAppTransportBindingError);

    expect(mocks.unsealFacebookPageToken).not.toHaveBeenCalled();
  });

  it("does not use global credentials for a contextless production send", async () => {
    await expect(resolveWhatsAppTransportCredential()).rejects.toBeInstanceOf(
      WhatsAppTransportBindingError
    );

    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
    expect(mocks.unsealFacebookPageToken).not.toHaveBeenCalled();
  });

  it("rejects incomplete request scope even outside production", async () => {
    process.env.NODE_ENV = "test";

    await expect(
      runWithMessengerRequestContext(
        "404040404040404",
        resolveWhatsAppTransportCredential
      )
    ).rejects.toBeInstanceOf(WhatsAppTransportBindingError);

    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
    expect(mocks.unsealFacebookPageToken).not.toHaveBeenCalled();
  });

  it("rejects a channel-only request context outside production", async () => {
    process.env.NODE_ENV = "test";

    await expect(
      runWithMessengerRequestContext("", resolveWhatsAppTransportCredential, {
        channel: "facebook_messenger",
      })
    ).rejects.toBeInstanceOf(WhatsAppTransportBindingError);

    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
    expect(mocks.unsealFacebookPageToken).not.toHaveBeenCalled();
  });
});
