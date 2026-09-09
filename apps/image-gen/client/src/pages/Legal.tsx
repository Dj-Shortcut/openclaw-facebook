import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "@shared/publicBusinessDetails";
import { Link } from "wouter";
import { creditBillingPolicyCopy } from "./creditCheckoutOffer";

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
      "Leaderbot is an owner-operated Messenger image service. Conversation, quota, purchase and privacy state remain scoped to the owning Page and pseudonymous Messenger user.",
    sections: [
      {
        heading: "Data used to provide Leaderbot",
        body: "Leaderbot may process Messenger messages and metadata, images submitted for generation or editing, usage data, and deletion requests. We process only what is needed to operate, secure and support the service.",
      },
      {
        heading: "Private service data",
        body: "Your content is private by default and is not intentionally shared with other users. Operational logs should contain redacted identifiers and service metadata rather than raw messages, prompts, uploaded media or access tokens.",
      },
      {
        heading: "Messenger, Meta and service providers",
        body: "Meta controls Facebook and Messenger account data and message history retained on its systems. Leaderbot may use hosting, AI or image-processing providers only as needed to provide the requested service; customer data is not shared for advertising.",
      },
      {
        heading: "Retention and your choices",
      body: "Retention depends on the feature and legal obligations. Messenger users can request deletion by sending ‘delete my data’ or ‘verwijder mijn data’, or by contacting privacy@leaderbot.live.",
      },
      {
        heading: "Payments",
        body: "A premium-credit purchase starts only from a signed checkout link opened from Messenger. Mollie processes one €4.99 payment after the customer reviews and confirms checkout. The purchase adds eight medium-quality image credits that do not expire. It does not create a subscription, automatic renewal, direct-debit mandate, automatic top-up or overage charge.",
      },
    ],
  },
  terms: {
    title: "Terms of Service",
    intro:
      "These terms apply to the Leaderbot Messenger image experience. Leaderbot provides AI-generated images and guided Messenger controls together with usage and privacy controls.",
    sections: [
      {
        heading: "Premium image credits",
        body: "Leaderbot premium credits cost €4.99 as a single payment for eight medium-quality image generations. Credits do not expire. One credit is consumed only after the image provider accepts that generation successfully; a failure before the provider call does not consume a credit. Purchase starts only from a signed checkout link opened from Messenger and requires explicit confirmation before continuing to Mollie.",
      },
      {
        heading: "No subscription or overage",
        body: "A credit pack does not renew automatically and does not create a subscription or direct-debit mandate. Usage stops when no free or paid credits remain. There are no automatic top-ups or additional usage charges. Every later purchase requires a separate, explicit choice.",
      },
      {
        heading: "AI outputs",
        body: "AI-generated images can be inaccurate, incomplete or unexpected. Review images before relying on, publishing or sharing them. Do not use Leaderbot for unlawful, harmful, deceptive or infringing content.",
      },
      {
        heading: "Messenger connection",
      body: "You may connect only a Facebook Page that you are authorized to manage. Usage limits, budget limits, abuse protection and temporary safety restrictions may apply.",
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
    title: creditBillingPolicyCopy.title,
    intro: creditBillingPolicyCopy.intro,
    sections: creditBillingPolicyCopy.sections.map(section => ({ ...section })),
  },
  "data-deletion": {
    title: "Data Deletion",
    intro:
      "Leaderbot supports Messenger deletion requests for service-controlled data.",
    sections: [
      {
        heading: "Data requests",
        body: "Messenger users can request deletion by sending ‘delete my data’ or ‘verwijder mijn data’, or by contacting privacy@leaderbot.live.",
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
  const isDutchBillingPolicy = page === "billing-policy";

  return (
    <main
      className="min-h-full bg-[#10211d] px-4 py-10 text-stone-100 sm:px-6 lg:px-8"
      lang={isDutchBillingPolicy ? "nl" : "en"}
    >
      <div className="mx-auto max-w-3xl">
        <Link
          className="text-sm font-medium text-lime-300 transition-colors hover:text-lime-200"
          href="/"
        >
          {isDutchBillingPolicy ? "Terug naar Leaderbot" : "Back to Leaderbot"}
        </Link>
        <section className="mt-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-stone-400">
            {isDutchBillingPolicy
              ? "Bijgewerkt op 28 augustus 2026"
              : "Last updated 28 August 2026"}
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
