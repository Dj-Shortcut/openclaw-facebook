import { describe, expect, it } from "vitest";
import { formatAmountMinor, getBillingPlan } from "./_core/billing/catalog";
import { escapeHtml } from "./_core/html";
import {
  getStartpilotPricingDisplay,
  registerLegalRoutes,
} from "./_core/runtime/legalRoutes";

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
  it.each(["/privacy", "/terms", "/billing-policy", "/data-deletion"])(
    "serves public legal page %s",
    path => {
      const response = renderLegalRoute(path);

      expect(response.contentType).toBe("html");
      expect(response.body).toContain("Leaderbot");
      expect(response.body).toContain("privacy@leaderbot.live");
      expect(response.body).toContain("Andy Arijs");
      expect(response.body).toContain("1040.495.145");
      expect(response.body).toContain("Savooistraat 50");
      expect(response.body).toContain("+32 469 79 26 56");
    }
  );

  it("explains Messenger deletion and Meta-controlled message history", () => {
    const privacy = renderLegalRoute("/privacy").body;
    const deletion = renderLegalRoute("/data-deletion").body;

    expect(privacy).toContain("delete my data");
    expect(privacy).toContain("Meta controls Facebook and Messenger");
    expect(deletion).toContain("delete my data");
    expect(deletion).toContain("verwijder mijn data");
    expect(deletion).toContain("Facebook-controlled data");
  });

  it("documents terms for AI outputs, quotas, and Meta separation", () => {
    const terms = renderLegalRoute("/terms").body;

    expect(terms).toContain("AI-generated content");
    expect(terms).toMatch(/quotas/i);
    expect(terms).toContain("not affiliated with or endorsed by Meta");
    expect(terms).toContain("/privacy");
    expect(terms).toContain("/data-deletion");
  });

  it("publishes the one-time Startpilot with signed-in checkout boundaries", () => {
    const privacy = renderLegalRoute("/privacy").body;
    const terms = renderLegalRoute("/terms").body;
    const billingPolicy = renderLegalRoute("/billing-policy").body;
    const plan = getBillingPlan("startpilot_once_v1");
    expect(plan).not.toBeNull();
    if (!plan) throw new Error("Missing Startpilot billing plan");
    const displayedPrice = `€${formatAmountMinor(plan.amountMinor).replace(
      /\.00$/,
      ""
    )}`;

    expect(privacy).toContain(`Mollie processes one ${displayedPrice} payment`);
    expect(terms).toContain(
      `costs ${displayedPrice} as a single payment for 30 days`
    );
    expect(terms).toContain("Purchase starts only in the signed-in portal");
    expect(terms).toContain("guided Messenger image controls");
    expect(terms).not.toContain("AI answers");
    expect(terms).toContain("20 Images 2.0");
    expect(terms).toContain("maximum of five");
    expect(terms).toContain("first AI-provider attempt starts");
    expect(billingPolicy).toContain(
      `${displayedPrice} once in ${plan.currency} for 30 days`
    );
    expect(billingPolicy).toContain(
      "requires an explicit checkout confirmation"
    );
    expect(billingPolicy).toContain("guided Messenger image controls");
    expect(billingPolicy).not.toContain("300 AI answers");
    expect(billingPolicy).toContain("No renewal, top-up or overage");
    expect(billingPolicy).toContain("one workspace, one Facebook Page");
    expect(billingPolicy).toContain(
      "retries within the same request do not consume another pilot generation"
    );
    expect(billingPolicy).not.toContain("billing@leaderbot.live");
    expect(billingPolicy).not.toContain("Bijzondere vrijstellingsregeling");
  });

  it("uses the shared HTML escaper for text inserted into legal pages and receipts", () => {
    expect(escapeHtml(`<script data-owner="O'Reilly">&</script>`)).toBe(
      "&lt;script data-owner=&quot;O&#39;Reilly&quot;&gt;&amp;&lt;/script&gt;"
    );
  });

  it("keeps legal routes available when Startpilot pricing cannot be loaded", () => {
    expect(getStartpilotPricingDisplay(() => null)).toEqual({
      startpilotPrice: "€19",
      startpilotCurrency: "EUR",
    });
    expect(
      getStartpilotPricingDisplay(() => {
        throw new Error("billing catalog unavailable");
      })
    ).toEqual({
      startpilotPrice: "€19",
      startpilotCurrency: "EUR",
    });
  });
});
