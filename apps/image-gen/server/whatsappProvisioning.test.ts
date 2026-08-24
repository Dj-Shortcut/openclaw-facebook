import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  provisionWhatsAppTenantBinding,
  readWhatsAppProvisioningEnv,
  WhatsAppProvisioningAuthorizationError,
  WhatsAppProvisioningConfigurationError,
} from "./_core/whatsappProvisioning";
import { unsealFacebookPageToken } from "./_core/facebookConnectStore";
import { runWhatsAppProvisioningCli } from "./cli/provisionWhatsAppBinding";
import { ChannelConnectionAuthorizationError } from "./db";

const mocks = vi.hoisted(() => ({
  upsertChannelConnection: vi.fn(),
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  upsertChannelConnection: mocks.upsertChannelConnection,
}));

const INPUT = Object.freeze({
  workspaceId: 42,
  actorUserId: 7,
  approvalReference: "portal-approval-2026-08-24-42",
  wabaId: "303030303030303",
  phoneNumberId: "404040404040404",
  accessToken: "private-whatsapp-token",
});

describe("WhatsApp tenant binding provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "x".repeat(32));
    mocks.upsertChannelConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores an authorized exact workspace binding and only a sealed credential", async () => {
    await expect(provisionWhatsAppTenantBinding(INPUT)).resolves.toEqual({
      workspaceId: 42,
      status: "connected",
    });

    expect(mocks.upsertChannelConnection).toHaveBeenCalledOnce();
    const stored = mocks.upsertChannelConnection.mock.calls[0]?.[0];
    expect(stored).toMatchObject({
      workspaceId: 42,
      channel: "whatsapp",
      status: "connected",
      externalId: INPUT.phoneNumberId,
      providerAccountExternalId: INPUT.wabaId,
      encryptedAccessToken: expect.stringMatching(/^v1:/),
    });
    expect(stored.encryptedAccessToken).not.toContain(INPUT.accessToken);
    expect(unsealFacebookPageToken(stored.encryptedAccessToken)).toBe(
      INPUT.accessToken
    );

    const audit = mocks.upsertChannelConnection.mock.calls[0]?.[1]?.auditLog;
    expect(audit).toMatchObject({
      workspaceId: 42,
      userId: 7,
      event: "whatsapp_binding.provisioned",
      metadata: {
        channel: "whatsapp",
        status: "connected",
        source: "operator_cli",
        approvalReferenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        providerAccountIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        phoneNumberIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(audit)).not.toContain(INPUT.accessToken);
    expect(JSON.stringify(audit)).not.toContain(INPUT.approvalReference);
    expect(JSON.stringify(audit)).not.toContain(INPUT.wabaId);
    expect(JSON.stringify(audit)).not.toContain(INPUT.phoneNumberId);
    expect(
      mocks.upsertChannelConnection.mock.calls[0]?.[1]?.authorization
    ).toEqual({
      actorUserId: 7,
      allowedRoles: ["owner", "admin"],
    });
  });

  it("rejects a workspace member before storing a credential or audit", async () => {
    mocks.upsertChannelConnection.mockRejectedValueOnce(
      new ChannelConnectionAuthorizationError()
    );

    await expect(provisionWhatsAppTenantBinding(INPUT)).rejects.toBeInstanceOf(
      WhatsAppProvisioningAuthorizationError
    );
    expect(mocks.upsertChannelConnection).toHaveBeenCalledOnce();
  });

  it("rejects invalid provider identifiers before any connection write", async () => {
    await expect(
      provisionWhatsAppTenantBinding({ ...INPUT, phoneNumberId: "not-an-id" })
    ).rejects.toMatchObject({ name: "ConversationIdentityError" });
    expect(mocks.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("requires a durable approval reference before storing a credential", async () => {
    await expect(
      provisionWhatsAppTenantBinding({ ...INPUT, approvalReference: " " })
    ).rejects.toBeInstanceOf(WhatsAppProvisioningConfigurationError);
    expect(mocks.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("reads every provisioning value from env and requires explicit confirmation", () => {
    const env = {
      WHATSAPP_PROVISION_CONFIRM: "provision",
      WHATSAPP_PROVISION_WORKSPACE_ID: "42",
      WHATSAPP_PROVISION_ACTOR_USER_ID: "7",
      WHATSAPP_PROVISION_APPROVAL_REFERENCE: INPUT.approvalReference,
      WHATSAPP_BUSINESS_ACCOUNT_ID: INPUT.wabaId,
      WHATSAPP_PHONE_NUMBER_ID: INPUT.phoneNumberId,
      WHATSAPP_ACCESS_TOKEN: INPUT.accessToken,
    };

    expect(readWhatsAppProvisioningEnv(env)).toEqual(INPUT);
    expect(() =>
      readWhatsAppProvisioningEnv({
        ...env,
        WHATSAPP_PROVISION_CONFIRM: "",
      })
    ).toThrow(WhatsAppProvisioningConfigurationError);
  });

  it("prints only metadata after the env-only operator command succeeds", async () => {
    for (const [name, value] of Object.entries({
      WHATSAPP_PROVISION_CONFIRM: "provision",
      WHATSAPP_PROVISION_WORKSPACE_ID: String(INPUT.workspaceId),
      WHATSAPP_PROVISION_ACTOR_USER_ID: String(INPUT.actorUserId),
      WHATSAPP_PROVISION_APPROVAL_REFERENCE: INPUT.approvalReference,
      WHATSAPP_BUSINESS_ACCOUNT_ID: INPUT.wabaId,
      WHATSAPP_PHONE_NUMBER_ID: INPUT.phoneNumberId,
      WHATSAPP_ACCESS_TOKEN: INPUT.accessToken,
    })) {
      vi.stubEnv(name, value);
    }
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await runWhatsAppProvisioningCli();

    const serialized = output.join("");
    expect(serialized).toContain('"event":"whatsapp_binding_provisioned"');
    expect(serialized).toContain('"workspaceId":42');
    expect(serialized).not.toContain(INPUT.accessToken);
    expect(serialized).not.toContain(INPUT.approvalReference);
    expect(serialized).not.toContain(INPUT.wabaId);
    expect(serialized).not.toContain(INPUT.phoneNumberId);
  });
});
