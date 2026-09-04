import { createHash } from "node:crypto";

import * as db from "../db";
import { resolveMessengerEndpoint } from "./conversationEndpoint";
import { sealFacebookPageToken } from "./facebookPageToken";

const ROTATION_CONFIRMATION = "rotate-exact-page-token";

export class FacebookPageTokenRotationAuthorizationError extends Error {
  constructor() {
    super("Facebook Page token rotation is not authorized");
    this.name = "FacebookPageTokenRotationAuthorizationError";
  }
}

export class FacebookPageTokenRotationConfigurationError extends Error {
  constructor() {
    super("Facebook Page token rotation configuration is invalid");
    this.name = "FacebookPageTokenRotationConfigurationError";
  }
}

export class FacebookPageTokenRotationBindingError extends Error {
  constructor() {
    super("Facebook Page token rotation requires the current exact binding");
    this.name = "FacebookPageTokenRotationBindingError";
  }
}

export type FacebookPageTokenRotationInput = Readonly<{
  workspaceId: number;
  actorUserId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  approvalReference: string;
  pageId: string;
  accessToken: string;
}>;

function parsePositiveInteger(value: string | undefined): number {
  const normalized = value?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new FacebookPageTokenRotationConfigurationError();
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new FacebookPageTokenRotationConfigurationError();
  }
  return parsed;
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: keyof NodeJS.ProcessEnv
): string {
  const value = env[name]?.trim() ?? "";
  if (!value) {
    throw new FacebookPageTokenRotationConfigurationError();
  }
  return value;
}

export function readFacebookPageTokenRotationEnv(
  env: NodeJS.ProcessEnv = process.env
): FacebookPageTokenRotationInput {
  if (
    env.FACEBOOK_PAGE_TOKEN_ROTATE_CONFIRM?.trim() !== ROTATION_CONFIRMATION
  ) {
    throw new FacebookPageTokenRotationConfigurationError();
  }

  return Object.freeze({
    workspaceId: parsePositiveInteger(
      env.FACEBOOK_PAGE_TOKEN_ROTATE_WORKSPACE_ID
    ),
    actorUserId: parsePositiveInteger(
      env.FACEBOOK_PAGE_TOKEN_ROTATE_ACTOR_USER_ID
    ),
    channelConnectionId: parsePositiveInteger(
      env.FACEBOOK_PAGE_TOKEN_ROTATE_CONNECTION_ID
    ),
    bindingEpoch: parsePositiveInteger(
      env.FACEBOOK_PAGE_TOKEN_ROTATE_BINDING_EPOCH
    ),
    approvalReference: requiredEnv(
      env,
      "FACEBOOK_PAGE_TOKEN_ROTATE_APPROVAL_REFERENCE"
    ),
    pageId: requiredEnv(env, "FACEBOOK_PAGE_TOKEN_ROTATE_PAGE_ID"),
    accessToken: requiredEnv(env, "FACEBOOK_PAGE_TOKEN_ROTATE_ACCESS_TOKEN"),
  });
}

function hashAuditValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Rotates only the credential for an existing owner Page binding. This action
 * is provider-silent: the operator supplies the current binding fence and a
 * reviewed Page token, and no Graph request is made from this process.
 */
export async function rotateFacebookPageToken(
  input: FacebookPageTokenRotationInput
): Promise<
  Readonly<{
    workspaceId: number;
    channelConnectionId: number;
    bindingEpoch: number;
    status: "connected";
  }>
> {
  const endpoint = resolveMessengerEndpoint({ entryId: input.pageId });
  const accessToken = input.accessToken.trim();
  const approvalReference = input.approvalReference.trim();
  if (!accessToken || !approvalReference) {
    throw new FacebookPageTokenRotationConfigurationError();
  }

  try {
    await db.upsertChannelConnection(
      {
        id: input.channelConnectionId,
        workspaceId: input.workspaceId,
        channel: "facebook_messenger",
        status: "connected",
        externalId: endpoint.pageId,
        providerAccountExternalId: null,
        encryptedAccessToken: sealFacebookPageToken(accessToken),
        bindingEpoch: input.bindingEpoch,
      },
      {
        authorization: {
          actorUserId: input.actorUserId,
          allowedRoles: ["owner"],
        },
        updatePolicy: "rotate_exact_facebook_page_token",
        auditLog: {
          workspaceId: input.workspaceId,
          userId: input.actorUserId,
          event: "facebook_page_token.rotated",
          metadata: {
            channel: "facebook_messenger",
            status: "connected",
            source: "operator_cli",
            channelConnectionId: input.channelConnectionId,
            bindingEpoch: input.bindingEpoch,
            approvalReferenceHash: hashAuditValue(approvalReference),
            pageIdHash: hashAuditValue(endpoint.pageId),
          },
        },
      }
    );
  } catch (error) {
    if (error instanceof db.ChannelConnectionAuthorizationError) {
      throw new FacebookPageTokenRotationAuthorizationError();
    }
    if (
      error instanceof db.FacebookChannelConnectionMigrationRequiredError ||
      error instanceof db.ChannelConnectionClaimConflictError
    ) {
      throw new FacebookPageTokenRotationBindingError();
    }
    throw error;
  }

  return Object.freeze({
    workspaceId: input.workspaceId,
    channelConnectionId: input.channelConnectionId,
    bindingEpoch: input.bindingEpoch,
    status: "connected",
  });
}
