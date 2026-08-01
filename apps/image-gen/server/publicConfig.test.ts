import { describe, expect, it } from "vitest";
import {
  getPublicRuntimeConfig,
  registerPublicConfigRoute,
} from "./_core/runtime/publicConfig";

type FakeResponse = {
  headers: Record<string, string>;
  body: unknown;
  setHeader(name: string, value: string): void;
  json(value: unknown): void;
};

function renderPublicConfig() {
  let routePath = "";
  let handler: ((_req: unknown, res: FakeResponse) => void) | undefined;
  registerPublicConfigRoute(
    {
      get(path: string, routeHandler: typeof handler) {
        routePath = path;
        handler = routeHandler;
        return this;
      },
    } as never,
    () => ({
      oauth: {
        configured: true,
        portalUrl: "https://oauth.example.com",
        appId: "leaderbot-public-app",
      },
    })
  );

  const response: FakeResponse = {
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(value) {
      this.body = value;
    },
  };
  handler?.({}, response);
  return { routePath, response };
}

describe("public runtime config", () => {
  it("publishes only the non-secret OAuth browser configuration", () => {
    expect(
      getPublicRuntimeConfig({
        OAUTH_PORTAL_URL:
          "https://oauth.example.com/portal/?private=query#fragment",
        OAUTH_SERVER_URL: "https://internal.example.com",
        VITE_APP_ID: "leaderbot-public-app",
        JWT_SECRET: "must-not-leak",
      })
    ).toEqual({
      oauth: {
        configured: true,
        portalUrl: "https://oauth.example.com/portal",
        appId: "leaderbot-public-app",
      },
    });
  });

  it("falls back to the OAuth server URL and fails closed for unsafe URLs", () => {
    expect(
      getPublicRuntimeConfig({
        OAUTH_SERVER_URL: "https://oauth.example.com",
        VITE_APP_ID: "leaderbot-public-app",
      }).oauth.configured
    ).toBe(true);
    expect(
      getPublicRuntimeConfig({
        OAUTH_PORTAL_URL: "http://oauth.example.com",
        VITE_APP_ID: "leaderbot-public-app",
      })
    ).toEqual({
      oauth: { configured: false, portalUrl: null, appId: null },
    });
  });

  it("registers an exact no-store JSON route", () => {
    const { routePath, response } = renderPublicConfig();

    expect(routePath).toBe("/api/public/config");
    expect(response.headers).toEqual({ "Cache-Control": "no-store" });
    expect(response.body).toEqual({
      oauth: {
        configured: true,
        portalUrl: "https://oauth.example.com",
        appId: "leaderbot-public-app",
      },
    });
  });
});
