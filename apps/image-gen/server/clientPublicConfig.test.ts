import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLoginUrl,
  isLoginConfigured,
  loadPublicRuntimeConfig,
} from "../client/src/const";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client public runtime config", () => {
  it("enables login from same-origin runtime config without build-time secrets", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe("/api/public/config");
      expect(init).toMatchObject({
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      return new Response(
        JSON.stringify({
          oauth: {
            configured: true,
            portalUrl: "https://oauth.example.com",
            appId: "leaderbot-public-app",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    await loadPublicRuntimeConfig(fetcher);
    expect(isLoginConfigured()).toBe(true);

    const cookieTarget = { cookie: "" };
    vi.stubGlobal("window", {
      location: {
        origin: "https://leaderbot.live",
        protocol: "https:",
      },
    });
    vi.stubGlobal("document", cookieTarget);

    const loginUrl = getLoginUrl("/handoff");
    expect(loginUrl).not.toBeNull();
    const parsed = new URL(loginUrl ?? "https://invalid.example");
    expect(parsed.origin + parsed.pathname).toBe(
      "https://oauth.example.com/app-auth"
    );
    expect(parsed.searchParams.get("appId")).toBe("leaderbot-public-app");
    expect(parsed.searchParams.get("redirectUri")).toBe(
      "https://leaderbot.live/api/oauth/callback"
    );
    expect(cookieTarget.cookie).toContain("lb_oauth_state_nonce=");

    await loadPublicRuntimeConfig(
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              oauth: { configured: false, portalUrl: null, appId: null },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );
    expect(isLoginConfigured()).toBe(false);
  });
});
