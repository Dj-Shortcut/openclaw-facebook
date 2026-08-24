import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const mocks = vi.hoisted(() => ({
  getDatabaseOrThrow: vi.fn(),
  unsealFacebookPageToken: vi.fn(),
}));

vi.mock("./db", () => ({
  getDatabaseOrThrow: mocks.getDatabaseOrThrow,
}));

vi.mock("./_core/facebookConnectStore", () => ({
  unsealFacebookPageToken: mocks.unsealFacebookPageToken,
}));

import {
  assertWhatsAppTenantBindingReadiness,
  WhatsAppBindingReadinessError,
} from "./_core/whatsappBindingReadiness";
import { buildRuntimeReadinessChecks } from "./_core/readiness";

const BINDING = Object.freeze({
  encryptedAccessToken: "sealed-token",
  phoneNumberId: "404040404040404",
  wabaId: "303030303030303",
});

function databaseReturning(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return {
    select: vi.fn(() => ({ from })),
    where,
    limit,
  };
}

describe("WhatsApp tenant binding readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", BINDING.phoneNumberId);
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", BINDING.wabaId);
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "tenant-token");
    mocks.unsealFacebookPageToken.mockReturnValue("tenant-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is wired into runtime readiness and accepts one exact sealed binding", async () => {
    const database = databaseReturning([BINDING]);
    mocks.getDatabaseOrThrow.mockResolvedValue(database);
    const check = buildRuntimeReadinessChecks().find(
      item => item.name === "whatsapp_tenant_binding"
    );

    expect(check).toBeDefined();
    await expect(check?.check()).resolves.toBeUndefined();
    expect(mocks.unsealFacebookPageToken).toHaveBeenCalledWith("sealed-token");
    expect(database.limit).toHaveBeenCalledWith(2);
    const query = new MySqlDialect().sqlToQuery(
      database.where.mock.calls[0]?.[0]
    );
    expect(query.sql).toContain("`channelConnections`.`channel`");
    expect(query.sql).toContain("`channelConnections`.`status`");
    expect(query.sql).toContain("`channelConnections`.`externalId`");
    expect(query.params).toEqual(
      expect.arrayContaining(["whatsapp", "connected", BINDING.phoneNumberId])
    );
  });

  it("fails closed when production has only env credentials and no binding", async () => {
    mocks.getDatabaseOrThrow.mockResolvedValue(databaseReturning([]));

    await expect(assertWhatsAppTenantBindingReadiness()).rejects.toBeInstanceOf(
      WhatsAppBindingReadinessError
    );
    expect(mocks.unsealFacebookPageToken).not.toHaveBeenCalled();
  });

  it("fails closed when the production WABA identity is unavailable", async () => {
    vi.stubEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "");
    mocks.getDatabaseOrThrow.mockResolvedValue(databaseReturning([BINDING]));

    const error = await assertWhatsAppTenantBindingReadiness().catch(
      caught => caught
    );
    expect(error).toBeInstanceOf(WhatsAppBindingReadinessError);
    expect(error).toMatchObject({ reason: "configuration_invalid" });
    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
  });

  it("preserves a redacted database failure category and cause", async () => {
    const cause = new Error("database offline");
    mocks.getDatabaseOrThrow.mockRejectedValue(cause);

    const error = await assertWhatsAppTenantBindingReadiness().catch(
      caught => caught
    );

    expect(error).toBeInstanceOf(WhatsAppBindingReadinessError);
    expect(error).toMatchObject({
      reason: "database_unavailable",
      cause,
    });
  });

  it("rejects duplicate or mismatched bindings", async () => {
    mocks.getDatabaseOrThrow.mockResolvedValue(
      databaseReturning([BINDING, BINDING])
    );
    await expect(assertWhatsAppTenantBindingReadiness()).rejects.toBeInstanceOf(
      WhatsAppBindingReadinessError
    );

    mocks.getDatabaseOrThrow.mockResolvedValue(
      databaseReturning([{ ...BINDING, wabaId: "505050505050505" }])
    );
    await expect(assertWhatsAppTenantBindingReadiness()).rejects.toBeInstanceOf(
      WhatsAppBindingReadinessError
    );
  });

  it("rejects a credential envelope that cannot be unsealed", async () => {
    mocks.getDatabaseOrThrow.mockResolvedValue(databaseReturning([BINDING]));
    const cause = new Error("invalid envelope");
    mocks.unsealFacebookPageToken.mockImplementation(() => {
      throw cause;
    });

    const error = await assertWhatsAppTenantBindingReadiness().catch(
      caught => caught
    );
    expect(error).toBeInstanceOf(WhatsAppBindingReadinessError);
    expect(error).toMatchObject({
      reason: "credential_unseal_failed",
      cause,
    });
  });

  it("fails closed when the sealed credential is stale after secret rotation", async () => {
    mocks.getDatabaseOrThrow.mockResolvedValue(databaseReturning([BINDING]));
    mocks.unsealFacebookPageToken.mockReturnValue("prior-tenant-token");

    await expect(assertWhatsAppTenantBindingReadiness()).rejects.toBeInstanceOf(
      WhatsAppBindingReadinessError
    );
  });

  it("does not require a production binding in local/test mode", async () => {
    vi.stubEnv("NODE_ENV", "test");

    await expect(
      assertWhatsAppTenantBindingReadiness()
    ).resolves.toBeUndefined();
    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
  });
});
