import fs from "node:fs";
import { describe, expect, it } from "vitest";

// This is a source-wiring contract, not a browser rendering assertion. The
// locale tests validate the copy itself without a JSX/browser test framework.
const source = fs.readFileSync(
  new URL("./LandingPage.tsx", import.meta.url),
  "utf8"
);

describe("landing purchase guidance wiring", () => {
  it("uses mode-neutral guidance for the visible copy and FAQ metadata", () => {
    expect(source).not.toMatch(
      /commercialBillingAvailable|unavailablePremiumCopies/
    );
    expect(source).toContain(
      "const premiumGuidance = messengerPremiumCopies[locale]"
    );
    for (const field of [
      "badge",
      "microLine",
      "note",
      "mollieCardBody",
      "creditsCardBody",
      "faqAnswer",
    ]) {
      expect(source).toContain(`premiumGuidance.${field}`);
    }
    expect(source).toContain("mainEntity: questions.map");
    expect(source).toContain(
      'acceptedAnswer: { "@type": "Answer", text: item.answer }'
    );
    expect(source).toContain("questions.map");
  });

  it("keeps the existing offer and Messenger CTA destination without a public checkout API", () => {
    expect(source).toContain("{copy.credits.price}");
    expect(source).toContain("copy.credits.features.map");
    expect(source).toContain("href={PUBLIC_BUSINESS_DETAILS.messengerUrl}");
    expect(source).not.toMatch(
      /\/api\/credits|commercialAvailability|useQuery|fetch\(/
    );
  });
});
