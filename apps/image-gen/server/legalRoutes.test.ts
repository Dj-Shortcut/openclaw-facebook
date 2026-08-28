import { describe, expect, it } from "vitest";
import { formatAmountMinor } from "./_core/billing/catalog";
import {
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  getCreditOffer,
} from "./_core/billing/creditCatalog";
import { escapeHtml } from "./_core/html";
import {
  getPremiumCreditPricingDisplay,
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

  it("publishes the one-time premium-credit offer with explicit checkout boundaries", () => {
    const privacy = renderLegalRoute("/privacy").body;
    const terms = renderLegalRoute("/terms").body;
    const billingPolicy = renderLegalRoute("/billing-policy").body;
    const offer = getCreditOffer(
      PREMIUM_IMAGE_CREDIT_OFFER_ID,
      PREMIUM_IMAGE_CREDIT_OFFER_VERSION
    );
    expect(offer).not.toBeNull();
    if (!offer) throw new Error("Missing premium-credit offer");
    const displayedPrice = `€${formatAmountMinor(offer.amountMinor)}`;

    expect(privacy).toContain(`Mollie processes one ${displayedPrice} payment`);
    expect(terms).toContain(
      `cost ${displayedPrice} as a single payment for eight medium-quality image generations`
    );
    expect(terms).toContain("signed checkout link opened from Messenger");
    expect(terms).toContain("Credits do not expire");
    expect(terms).toContain(
      "Provider, publication, or delivery failures do not consume a credit"
    );
    expect(billingPolicy).toContain(
      `${displayedPrice} once in ${offer.amount.currency}`
    );
    expect(billingPolicy).toContain("requires explicit confirmation");
    expect(billingPolicy).toContain("eight medium-quality image credits");
    expect(billingPolicy).toContain("Credits do not expire");
    expect(billingPolicy).toContain("No renewal, top-up or overage");
    expect(billingPolicy).toContain(
      "a retry of the same delivered request does not consume another credit"
    );
    expect(billingPolicy).not.toContain("Startpilot");
    expect(billingPolicy).not.toContain("30-day");
    expect(billingPolicy).not.toContain("one workspace");
    expect(billingPolicy).not.toContain("billing@leaderbot.live");
    expect(billingPolicy).not.toContain("Bijzondere vrijstellingsregeling");
  });

  it("retains the exact legacy Startpilot terms while that separate offer still exists", () => {
    const terms = renderLegalRoute("/terms").body;

    expect(terms).toContain("Separate legacy Startpilot offer");
    expect(terms).toContain("eligible Belgian consumers");
    expect(terms).toContain("costs €19 once");
    expect(terms).toContain("30 days of access");
    expect(terms).toContain("one workspace and one connected Facebook Page");
    expect(terms).toContain("up to 300 AI answers and 20 image generations");
    expect(terms).toContain("limited to 5 images per day");
    expect(terms).toContain(
      "no subscription, direct-debit mandate, automatic top-up or overage charge"
    );
    expect(terms).toContain("separate from the Messenger premium-credit pack");
  });

  it("uses the shared HTML escaper for text inserted into legal pages and receipts", () => {
    expect(escapeHtml(`<script data-owner="O'Reilly">&</script>`)).toBe(
      "&lt;script data-owner=&quot;O&#39;Reilly&quot;&gt;&amp;&lt;/script&gt;"
    );
  });

  it("keeps legal routes available when premium-credit pricing cannot be loaded", () => {
    expect(getPremiumCreditPricingDisplay(() => null)).toEqual({
      premiumCreditPrice: "€4.99",
      premiumCreditCurrency: "EUR",
    });
    expect(
      getPremiumCreditPricingDisplay(() => {
        throw new Error("billing catalog unavailable");
      })
    ).toEqual({
      premiumCreditPrice: "€4.99",
      premiumCreditCurrency: "EUR",
    });
  });
});
