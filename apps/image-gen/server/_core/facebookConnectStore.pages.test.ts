import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeFacebookCodeForPages,
  getFacebookPagesForUserAccessToken,
} from "./facebookConnectStore";

describe("Facebook Business Login Page discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logs only numeric metadata when a token exchange fails", async () => {
    vi.stubEnv("FB_APP_ID", "facebook-app-id");
    vi.stubEnv("FB_APP_SECRET", "facebook-app-secret");
    vi.stubEnv("PORTAL_BASE_URL", "https://portal.example.com");
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "sensitive provider response",
              type: "OAuthException",
              code: 100,
              error_subcode: 1349152,
              fbtrace_id: "private-trace",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(exchangeFacebookCodeForPages("private-code")).rejects.toThrow(
      "facebook token exchange failed: 400"
    );

    const logs = warnSpy.mock.calls.flat().join(" ");
    expect(logs).toContain('"status":400');
    expect(logs).toContain('"errorCode":100');
    expect(logs).toContain('"errorSubcode":1349152');
    expect(logs).not.toContain("sensitive provider response");
    expect(logs).not.toContain("private-trace");
    expect(logs).not.toContain("private-code");
    expect(logs).not.toContain("facebook-app-secret");
  });

  it("uses an embedded Page access token without an extra Graph request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "page-42",
              name: "Leaderbot",
              access_token: "page-access-token",
              perms: ["MANAGE"],
              tasks: ["MESSAGING"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const pages = await getFacebookPagesForUserAccessToken("user-token");

    expect(pages).toEqual([
      {
        id: "page-42",
        name: "Leaderbot",
        accessToken: "page-access-token",
        grantedScopes: [
          "pages_show_list",
          "pages_manage_metadata",
          "pages_messaging",
        ],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts a Graph error when the managed Page lookup fails", async () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "private permission details",
              code: 10,
              error_subcode: 200,
              fbtrace_id: "private-trace",
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      getFacebookPagesForUserAccessToken("private-user-token")
    ).rejects.toThrow("facebook page lookup failed: 403");

    const logs = warnSpy.mock.calls.flat().join(" ");
    expect(logs).toContain('"status":403');
    expect(logs).toContain('"errorCode":10');
    expect(logs).toContain('"errorSubcode":200');
    expect(logs).not.toContain("private permission details");
    expect(logs).not.toContain("private-trace");
    expect(logs).not.toContain("private-user-token");
  });

  it("resolves a selected Business Login Page whose token is not embedded", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "page-42", name: "Leaderbot" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "page-42",
            name: "Leaderbot",
            access_token: "page-access-token",
            perms: ["MANAGE"],
            tasks: ["MESSAGING"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const pages = await getFacebookPagesForUserAccessToken("user-token");

    expect(pages).toHaveLength(1);
    expect(pages[0]?.id).toBe("page-42");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(fallbackUrl.pathname).toBe("/v21.0/page-42");
    expect(fallbackUrl.searchParams.has("access_token")).toBe(false);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer user-token",
      },
    });
    const logs = logSpy.mock.calls.flat().join(" ");
    expect(logs).not.toContain("page-access-token");
    expect(logs).not.toContain("user-token");
    expect(logs).not.toContain("page-42");
  });

  it("rejects a fallback response for a different Page", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: [{ id: "page-42", name: "Leaderbot" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "page-other",
              name: "Other Page",
              access_token: "other-page-token",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );

    await expect(
      getFacebookPagesForUserAccessToken("user-token")
    ).resolves.toEqual([]);
  });

  it("discovers a Page assigned through a Business Portfolio", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { permission: "pages_show_list", status: "granted" },
              { permission: "pages_manage_metadata", status: "granted" },
              { permission: "pages_messaging", status: "granted" },
              { permission: "business_management", status: "granted" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "page-42",
                name: "Leaderbot",
                access_token: "page-access-token",
                perms: ["MANAGE"],
                tasks: ["MESSAGING"],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const pages = await getFacebookPagesForUserAccessToken("user-token");

    expect(pages).toHaveLength(1);
    const assignedPagesUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(assignedPagesUrl.pathname).toBe("/v21.0/me/assigned_pages");
    expect(assignedPagesUrl.searchParams.has("access_token")).toBe(false);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer user-token",
      },
    });
    const logs = logSpy.mock.calls.flat().join(" ");
    expect(logs).toContain('"pagesShowListGranted":true');
    expect(logs).toContain('"businessManagementGranted":true');
    expect(logs).not.toContain("page-access-token");
    expect(logs).not.toContain("user-token");
    expect(logs).not.toContain("page-42");
  });
});
