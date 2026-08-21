import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectAuthorizedFacebookPage } from "./_core/facebookPageConnection";

const mocks = vi.hoisted(() => ({
  upsertChannelConnection: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("./db", () => ({
  upsertChannelConnection: mocks.upsertChannelConnection,
  insertAuditLog: mocks.insertAuditLog,
}));

describe("Facebook Page connection", () => {
  beforeEach(() => {
    vi.stubEnv("JWT_SECRET", "x".repeat(32));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a fully authorized Page as connected without persisting the raw token", async () => {
    await expect(
      connectAuthorizedFacebookPage({
        workspaceId: 42,
        userId: 7,
        source: "facebook_login",
        page: {
          id: "page-42",
          name: "Customer Page",
          accessToken: "raw-page-token",
          grantedScopes: [
            "pages_show_list",
            "pages_manage_metadata",
            "pages_messaging",
          ],
        },
      })
    ).resolves.toEqual({ status: "connected" });

    expect(mocks.upsertChannelConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        status: "connected",
        externalId: "page-42",
        encryptedAccessToken: expect.stringMatching(/^v1:/),
      })
    );
    expect(
      mocks.upsertChannelConnection.mock.calls[0]?.[0]?.encryptedAccessToken
    ).not.toContain("raw-page-token");
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        userId: 7,
        event: "facebook_page.selected",
        metadata: expect.objectContaining({
          status: "connected",
          source: "facebook_login",
        }),
      })
    );
  });

  it("fails closed as missing_permissions when Page grants are incomplete", async () => {
    await expect(
      connectAuthorizedFacebookPage({
        workspaceId: 42,
        userId: 7,
        source: "customer_app",
        page: {
          id: "page-42",
          name: "Customer Page",
          accessToken: "raw-page-token",
          grantedScopes: ["pages_show_list"],
        },
      })
    ).resolves.toEqual({ status: "missing_permissions" });

    expect(mocks.upsertChannelConnection).toHaveBeenCalledWith(
      expect.objectContaining({ status: "missing_permissions" })
    );
  });
});
