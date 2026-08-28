import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "../../../shared/publicBusinessDetails";
import type express from "express";
import { formatAmountMinor } from "../billing/catalog";
import {
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  getCreditOffer,
} from "../billing/creditCatalog";
import { formatFaceMemoryRetentionDays } from "../faceMemoryRetention";
import { escapeHtml } from "../html";

type LegalPage = {
  title: string;
  intro: string;
  sections: Array<{ heading: string; html: string }>;
};

const FALLBACK_PREMIUM_CREDIT_PRICING = Object.freeze({
  premiumCreditPrice: "€4.99",
  premiumCreditCurrency: "EUR",
});

export function getPremiumCreditPricingDisplay(
  lookupOffer: typeof getCreditOffer = getCreditOffer
) {
  try {
    const offer = lookupOffer(
      PREMIUM_IMAGE_CREDIT_OFFER_ID,
      PREMIUM_IMAGE_CREDIT_OFFER_VERSION
    );
    if (!offer) return FALLBACK_PREMIUM_CREDIT_PRICING;
    return {
      premiumCreditPrice: `€${formatAmountMinor(offer.amountMinor)}`,
      premiumCreditCurrency: offer.amount.currency,
    };
  } catch {
    return FALLBACK_PREMIUM_CREDIT_PRICING;
  }
}

export function registerLegalRoutes(app: express.Express) {
  app.get("/privacy", (_req, res) => {
    const faceMemoryRetention = formatFaceMemoryRetentionDays("en");
    const { premiumCreditPrice } = getPremiumCreditPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Privacy Policy",
        intro:
          "Leaderbot is a workspace-based AI assistant portal. Customer settings, assistant context, knowledge records, channel data and privacy requests remain scoped to the owning workspace.",
        sections: [
          {
            heading: "Data used to provide Leaderbot",
            html: "<p>Leaderbot may process account and workspace details, assistant instructions, knowledge-source records, Messenger messages and metadata, images submitted for generation or editing, usage data, and export or deletion requests. We process only what is needed to operate, secure and support the service.</p>",
          },
          {
            heading: "Workspace separation",
            html: "<p>Customer content is private by default and is not intentionally shared or searchable across customer workspaces. Operational logs should contain redacted identifiers and service metadata rather than raw messages, prompts, uploaded knowledge or access tokens.</p>",
          },
          {
            heading: "Images and optional photo memory",
            html: `<p>Images are processed to generate or edit the result you request. If you give explicit permission, optional photo memory can retain an uploaded photo for at most ${escapeHtml(faceMemoryRetention)} so you do not need to upload it for every request. You can withdraw that consent at any time.</p>`,
          },
          {
            heading: "Messenger, Meta and service providers",
            html: "<p>Meta controls Facebook and Messenger account data and message history retained on its systems. Leaderbot may use hosting, AI or image-processing providers only as needed to provide the requested service. Customer data is not shared for advertising.</p>",
          },
          {
            heading: "Retention and your choices",
            html: '<p>Retention depends on the feature and legal obligations. Where available, workspace members can request export or deletion through the portal. Messenger users can request deletion by sending <strong>delete my data</strong> or <strong>verwijder mijn data</strong>, or by contacting <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a>.</p>',
          },
          {
            heading: "Payments",
            html: `<p>A premium-credit purchase starts only from a signed checkout link opened from Messenger. Mollie processes one ${premiumCreditPrice} payment after the customer reviews and confirms checkout. The purchase adds eight medium-quality image credits that do not expire. It does not create a subscription, automatic renewal, direct-debit mandate, automatic top-up or overage charge.</p>`,
          },
        ],
      })
    );
  });

  app.get("/terms", (_req, res) => {
    const { premiumCreditPrice } = getPremiumCreditPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Terms of Service",
        intro:
          "These terms apply to the Leaderbot Messenger image experience. Leaderbot provides AI-generated images and guided Messenger controls together with usage and privacy controls.",
        sections: [
          {
            heading: "Premium image credits",
            html: `<p>Leaderbot premium credits cost ${premiumCreditPrice} as a single payment for eight medium-quality image generations. Credits do not expire. One credit is consumed only after a usable generated image is successfully delivered through Messenger. Provider, publication, or delivery failures do not consume a credit. Purchase starts only from a signed checkout link opened from Messenger and requires explicit confirmation before continuing to Mollie.</p>`,
          },
          {
            heading: "No subscription or overage",
            html: "<p>A credit pack does not renew automatically and does not create a subscription or direct-debit mandate. Usage stops when no free or paid credits remain. There are no automatic top-ups or additional usage charges. Every later purchase requires a separate, explicit choice.</p>",
          },
          {
            heading: "Separate legacy Startpilot offer",
            html: "<p>Leaderbot Startpilot is a separate legacy one-time offer for eligible Belgian consumers. It costs €19 once and provides 30 days of access for one workspace and one connected Facebook Page, with up to 300 AI answers and 20 image generations, limited to 5 images per day. It does not renew automatically and creates no subscription, direct-debit mandate, automatic top-up or overage charge. Startpilot access and quotas are separate from the Messenger premium-credit pack.</p>",
          },
          {
            heading: "AI-generated content",
            html: "<p>AI-generated images can be inaccurate, incomplete or unexpected. Review images before relying on, publishing or sharing them. Do not use Leaderbot for unlawful, harmful, deceptive or infringing content.</p>",
          },
          {
            heading: "Messenger connection and limits",
            html: "<p>You may connect only a Facebook Page that you are authorized to manage. Quotas, rate limits, budget limits, abuse protection and temporary safety restrictions may apply and are shown in the portal where relevant.</p>",
          },
          {
            heading: "Platform separation",
            html: "<p>Leaderbot is an independent service and is not affiliated with or endorsed by Meta. Messenger availability, message delivery and Facebook account features also depend on Meta’s terms and systems.</p>",
          },
          {
            heading: "Privacy and deletion",
            html: '<p>See the <a href="/privacy">Privacy Policy</a> and <a href="/data-deletion">Data Deletion</a> instructions. Privacy, export and deletion requests can be sent to <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a>. Mandatory rights under applicable law always prevail.</p>',
          },
        ],
      })
    );
  });

  app.get("/billing-policy", (_req, res) => {
    const { premiumCreditPrice, premiumCreditCurrency } =
      getPremiumCreditPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Premium Credit Pricing and Billing Information",
        intro:
          "Leaderbot offers a one-time premium image-credit pack. A purchase starts only from a signed checkout link opened from Messenger and requires explicit confirmation.",
        sections: [
          {
            heading: "One-time price",
            html: `<p>One premium credit pack costs ${premiumCreditPrice} once in ${premiumCreditCurrency}. The checkout page shows the exact amount and package before the customer continues to Mollie.</p>`,
          },
          {
            heading: "Included usage",
            html: "<p>The pack adds eight medium-quality image credits. Credits do not expire. One credit is permanently consumed only after a usable generated image is successfully delivered through Messenger. Provider, publication, or delivery failures do not consume a credit, and a retry of the same delivered request does not consume another credit.</p>",
          },
          {
            heading: "No renewal, top-up or overage",
            html: "<p>A credit pack is a single purchase without automatic renewal, subscription or direct-debit mandate. Usage stops when no free or paid credits remain. No automatic top-up or additional usage fee is charged, and another pack requires a separate explicit choice.</p>",
          },
          {
            heading: "No payment from a message or link",
            html: "<p>Sending a Messenger message or opening a signed checkout link does not authorize a payment. A payment can start only after the customer explicitly confirms the displayed credit pack and continues to Mollie.</p>",
          },
          {
            heading: "Before payment",
            html: `<p>Before any payment, Leaderbot shows the ${premiumCreditPrice} total price, eight included medium-quality credits, that credits do not expire, the absence of renewal and overage, and applicable cancellation and refund terms.</p>`,
          },
          {
            heading: "Questions",
            html: '<p>For pricing, privacy or support questions, contact <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a>. Do not send payment credentials or API keys by email.</p>',
          },
        ],
      })
    );
  });

  app.get("/data-deletion", (_req, res) => {
    res.type("html").send(
      renderLegalPage({
        title: "User Data Deletion Instructions",
        intro:
          "Leaderbot supports workspace export and deletion requests and Messenger deletion requests for service-controlled data.",
        sections: [
          {
            heading: "Portal requests",
            html: "<p>Signed-in workspace members can create export or deletion requests from the customer portal where those controls are available.</p>",
          },
          {
            heading: "Messenger requests",
            html: '<p>Send <strong>delete my data</strong> or <strong>verwijder mijn data</strong> in Messenger. You can also email <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a> with your Facebook profile name and the approximate time you contacted the Page so the request can be identified.</p>',
          },
          {
            heading: "Facebook-controlled data",
            html: "<p>Facebook-retained message history and account data must be managed through Facebook or Meta account controls because Leaderbot cannot delete data held by Meta/Facebook.</p>",
          },
          {
            heading: "Required records",
            html: "<p>Some security, legal or accounting records may need to be retained for a required period. In that case access is restricted and identifying data is minimized or pseudonymized where possible.</p>",
          },
        ],
      })
    );
  });
}

