import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_BUSINESS_DETAILS } from "../shared/publicBusinessDetails";
import { PUBLIC_LEGAL_LINKS } from "../shared/publicLegalNavigation";
import { registerLegalRoutes } from "./_core/runtime/legalRoutes";

const LEGAL_PATHS = [
  "/privacy",
  "/terms",
  "/billing-policy",
  "/data-deletion",
] as const;

/** The palette the retired legal template used. It must not come back. */
const RETIRED_STYLE_TOKENS = ["#10211d", "#bef264", "text-stone-100"];

const NEW_STYLE_BACKGROUND = "#f6f2ea";
const NEW_STYLE_INK = "#14203D";

type RegisteredRoute = {
  path: string;
  handler: (request: unknown, response: FakeResponse) => void;
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

function renderLegalRoute(routePath: string): string {
  const routes: RegisteredRoute[] = [];
  registerLegalRoutes({
    get(path: string, handler: RegisteredRoute["handler"]) {
      routes.push({ path, handler });
      return this;
    },
  } as never);
  const route = routes.find(entry => entry.path === routePath);
  if (!route) throw new Error(`Missing legal route: ${routePath}`);
  const response = new FakeResponse();
  route.handler({}, response);
  return response.body;
}

function readClientSource(relativePath: string): string {
  return readFileSync(
    path.resolve(import.meta.dirname, "..", "client", "src", relativePath),
    "utf8"
  );
}

describe("public legal navigation", () => {
  it("publishes exactly the six links the owner shows in the footer", () => {
    expect(PUBLIC_LEGAL_LINKS.map(link => link.href)).toEqual([
      "/privacy",
      "/terms",
      "/billing-policy",
      "/data-deletion",
      `mailto:${PUBLIC_BUSINESS_DETAILS.email}`,
      PUBLIC_BUSINESS_DETAILS.messengerUrl,
    ]);
    expect(PUBLIC_LEGAL_LINKS.map(link => link.label)).toEqual([
      "Privacybeleid",
      "Algemene voorwaarden",
      "Terugbetalingsbeleid",
      "Gegevens verwijderen",
      "Contact",
      "Facebook Messenger",
    ]);
    // Only the Messenger link leaves the site, so only it opens in a new tab.
    expect(PUBLIC_LEGAL_LINKS.filter(link => link.external)).toEqual([
      {
        href: PUBLIC_BUSINESS_DETAILS.messengerUrl,
        label: "Facebook Messenger",
        external: true,
      },
    ]);
  });

  it("keeps the footer reading the one shared navigation set", () => {
    const footer = readClientSource("components/Footer.tsx");
    expect(footer).toContain("PUBLIC_LEGAL_LINKS");
    expect(footer).not.toContain('label: "Privacybeleid"');
  });
});

describe("server-rendered legal pages", () => {
  it.each(LEGAL_PATHS)("renders %s in the current site style", routePath => {
    const html = renderLegalRoute(routePath);

    expect(html).toContain(NEW_STYLE_BACKGROUND);
    expect(html).toContain(NEW_STYLE_INK);
    for (const retired of RETIRED_STYLE_TOKENS) {
      expect(html).not.toContain(retired);
    }
  });

  it.each(LEGAL_PATHS)("gives %s the shared header and footer", routePath => {
    const html = renderLegalRoute(routePath);

    expect(html).toContain('<header class="site-header">');
    expect(html).toContain('aria-label="Leaderbot home"');
    expect(html).toContain('<footer class="site-footer">');
    expect(html).toContain('aria-label="Juridische informatie"');
    for (const link of PUBLIC_LEGAL_LINKS) {
      expect(html).toContain(`href="${link.href}"`);
      expect(html).toContain(`>${link.label}</a>`);
    }
    // The real Messenger destination, in the header CTA and the footer link.
    expect(
      html.split(PUBLIC_BUSINESS_DETAILS.messengerUrl).length - 1
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(LEGAL_PATHS)(
    "keeps %s readable without JavaScript or bundled assets",
    routePath => {
      const html = renderLegalRoute(routePath);

      // Meta app review fetches these URLs directly; they must not depend on
      // the SPA bundle to show the policy text.
      expect(html).not.toContain("<script");
      expect(html).toContain('<meta name="viewport"');
      expect(html).toContain('<meta name="robots" content="index,follow"');
      expect(html).toContain("privacy@leaderbot.live");
    }
  );
});

describe("client legal pages", () => {
  it("uses the current palette instead of the retired dark template", () => {
    const legal = readClientSource("pages/Legal.tsx");

    expect(legal).toContain(NEW_STYLE_BACKGROUND);
    expect(legal).toContain(NEW_STYLE_INK);
    for (const retired of RETIRED_STYLE_TOKENS) {
      expect(legal).not.toContain(retired);
    }
  });

  it("keeps the brand header and the real Messenger destination", () => {
    const legal = readClientSource("pages/Legal.tsx");

    expect(legal).toContain('aria-label="Leaderbot home"');
    expect(legal).toContain("PUBLIC_BUSINESS_DETAILS.messengerUrl");
  });
});
