import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "../../../shared/publicBusinessDetails";
import { PUBLIC_LEGAL_LINKS } from "../../../shared/publicLegalNavigation";
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
          "Leaderbot is an owner-operated Messenger image service. Conversation, quota, purchase and privacy state remain scoped to the owning Page and pseudonymous Messenger user.",
        sections: [
          {
            heading: "Data used to provide Leaderbot",
            html: "<p>Leaderbot may process Messenger messages and metadata, images submitted for generation or editing, usage data, and deletion requests. We process only what is needed to operate, secure and support the service.</p>",
          },
          {
            heading: "Workspace separation",
            html: "<p>Your content is private by default and is not intentionally shared with other users. Operational logs should contain redacted identifiers and service metadata rather than raw messages, prompts, uploaded media or access tokens.</p>",
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
            html: '<p>Retention depends on the feature and legal obligations. Messenger users can request deletion by sending <strong>delete my data</strong> or <strong>verwijder mijn data</strong>, or by contacting <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a>.</p>',
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
            heading: "AI-generated content",
            html: "<p>AI-generated images can be inaccurate, incomplete or unexpected. Review images before relying on, publishing or sharing them. Do not use Leaderbot for unlawful, harmful, deceptive or infringing content.</p>",
          },
          {
            heading: "Messenger connection and limits",
            html: "<p>You may connect only a Facebook Page that you are authorized to manage. Quotas, rate limits, budget limits, abuse protection and temporary safety restrictions may apply.</p>",
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
          "Leaderbot supports Messenger deletion requests for service-controlled data.",
        sections: [
          {
            heading: "Data requests",
            html: '<p>Messenger users can request deletion by sending <strong>delete my data</strong> or <strong>verwijder mijn data</strong>, or by contacting <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a>.</p>',
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
  <meta name="theme-color" content="#f6f2ea" />
  <title>${escapeHtml(page.title)} – Leaderbot</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f6f2ea;
      color: #14203D;
      font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    a { color: #2541C9; }
    a:focus-visible, button:focus-visible { outline: 2px solid #2541C9; outline-offset: 2px; }
    .skip { position: absolute; left: -9999px; }
    .skip:focus { left: 16px; top: 16px; z-index: 50; background: #fff; padding: 8px 16px; border-radius: 6px; font-weight: 600; text-decoration: none; }
    .site-header { position: sticky; top: 0; z-index: 40; border-bottom: 1px solid rgba(20,32,61,.1); background: rgba(246,242,234,.9); backdrop-filter: blur(8px); }
    .bar { max-width: 1280px; margin: 0 auto; padding: 12px 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
    .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
    .brand .mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(135deg,#2541C9,#8B2FE0); color: #fff; font-weight: 900; }
    .brand strong { display: block; font-size: 1rem; }
    .brand span.host { display: block; font-size: .75rem; color: rgba(20,32,61,.7); }
    .cta { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 20px; border-radius: 9999px; font-size: .875rem; font-weight: 700; text-decoration: none; color: #fff; background: linear-gradient(120deg,#2541C9,#8B2FE0); box-shadow: 0 14px 30px -14px rgba(37,65,201,.6); }
    main { max-width: 768px; margin: 0 auto; padding: 32px 16px 56px; }
    .back { display: inline-block; font-size: .875rem; font-weight: 600; text-decoration: none; }
    .updated { margin-top: 24px; margin-bottom: 0; color: rgba(20,32,61,.65); font-size: .75rem; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    h1 { font-size: clamp(1.875rem, 5vw, 2.25rem); line-height: 1.15; margin: 12px 0 0; }
    .intro { margin-top: 16px; font-size: 1rem; line-height: 1.75; color: rgba(20,32,61,.8); }
    section { margin-top: 16px; padding: 20px; border: 1px solid rgba(20,32,61,.12); border-radius: 16px; background: #fff; }
    section h2 { margin: 0; font-size: 1.125rem; }
    section p { margin: 8px 0 0; font-size: .9375rem; line-height: 1.7; color: rgba(20,32,61,.8); }
    address.business { margin-top: 24px; padding: 20px; border: 1px solid rgba(37,65,201,.2); border-radius: 16px; background: rgba(37,65,201,.05); font-style: normal; font-size: .875rem; line-height: 1.7; }
    .site-footer { border-top: 1px solid rgba(20,32,61,.12); background: #f6f2ea; }
    .site-footer .bar { align-items: flex-end; padding: 32px 16px; font-size: .875rem; color: rgba(20,32,61,.75); }
    .site-footer address { font-style: normal; line-height: 1.6; }
    .site-footer nav { display: flex; flex-wrap: wrap; gap: 8px 16px; }
    @media (min-width: 640px) { .bar { padding-left: 24px; padding-right: 24px; } }
    @media (min-width: 1024px) { .bar { padding-left: 32px; padding-right: 32px; } }
  </style>
</head>
<body>
  <a class="skip" href="#legal-content">Skip to content</a>
  ${renderSiteHeader()}
  <main id="legal-content">
    <a class="back" href="/">← Back to Leaderbot</a>
    <p class="updated">Last updated 28 August 2026</p>
    <h1>${escapeHtml(page.title)}</h1>
    <p class="intro">${escapeHtml(page.intro)}</p>
    ${sections}
    ${renderBusinessDetails()}
  </main>
  ${renderSiteFooter()}
</body>
</html>`;
}

function renderSiteHeader(): string {
  const business = PUBLIC_BUSINESS_DETAILS;
  return `<header class="site-header">
    <div class="bar">
      <a class="brand" href="/" aria-label="Leaderbot home">
        <span class="mark" aria-hidden="true">L</span>
        <span>
          <strong>${escapeHtml(business.brandName)}</strong>
          <span class="host">leaderbot.live</span>
        </span>
      </a>
      <a class="cta" href="${escapeHtml(business.messengerUrl)}" rel="noreferrer" target="_blank">Openen in Messenger</a>
    </div>
  </header>`;
}

function renderSiteFooter(): string {
  const business = PUBLIC_BUSINESS_DETAILS;
  const links = PUBLIC_LEGAL_LINKS.map(
    link =>
      `<a href="${escapeHtml(link.href)}"${
        link.external ? ' rel="noreferrer" target="_blank"' : ""
      }>${escapeHtml(link.label)}</a>`
  ).join("");
  return `<footer class="site-footer">
    <div class="bar">
      <address>
        <strong>${escapeHtml(business.brandName)} · ${escapeHtml(business.legalName)}</strong><br />
        ${escapeHtml(formatPublicBusinessAddress())} · KBO ${escapeHtml(business.enterpriseNumber)}<br />
        <a href="tel:${escapeHtml(business.phoneHref)}">${escapeHtml(business.phoneDisplay)}</a> ·
        <a href="mailto:${escapeHtml(business.email)}">${escapeHtml(business.email)}</a>
      </address>
      <nav aria-label="Juridische informatie">${links}</nav>
    </div>
  </footer>`;
}

function renderBusinessDetails(): string {
  const business = PUBLIC_BUSINESS_DETAILS;
  return `<address class="business">
    <strong>${escapeHtml(business.brandName)} · ${escapeHtml(business.legalName)}</strong><br />
    Enterprise number ${escapeHtml(business.enterpriseNumber)} · VAT ${escapeHtml(business.vatNumber)}<br />
    ${escapeHtml(formatPublicBusinessAddress())}<br />
    <a href="tel:${escapeHtml(business.phoneHref)}">${escapeHtml(business.phoneDisplay)}</a> ·
    <a href="mailto:${escapeHtml(business.email)}">${escapeHtml(business.email)}</a>
  </address>`;
}