function renderLegalPage(page: LegalPage): string {
  const sections = page.sections
    .map(
      section => `
        <section>
          <h2>${escapeHtml(section.heading)}</h2>
          ${section.html}
        </section>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="index,follow" />
  <title>${escapeHtml(page.title)} – Leaderbot</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #10211d; color: #d6d3d1; font: 16px/1.65 Arial, sans-serif; }
    main { max-width: 780px; margin: 0 auto; padding: 40px 24px 64px; }
    h1, h2, strong { color: #fff; }
    h1 { font-size: clamp(2rem, 6vw, 3rem); line-height: 1.1; margin: 20px 0 12px; }
    h2 { font-size: 1.15rem; margin-top: 0; }
    section, address { margin-top: 16px; padding: 20px; border: 1px solid rgba(255,255,255,.1); border-radius: 16px; background: rgba(255,255,255,.04); }
    address { font-style: normal; }
    a { color: #bef264; }
    .back { font-weight: 700; text-decoration: none; }
    .updated { margin-top: 28px; color: #a8a29e; font-size: .8rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .intro { font-size: 1.05rem; }
  </style>
</head>
<body>
  <main>
    <a class="back" href="/">Back to Leaderbot</a>
    <p class="updated">Last updated 28 August 2026</p>
    <h1>${escapeHtml(page.title)}</h1>
    <p class="intro">${escapeHtml(page.intro)}</p>
    ${sections}
    ${renderBusinessDetails()}
  </main>
</body>
</html>`;
}

function renderBusinessDetails(): string {
  const business = PUBLIC_BUSINESS_DETAILS;
  return `<address>
    <strong>${escapeHtml(business.brandName)} · ${escapeHtml(business.legalName)}</strong><br />
    Enterprise number ${escapeHtml(business.enterpriseNumber)} · VAT ${escapeHtml(business.vatNumber)}<br />
    ${escapeHtml(formatPublicBusinessAddress())}<br />
    <a href="tel:${escapeHtml(business.phoneHref)}">${escapeHtml(business.phoneDisplay)}</a> ·
    <a href="mailto:${escapeHtml(business.email)}">${escapeHtml(business.email)}</a>
  </address>`;
}
