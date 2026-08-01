import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "../../../shared/publicBusinessDetails";
import type express from "express";
import {
  STARTPILOT_PLAN_CODE,
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

const FALLBACK_STARTPILOT_PRICING = Object.freeze({
  startpilotPrice: "€19",
  startpilotCurrency: "EUR",
});

export function getStartpilotPricingDisplay(
  lookupPlan: typeof getBillingPlan = getBillingPlan
) {
  try {
    const startpilotPlan = lookupPlan(STARTPILOT_PLAN_CODE);
    if (!startpilotPlan) return FALLBACK_STARTPILOT_PRICING;
    return {
      startpilotPrice: `€${formatAmountMinor(
        startpilotPlan.amountMinor
      ).replace(/\.00$/, "")}`,
      startpilotCurrency: startpilotPlan.currency,
    };
  } catch {
    return FALLBACK_STARTPILOT_PRICING;
  }
}

export function registerLegalRoutes(app: express.Express) {
  app.get("/privacy", (_req, res) => {
    const faceMemoryRetention = formatFaceMemoryRetentionDays("en");
    const { startpilotPrice } = getStartpilotPricingDisplay();
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
            html: `<p>The public website currently collects interest only. If the signed-in pilot checkout is enabled after the launch gates pass, Mollie will process one ${startpilotPrice} Startpilot payment. The proposed pilot does not create a subscription, automatic renewal, direct-debit mandate, top-up or overage charge.</p>`,
          },
        ],
      })
    );
  });

  app.get("/terms", (_req, res) => {
    const { startpilotPrice } = getStartpilotPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Terms of Service",
        intro:
          "These pilot terms apply to the Leaderbot customer portal and connected Messenger assistant. Leaderbot provides AI-generated text and images together with workspace, usage and privacy controls.",
        sections: [
          {
            heading: "Draft Startpilot offer",
            html: `<p>Leaderbot Startpilot is proposed at ${startpilotPrice} as a single payment for 30 days. It includes one workspace, one connected Facebook Page, 300 AI answers and 20 Images 2.0 image generations, with a maximum of five image generations per day. An image generation counts once when its first AI-provider attempt starts; retries within that same request do not consume extra pilot generations. The public website is interest-only while paid launch remains disabled.</p>`,
          },
          {
            heading: "No subscription or overage",
            html: "<p>The proposed Startpilot does not renew automatically and does not create a subscription or direct-debit mandate. Usage stops at the included limits; there are no automatic top-ups or additional usage charges. Any later offer requires a separate, explicit choice.</p>",
          },
          {
            heading: "AI-generated content",
            html: "<p>AI output can be inaccurate, incomplete or unexpected. Review text and images before relying on, publishing or sharing them. Do not use Leaderbot for unlawful, harmful, deceptive or infringing content.</p>",
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
    const { startpilotPrice, startpilotCurrency } =
      getStartpilotPricingDisplay();
    res.type("html").send(
      renderLegalPage({
        title: "Startpilot Pre-launch Pricing and Billing Information",
        intro:
          "Leaderbot is validating a bounded one-time pilot before opening payments. The public website currently collects interest only and does not create a purchase.",
        sections: [
          {
            heading: "Proposed one-time price",
            html: `<p>The current proposal is Leaderbot Startpilot at ${startpilotPrice} once in ${startpilotCurrency} for 30 days. This is pre-launch information, not a present charge. Checkout may appear only inside the signed-in portal after the technical, entitlement, legal and accounting launch gates pass.</p>`,
          },
          {
            heading: "Included pilot usage",
            html: "<p>The proposed package covers one workspace, one Facebook Page, 300 AI answers and 20 Images 2.0 image generations. Image generation is additionally limited to five per day during the 30-day access period. A generation counts once when its first AI-provider attempt starts; retries within the same request do not consume another pilot generation.</p>",
          },
          {
            heading: "No renewal, top-up or overage",
            html: "<p>The Startpilot is a single purchase without automatic renewal, subscription or direct-debit mandate. Usage stops at the included limits. No automatic top-up or additional usage fee is charged, and continuing later requires a separate explicit choice.</p>",
          },
          {
            heading: "No payment from an interest request",
            html: "<p>Sending an email or early-access request does not authorize a payment or create a contract. A payment can start only from an explicitly enabled checkout shown to an authenticated workspace owner or administrator.</p>",
          },
          {
            heading: "Before paid launch",
            html: "<p>Before any payment, Leaderbot will show the total price, 30-day access period, included usage, payment method, absence of renewal and overage, and applicable cancellation, refund, consumer or business terms. Payment and invoicing flows must first pass technical, legal and accounting review.</p>",
          },
          {
            heading: "Questions",
            html: '<p>For pre-launch pricing, privacy or support questions, contact <a href="mailto:privacy@leaderbot.live">privacy@leaderbot.live</a>. Do not send payment credentials or API keys by email.</p>',
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
    <p class="updated">Last updated 1 August 2026</p>
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
