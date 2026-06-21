import { describe, expect, it } from "vitest";
import { registerLegalRoutes } from "./_core/runtime/legalRoutes";

type RegisteredRoute = {
  path: string;
  handler: (_req: unknown, res: FakeResponse) => void;
};

class FakeResponse {
  contentType = "";
  body = "";

  type(contentType: string): this {
    this.contentType = contentType;
    return this;
  }

  send(body: string): void {
    this.body = body;
  }
}

function renderLegalRoute(path: string): FakeResponse {
  const routes: RegisteredRoute[] = [];
  registerLegalRoutes({
    get(routePath: string, handler: RegisteredRoute["handler"]) {
      routes.push({ path: routePath, handler });
      return this;
    },
  } as never);

  const route = routes.find(entry => entry.path === path);
  if (!route) {
    throw new Error(`Missing legal route: ${path}`);
  }

  const response = new FakeResponse();
  route.handler({}, response);
  return response;
}

describe("legal routes", () => {
  it.each(["/privacy", "/terms", "/data-deletion"])(
    "serves public legal page %s",
    path => {
      const response = renderLegalRoute(path);

      expect(response.contentType).toBe("html");
      expect(response.body).toContain("Leaderbot");
      expect(response.body).toContain("privacy@leaderbot.live");
    }
  );

  it("explains Messenger deletion and Meta-controlled message history", () => {
    const privacy = renderLegalRoute("/privacy").body;
    const deletion = renderLegalRoute("/data-deletion").body;

    expect(privacy).toContain('sending "delete my data" in Messenger');
    expect(privacy).toContain("Meta/Facebook");
    expect(deletion).toContain("delete my data");
    expect(deletion).toContain("verwijder mijn data");
    expect(deletion).toContain("Facebook-controlled data");
  });

  it("documents terms for AI outputs, quotas, and Meta separation", () => {
    const terms = renderLegalRoute("/terms").body;

    expect(terms).toContain("AI-generated content");
    expect(terms).toContain("quotas");
    expect(terms).toContain("not endorsed by or affiliated with Meta");
    expect(terms).toContain("/privacy");
    expect(terms).toContain("/data-deletion");
  });
});
