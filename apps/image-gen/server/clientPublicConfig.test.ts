import { afterEach, describe, expect, it, vi } from "vitest";

type ClientPublicConfigModule = typeof import("../client/src/const");

async function importClientPublicConfig(): Promise<ClientPublicConfigModule> {
  vi.resetModules();
  return import("../client/src/const");
}

function stubBuildTimeOAuthConfig(): void {
  vi.stubEnv("VITE_OAUTH_PORTAL_URL", "https://build-oauth.example.com");
  vi.stubEnv("VITE_APP_ID", "leaderbot-build-app");
}

function stubBrowser(): { cookie: string } {
  const cookieTarget = { cookie: "" };
  vi.stubGlobal("window", {
    location: {
      origin: "https://leaderbot.live",
      protocol: "https:",
    },
  });
  vi.stubGlobal("document", cookieTarget);
  return cookieTarget;
}

function expectBuildTimeLogin(config: ClientPublicConfigModule): void {
  expect(config.isLoginConfigured()).toBe(true);
  stubBrowser();
  const loginUrl = config.getLoginUrl("/handoff");
  expect(loginUrl).not.toBeNull();
  const parsed = new URL(loginUrl ?? "https://invalid.example");
  expect(parsed.origin + parsed.pathname).toBe(
    "https://build-oauth.example.com/app-auth"
  );
  expect(parsed.searchParams.get("appId")).toBe("leaderbot-build-app");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("client public runtime config", () => {
  it("enables login from same-origin runtime config without build-time secrets", async () => {
    const { getLoginUrl, isLoginConfigured, loadPublicRuntimeConfig } =
      await importClientPublicConfig();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe("/api/public/config");
      expect(init).toMatchObject({
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
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

    const cookieTarget = stubBrowser();

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

  it.each([
    [
      "a rejected fetch",
      async () => {
        throw new TypeError("network unavailable");
      },
    ],
    [
      "a non-ok response",
      async () => new Response("unavailable", { status: 503 }),
    ],
  ])("uses the documented build fallback after %s", async (_label, request) => {
    vi.useFakeTimers();
    stubBuildTimeOAuthConfig();
    const config = await importClientPublicConfig();
    const fetcher = vi.fn<typeof fetch>(request);

    await config.loadPublicRuntimeConfig(fetcher);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expectBuildTimeLogin(config);
  });

  it("aborts a stalled runtime-config request and continues with the build fallback", async () => {
    vi.useFakeTimers();
    stubBuildTimeOAuthConfig();
    const config = await importClientPublicConfig();
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    });

    const loadPromise = config.loadPublicRuntimeConfig(fetcher);
    await vi.advanceTimersByTimeAsync(5_000);
    await loadPromise;

    const signal = fetcher.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expectBuildTimeLogin(config);
  });
});
