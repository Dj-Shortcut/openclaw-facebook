import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FacebookPageTokenRotationAuthorizationError,
  FacebookPageTokenRotationBindingError,
  FacebookPageTokenRotationConfigurationError,
  readFacebookPageTokenRotationEnv,
  rotateFacebookPageToken,
} from "./_core/facebookPageTokenRotation";
import { unsealFacebookPageToken } from "./_core/facebookPageToken";
import { runFacebookPageTokenRotationCli } from "./cli/rotateFacebookPageToken";
import {
  ChannelConnectionAuthorizationError,
  FacebookChannelConnectionMigrationRequiredError,
} from "./db";

const mocks = vi.hoisted(() => ({
  closeDatabasePool: vi.fn(),
  upsertChannelConnection: vi.fn(),
}));

vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  closeDatabasePool: mocks.closeDatabasePool,
  upsertChannelConnection: mocks.upsertChannelConnection,
}));

const INPUT = Object.freeze({
  workspaceId: 42,
  actorUserId: 7,
  channelConnectionId: 11,
  bindingEpoch: 5,
  approvalReference: "owner-change-2026-09-04",
  pageId: "123456789012345",
  accessToken: "private-rotated-page-token",
});

function rotationEnv(): NodeJS.ProcessEnv {
  return {
    FACEBOOK_PAGE_TOKEN_ROTATE_CONFIRM: "rotate-exact-page-token",
    FACEBOOK_PAGE_TOKEN_ROTATE_WORKSPACE_ID: String(INPUT.workspaceId),
    FACEBOOK_PAGE_TOKEN_ROTATE_ACTOR_USER_ID: String(INPUT.actorUserId),
    FACEBOOK_PAGE_TOKEN_ROTATE_CONNECTION_ID: String(INPUT.channelConnectionId),
    FACEBOOK_PAGE_TOKEN_ROTATE_BINDING_EPOCH: String(INPUT.bindingEpoch),
    FACEBOOK_PAGE_TOKEN_ROTATE_APPROVAL_REFERENCE: INPUT.approvalReference,
    FACEBOOK_PAGE_TOKEN_ROTATE_PAGE_ID: INPUT.pageId,
    FACEBOOK_PAGE_TOKEN_ROTATE_ACCESS_TOKEN: INPUT.accessToken,
  };
}

