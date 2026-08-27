import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "../../../shared/publicBusinessDetails";
import type express from "express";
import {
  PREMIUM_IMAGE_CREDITS_PER_PURCHASE,
  PREMIUM_IMAGE_CREDITS_PLAN_CODE,
  formatAmountMinor,
  getBillingPlan,
} from "../billing/catalog";
import { formatFaceMemoryRetentionDays } from "../faceMemoryRetention";
import { escapeHtml } from "../html";

type LegalPage = {
  title: string;
  intro: string;
  sections: Array<{ heading: string; html: string }>;
};

const FALLBACK_CREDIT_PRICING = Object.freeze({
  price: "€3",
  currency: "EUR",
});

export function getPremiumCreditPricingDisplay(
  lookupPlan: typeof getBillingPlan = getBillingPlan
) {
  try {
    const plan = lookupPlan(PREMIUM_IMAGE_CREDITS_PLAN_CODE);
    if (!plan) return FALLBACK_CREDIT_PRICING;
    return {
      price: `€${formatAmountMinor(plan.amountMinor).replace(/\.00$/, "")}`,
      currency: plan.currency,
    };
  } catch {
    return FALLBACK_CREDIT_PRICING;
  }
}

export function registerLegalRoutes(app: express.Express) {
  app.get("/privacy", (_req, res) => {
    const faceMemoryRetention = formatFaceMemoryRetentionDays("en");
    const { price } = getPremiumCreditPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Privacy Policy",
        intro:
          "Leaderbot is an owner-operated Messenger image assistant. Each Messenger user has separate pseudonymous state, quota and purchased-credit records.",
        sections: [
          {
            heading: "Data used to provide Leaderbot",
            html: "<p>Leaderbot may process Messenger messages and metadata, images submitted for generation or editing, pseudonymous usage and credit records, and deletion or support requests. We process only what is needed to operate, secure and support the service.</p>",
          },
          {
            heading: "User separation",
            html: "<p>One Messenger user cannot access another user's prompts, images, quota or purchased credits. Operational logs contain redacted identifiers and service metadata rather than raw messages, prompts, photos or payment credentials.</p>",
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
            html: `<p>After the free daily allowance is used, Messenger may show an optional checkout for ${PREMIUM_IMAGE_CREDITS_PER_PURCHASE} premium image credits. Mollie processes one ${price} payment only after explicit confirmation. This creates no subscription, automatic renewal, mandate, automatic top-up or overage charge.</p>`,
          },
        ],
      })
    );
  });

  app.get("/terms", (_req, res) => {
    const { price } = getPremiumCreditPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Terms of Service",
        intro:
          "These terms apply to the Leaderbot Messenger image experience, its free daily allowance and optional one-time premium credits.",
        sections: [
          {
            heading: "Premium credit offer",
            html: `<p>${PREMIUM_IMAGE_CREDITS_PER_PURCHASE} premium image credits cost ${price} as a single Mollie payment. They have no product expiry date and remain separate from the resetting free allowance. Checkout starts only from a short-lived button offered to the exact Messenger user after free credits are exhausted. A credit is committed for one durable successful premium result. Failures before provider transport release the reservation; an uncertain provider outcome is held for safe reconciliation instead of risking a duplicate charge.</p>`,
          },
          {
            heading: "No subscription or overage",
            html: "<p>Premium credits do not renew automatically and create no subscription or direct-debit mandate. There are no automatic top-ups or additional usage charges. Every later bundle requires a separate explicit choice.</p>",
          },
          {
            heading: "AI-generated content",
            html: "<p>AI-generated images can be inaccurate, incomplete or unexpected. Review images before relying on, publishing or sharing them. Do not use Leaderbot for unlawful, harmful, deceptive or infringing content.</p>",
          },
          {
            heading: "Messenger connection and limits",
            html: "<p>The service owner connects the Facebook Page. Per-user quotas, rate limits, global budget limits, abuse protection and temporary safety restrictions may apply.</p>",
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
    const { price, currency } = getPremiumCreditPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Premium Credit Pricing and Billing Information",
        intro:
          "Leaderbot offers an optional one-time premium image-credit bundle after the free daily allowance is exhausted.",
        sections: [
          {
            heading: "One-time price",
            html: `<p>${PREMIUM_IMAGE_CREDITS_PER_PURCHASE} premium image credits cost ${price} once in ${currency}. The exact user reviews the amount and no-subscription disclosure before continuing to Mollie.</p>`,
          },
          {
            heading: "Included usage",
            html: "<p>Each credit authorizes one premium-quality image result. Purchased credits have no product expiry date and are separate from the resetting free daily allowance. A failure before provider transport releases its reservation. An uncertain provider outcome is held for reconciliation so Leaderbot cannot issue a duplicate billable request.</p>",
          },
          {
            heading: "No renewal, top-up or overage",
            html: "<p>The bundle is a single purchase without automatic renewal, subscription or direct-debit mandate. No automatic top-up or additional usage fee is charged.</p>",
          },
          {
            heading: "No payment from an interest request",
            html: "<p>Sending a message does not authorize a payment. Checkout starts only after the user presses the short-lived premium-credit button and confirms the displayed offer.</p>",
          },
          {
            heading: "Before payment",
            html: "<p>Before payment, Leaderbot shows the total price, credit count, premium quality, payment method, absence of renewal and overage, and applicable cancellation and refund terms.</p>",
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
    <p class="updated">Last updated 27 August 2026</p>
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
