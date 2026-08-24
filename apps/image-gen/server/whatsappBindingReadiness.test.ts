import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    mocks.getDatabaseOrThrow.mockResolvedValue(databaseReturning([BINDING]));
    const check = buildRuntimeReadinessChecks().find(
      item => item.name === "whatsapp_tenant_binding"
    );

    expect(check).toBeDefined();
    await expect(check?.check()).resolves.toBeUndefined();
    expect(mocks.unsealFacebookPageToken).toHaveBeenCalledWith("sealed-token");
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

    await expect(assertWhatsAppTenantBindingReadiness()).rejects.toBeInstanceOf(
      WhatsAppBindingReadinessError
    );
    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
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
    mocks.unsealFacebookPageToken.mockImplementation(() => {
      throw new Error("invalid envelope");
    });

    await expect(assertWhatsAppTenantBindingReadiness()).rejects.toBeInstanceOf(
      WhatsAppBindingReadinessError
    );
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
