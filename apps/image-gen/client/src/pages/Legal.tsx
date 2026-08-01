import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "@shared/publicBusinessDetails";
import { Link } from "wouter";

type LegalPageKind = "privacy" | "terms" | "billing-policy" | "data-deletion";

type LegalPageCopy = {
  title: string;
  intro: string;
  sections: Array<{ heading: string; body: string }>;
};

const legalCopy: Record<LegalPageKind, LegalPageCopy> = {
  privacy: {
    title: "Privacy Policy",
    intro:
      "Leaderbot is a workspace-based AI assistant portal. Customer settings, assistant context, knowledge records, channel data and privacy requests remain scoped to the owning workspace.",
    sections: [
      {
        heading: "Data used to provide Leaderbot",
        body: "Leaderbot may process account and workspace details, assistant instructions, knowledge-source records, Messenger messages and metadata, images submitted for generation or editing, usage data, and export or deletion requests. We process only what is needed to operate, secure and support the service.",
      },
      {
        heading: "Workspace separation",
        body: "Customer content is private by default and is not intentionally shared or searchable across customer workspaces. Operational logs should contain redacted identifiers and service metadata rather than raw messages, prompts, uploaded knowledge or access tokens.",
      },
      {
        heading: "Messenger, Meta and service providers",
        body: "Meta controls Facebook and Messenger account data and message history retained on its systems. Leaderbot may use hosting, AI or image-processing providers only as needed to provide the requested service; customer data is not shared for advertising.",
      },
      {
        heading: "Retention and your choices",
        body: "Retention depends on the feature and legal obligations. Where available, workspace members can request export or deletion through the portal. Messenger users can request deletion by sending ‘delete my data’ or ‘verwijder mijn data’, or by contacting privacy@leaderbot.live.",
      },
      {
        heading: "Payments",
        body: "Paid subscriptions and checkout are not active on this website. No Leaderbot subscription or recurring payment is created when you send an early-access request. This policy will be updated before payment processing is opened.",
      },
    ],
  },
  terms: {
    title: "Terms of Service",
    intro:
      "These pilot terms apply to the Leaderbot customer portal and connected Messenger assistant. Leaderbot provides AI-generated text and images together with workspace, usage and privacy controls.",
    sections: [
      {
        heading: "Pilot phase and price information",
        body: "Leaderbot Premium is planned at €29 per month, but it is not currently for sale. This website does not start a paid contract, checkout, automatic renewal or direct debit. Final inclusions and payment terms will be published before sales begin.",
      },
      {
        heading: "AI outputs",
        body: "AI output can be inaccurate, incomplete or unexpected. Review text and images before relying on, publishing or sharing them. Do not use Leaderbot for unlawful, harmful, deceptive or infringing content.",
      },
      {
        heading: "Messenger connection",
        body: "You may connect only a Facebook Page that you are authorized to manage. Usage limits, budget limits, abuse protection and temporary safety restrictions may apply and are shown in the portal where relevant.",
      },
      {
        heading: "Platform separation",
        body: "Leaderbot is an independent service and is not affiliated with or endorsed by Meta. Messenger availability, message delivery and Facebook account features also depend on Meta’s terms and systems.",
      },
      {
        heading: "Privacy and deletion",
        body: "The Privacy Policy explains how personal data is handled. Privacy, export and deletion requests can be sent to privacy@leaderbot.live. Mandatory rights under applicable law always prevail.",
      },
    ],
  },
  "billing-policy": {
    title: "Pre-launch Pricing and Billing Information",
    intro:
      "Leaderbot is validating demand before opening payments. There is currently no checkout and no active paid Leaderbot subscription available through this website.",
    sections: [
      {
        heading: "Planned Premium price",
        body: "The current proposal is Leaderbot Premium at €29 per month in EUR. This is a future price indication, not a present charge. Final included usage limits are still being validated.",
      },
      {
        heading: "No payment or renewal today",
        body: "Sending an email or early-access request does not authorize a payment, create a subscription, start automatic renewal or establish a direct-debit mandate.",
      },
      {
        heading: "Before paid launch",
        body: "Before any payment, Leaderbot will clearly show the total price, billing period, included usage, payment method, renewal, cancellation, refund and applicable consumer or business terms. Payment and invoicing flows must first pass technical, legal and accounting review.",
      },
      {
        heading: "Questions",
        body: "For pre-launch pricing, privacy or support questions, contact privacy@leaderbot.live. Do not send payment credentials or API keys by email.",
      },
    ],
  },
  "data-deletion": {
    title: "Data Deletion",
    intro:
      "Leaderbot supports workspace export and deletion requests and Messenger deletion requests for service-controlled data.",
    sections: [
      {
        heading: "Portal requests",
        body: "Signed-in workspace members can create export or deletion requests from the customer portal where those controls are available.",
      },
      {
        heading: "Messenger requests",
        body: "Messenger users can send ‘delete my data’ or ‘verwijder mijn data’. You can also email privacy@leaderbot.live with your Facebook profile name and the approximate time you contacted the Page so the request can be identified.",
      },
      {
        heading: "Meta-controlled data",
        body: "Facebook-retained message history and account data must be managed through Facebook or Meta account controls because Leaderbot cannot delete data held by Meta.",
      },
      {
        heading: "Required records",
        body: "Some security, legal or accounting records may need to be retained for a required period. In that case access is restricted and identifying data is minimized or pseudonymized where possible.",
      },
    ],
  },
};

