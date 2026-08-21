import { afterEach, describe, expect, it, vi } from "vitest";
import { getFacebookPagesForUserAccessToken } from "./facebookConnectStore";

describe("Facebook Business Login Page discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