describe("owner Facebook Page token rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "x".repeat(32));
    mocks.upsertChannelConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("seals a token for only the current Page binding and owner role", async () => {
    await expect(rotateFacebookPageToken(INPUT)).resolves.toEqual({
      workspaceId: 42,
      channelConnectionId: 11,
      bindingEpoch: 5,
      status: "connected",
    });

    expect(mocks.upsertChannelConnection).toHaveBeenCalledOnce();
    const [stored, options] = mocks.upsertChannelConnection.mock.calls[0] ?? [];
    expect(stored).toMatchObject({
      id: INPUT.channelConnectionId,
      workspaceId: INPUT.workspaceId,
      channel: "facebook_messenger",
      status: "connected",
      externalId: INPUT.pageId,
      providerAccountExternalId: null,
      encryptedAccessToken: expect.stringMatching(/^v1:/),
      bindingEpoch: INPUT.bindingEpoch,
    });
    expect(stored.encryptedAccessToken).not.toContain(INPUT.accessToken);
    expect(unsealFacebookPageToken(stored.encryptedAccessToken)).toBe(
      INPUT.accessToken
    );
    expect(options.authorization).toEqual({
      actorUserId: INPUT.actorUserId,
      allowedRoles: ["owner"],
    });
    expect(options.updatePolicy).toBe("rotate_exact_facebook_page_token");
    expect(options.auditLog).toMatchObject({
      workspaceId: INPUT.workspaceId,
      userId: INPUT.actorUserId,
      event: "facebook_page_token.rotated",
      metadata: {
        channel: "facebook_messenger",
        status: "connected",
        source: "operator_cli",
        channelConnectionId: INPUT.channelConnectionId,
        bindingEpoch: INPUT.bindingEpoch,
        approvalReferenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        pageIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const serializedAudit = JSON.stringify(options.auditLog);
    expect(serializedAudit).not.toContain(INPUT.accessToken);
    expect(serializedAudit).not.toContain(INPUT.approvalReference);
    expect(serializedAudit).not.toContain(INPUT.pageId);
  });

  it("maps rejected owner authorization without exposing rotation inputs", async () => {
    mocks.upsertChannelConnection.mockRejectedValueOnce(
      new ChannelConnectionAuthorizationError()
    );

    const error = await rotateFacebookPageToken(INPUT).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(FacebookPageTokenRotationAuthorizationError);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(INPUT.accessToken);
    expect(serialized).not.toContain(INPUT.pageId);
  });

  it("maps a stale or changed binding to a metadata-only refusal", async () => {
    mocks.upsertChannelConnection.mockRejectedValueOnce(
      new FacebookChannelConnectionMigrationRequiredError()
    );

    const error = await rotateFacebookPageToken(INPUT).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(FacebookPageTokenRotationBindingError);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(INPUT.accessToken);
    expect(serialized).not.toContain(INPUT.pageId);
  });

  it("rejects an invalid Page id before sealing or storing a token", async () => {
    await expect(
      rotateFacebookPageToken({ ...INPUT, pageId: "not-a-page-id" })
    ).rejects.toMatchObject({ name: "ConversationIdentityError" });
    expect(mocks.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and every current binding fence", () => {
    expect(readFacebookPageTokenRotationEnv(rotationEnv())).toEqual(INPUT);
    expect(() =>
      readFacebookPageTokenRotationEnv({
        ...rotationEnv(),
        FACEBOOK_PAGE_TOKEN_ROTATE_CONFIRM: "rotate",
      })
    ).toThrow(FacebookPageTokenRotationConfigurationError);
    expect(() =>
      readFacebookPageTokenRotationEnv({
        ...rotationEnv(),
        FACEBOOK_PAGE_TOKEN_ROTATE_BINDING_EPOCH: "0",
      })
    ).toThrow(FacebookPageTokenRotationConfigurationError);
  });

  it("prints only binding metadata and removes the raw token env", async () => {
    for (const [name, value] of Object.entries(rotationEnv())) {
      if (value !== undefined) vi.stubEnv(name, value);
    }
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array
    ) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await runFacebookPageTokenRotationCli();

    expect(mocks.closeDatabasePool).toHaveBeenCalledOnce();
    expect(process.env.FACEBOOK_PAGE_TOKEN_ROTATE_ACCESS_TOKEN).toBeUndefined();
    const serialized = output.join("");
    expect(serialized).toContain('"event":"facebook_page_token_rotated"');
    expect(serialized).toContain('"channelConnectionId":11');
    expect(serialized).toContain('"bindingEpoch":5');
    expect(serialized).not.toContain(INPUT.accessToken);
    expect(serialized).not.toContain(INPUT.approvalReference);
    expect(serialized).not.toContain(INPUT.pageId);
  });

  it("closes the database pool when the owner command is refused", async () => {
    vi.stubEnv("FACEBOOK_PAGE_TOKEN_ROTATE_CONFIRM", "");
    vi.stubEnv("FACEBOOK_PAGE_TOKEN_ROTATE_ACCESS_TOKEN", INPUT.accessToken);

    await expect(runFacebookPageTokenRotationCli()).rejects.toBeInstanceOf(
      FacebookPageTokenRotationConfigurationError
    );

    expect(mocks.closeDatabasePool).toHaveBeenCalledOnce();
    expect(process.env.FACEBOOK_PAGE_TOKEN_ROTATE_ACCESS_TOKEN).toBeUndefined();
  });
});
