import { createHash } from "node:crypto";
import * as db from "../db";
import { resolveWhatsAppEndpoint } from "./conversationEndpoint";
import { sealFacebookPageToken } from "./facebookConnectStore";

const PROVISION_CONFIRMATION = "provision";

export class WhatsAppProvisioningAuthorizationError extends Error {
  constructor() {
    super("WhatsApp binding provisioning is not authorized");
    this.name = "WhatsAppProvisioningAuthorizationError";
  }
}

export class WhatsAppProvisioningConfigurationError extends Error {
  constructor() {
    super("WhatsApp binding provisioning configuration is invalid");
    this.name = "WhatsAppProvisioningConfigurationError";
  }
}

export type WhatsAppProvisioningInput = Readonly<{
  workspaceId: number;
  actorUserId: number;
  approvalReference: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}>;

function parsePositiveInteger(value: string | undefined): number {
  const normalized = value?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new WhatsAppProvisioningConfigurationError();
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new WhatsAppProvisioningConfigurationError();
  }
  return parsed;
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string {
  const value = env[name]?.trim() ?? "";
  if (!value) {
    throw new WhatsAppProvisioningConfigurationError();
  }
  return value;
}

export function readWhatsAppProvisioningEnv(
  env: NodeJS.ProcessEnv = process.env
): WhatsAppProvisioningInput {
  if (env.WHATSAPP_PROVISION_CONFIRM?.trim() !== PROVISION_CONFIRMATION) {
    throw new WhatsAppProvisioningConfigurationError();
  }

  return Object.freeze({
    workspaceId: parsePositiveInteger(env.WHATSAPP_PROVISION_WORKSPACE_ID),
    actorUserId: parsePositiveInteger(env.WHATSAPP_PROVISION_ACTOR_USER_ID),
    approvalReference: requiredEnv(
      env,
      "WHATSAPP_PROVISION_APPROVAL_REFERENCE"
    ),
    wabaId: requiredEnv(env, "WHATSAPP_BUSINESS_ACCOUNT_ID"),
    phoneNumberId: requiredEnv(env, "WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: requiredEnv(env, "WHATSAPP_ACCESS_TOKEN"),
  });
}

function hashProviderIdentifier(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * One provider-silent operator action: no Graph request is made. The raw
 * access token exists only in memory long enough to seal it for the exact
 * workspace binding and is never returned or written to audit metadata.
 */
export async function provisionWhatsAppTenantBinding(
  input: WhatsAppProvisioningInput
): Promise<Readonly<{ workspaceId: number; status: "connected" }>> {
  const endpoint = resolveWhatsAppEndpoint({
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
  });
  const accessToken = input.accessToken.trim();
  const approvalReference = input.approvalReference.trim();
  if (!accessToken || !approvalReference) {
    throw new WhatsAppProvisioningConfigurationError();
  }

  try {
    await db.upsertChannelConnection(
      {
        workspaceId: input.workspaceId,
        channel: "whatsapp",
        status: "connected",
        externalId: endpoint.phoneNumberId,
        providerAccountExternalId: endpoint.wabaId,
        displayName: null,
        encryptedAccessToken: sealFacebookPageToken(accessToken),
        grantedScopes: null,
        lastCheckedAt: new Date(),
      },
      {
        authorization: {
          actorUserId: input.actorUserId,
          allowedRoles: ["owner", "admin"],
        },
        auditLog: {
          workspaceId: input.workspaceId,
          userId: input.actorUserId,
          event: "whatsapp_binding.provisioned",
          metadata: {
            channel: "whatsapp",
            status: "connected",
            source: "operator_cli",
            approvalReferenceHash: hashProviderIdentifier(approvalReference),
            providerAccountIdHash: hashProviderIdentifier(endpoint.wabaId),
            phoneNumberIdHash: hashProviderIdentifier(endpoint.phoneNumberId),
          },
        },
      }
    );
  } catch (error) {
    if (error instanceof db.ChannelConnectionAuthorizationError) {
      throw new WhatsAppProvisioningAuthorizationError();
    }
    throw error;
  }

  return Object.freeze({ workspaceId: input.workspaceId, status: "connected" });
}