function LegalPage({ page }: { page: LegalPageKind }) {
  const copy = legalCopy[page];

  return (
    <main
      className="min-h-full bg-[#10211d] px-4 py-10 text-stone-100 sm:px-6 lg:px-8"
      lang="en"
    >
      <div className="mx-auto max-w-3xl">
        <Link
          className="text-sm font-medium text-lime-300 transition-colors hover:text-lime-200"
          href="/"
        >
          Back to Leaderbot
        </Link>
        <section className="mt-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-stone-400">
            Last updated 1 August 2026
          </p>
          <h1 className="mt-3 text-3xl font-semibold text-white sm:text-4xl">
            {copy.title}
          </h1>
          <p className="mt-4 text-base leading-7 text-stone-300">
            {copy.intro}
          </p>
          <div className="mt-8 grid gap-4">
            {copy.sections.map(section => (
              <article
                className="rounded-2xl border border-white/10 bg-white/5 p-5"
                key={section.heading}
              >
                <h2 className="text-lg font-semibold text-white">
                  {section.heading}
                </h2>
                <p className="mt-2 text-sm leading-6 text-stone-300">
                  {section.body}
                </p>
              </article>
            ))}
          </div>

          <address className="mt-8 rounded-2xl border border-lime-300/20 bg-lime-300/5 p-5 text-sm not-italic leading-6 text-stone-300">
            <strong className="text-white">
              {PUBLIC_BUSINESS_DETAILS.brandName} ·{" "}
              {PUBLIC_BUSINESS_DETAILS.legalName}
            </strong>
            <br />
            Enterprise number {PUBLIC_BUSINESS_DETAILS.enterpriseNumber} · VAT{" "}
            {PUBLIC_BUSINESS_DETAILS.vatNumber}
            <br />
            {formatPublicBusinessAddress()}
            <br />
            <a
              className="text-lime-300 hover:underline"
              href={`tel:${PUBLIC_BUSINESS_DETAILS.phoneHref}`}
            >
              {PUBLIC_BUSINESS_DETAILS.phoneDisplay}
            </a>{" "}
            ·{" "}
            <a
              className="text-lime-300 hover:underline"
              href={`mailto:${PUBLIC_BUSINESS_DETAILS.email}`}
            >
              {PUBLIC_BUSINESS_DETAILS.email}
            </a>
          </address>
        </section>
      </div>
    </main>
  );
}

export function PrivacyPage() {
  return <LegalPage page="privacy" />;
}

export function TermsPage() {
  return <LegalPage page="terms" />;
}

export function DataDeletionPage() {
  return <LegalPage page="data-deletion" />;
}

export function BillingPolicyPage() {
  return <LegalPage page="billing-policy" />;
}
