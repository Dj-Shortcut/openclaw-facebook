import { Link } from "wouter";

type LegalPageKind = "privacy" | "terms" | "data-deletion";

const legalCopy: Record<
  LegalPageKind,
  {
    title: string;
    intro: string;
    sections: Array<{ heading: string; body: string }>;
  }
> = {
  privacy: {
    title: "Privacy Policy",
    intro:
      "Leaderbot is a tenant-owned AI assistant portal for managing workspace settings, Messenger connection status, knowledge sources, usage, and data controls.",
    sections: [
      {
        heading: "Workspace-owned data",
        body:
          "Customer workspace data includes assistant instructions, knowledge source records, channel connection metadata, usage summaries, privacy settings, and export or deletion requests.",
      },
      {
        heading: "Messenger and Meta",
        body:
          "Messenger delivery and Facebook-retained message history remain controlled by Meta. Leaderbot processes Messenger messages only to provide the assistant and image-generation service.",
      },
      {
        heading: "Retention and controls",
        body:
          "The portal exposes privacy controls for knowledge indexing, usage analytics, image memory retention, and customer-initiated export or deletion requests.",
      },
    ],
  },
  terms: {
    title: "Terms of Service",
    intro:
      "By using Leaderbot, you agree to use the customer portal and connected Messenger assistant within the published quotas, safety limits, and platform policies.",
    sections: [
      {
        heading: "AI outputs",
        body:
          "Leaderbot can generate text and images from your prompts, uploaded context, and workspace instructions. AI-generated content can be imperfect and should be reviewed before production use.",
      },
      {
        heading: "Quotas and availability",
        body:
          "The service may enforce usage quotas, rate limits, budget limits, abuse protection, and temporary feature restrictions to protect reliability and cost.",
      },
      {
        heading: "Platform separation",
        body:
          "Leaderbot is not endorsed by or affiliated with Meta. Messenger account controls, message delivery, and Facebook platform behavior are governed by Meta's own terms.",
      },
    ],
  },
  "data-deletion": {
    title: "Data Deletion",
    intro:
      "Leaderbot supports customer-initiated data export and deletion requests from the portal and Messenger deletion requests from end users.",
    sections: [
      {
        heading: "Portal requests",
        body:
          "Signed-in workspace members can create export or deletion requests from the Data requests panel in the Leaderbot customer portal.",
      },
      {
        heading: "Messenger requests",
        body:
          'Messenger users can send "delete my data" or "verwijder mijn data". Leaderbot will remove service-controlled retained data for that user where available.',
      },
      {
        heading: "Facebook-controlled data",
        body:
          "Facebook-retained message history and account data must be managed through Facebook or Meta account controls because Leaderbot cannot delete data held by Meta.",
      },
    ],
  },
};

function LegalPage({ page }: { page: LegalPageKind }) {
  const copy = legalCopy[page];

  return (
    <main className="min-h-full bg-slate-950 px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <Link
          className="text-sm text-cyan-200 transition-colors hover:text-cyan-100"
          href="/"
        >
          Back to portal
        </Link>
        <section className="mt-6">
          <h1 className="text-3xl font-semibold text-slate-50">{copy.title}</h1>
          <p className="mt-4 text-base leading-7 text-slate-300">{copy.intro}</p>
          <div className="mt-8 grid gap-4">
            {copy.sections.map(section => (
              <article
                className="rounded-lg border border-slate-800 bg-slate-900/70 p-5"
                key={section.heading}
              >
                <h2 className="text-lg font-semibold text-slate-50">
                  {section.heading}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-300">
                  {section.body}
                </p>
              </article>
            ))}
          </div>
          <p className="mt-8 text-sm text-slate-400">
            Contact:{" "}
            <a
              className="text-cyan-200 hover:text-cyan-100"
              href="mailto:privacy@leaderbot.live"
            >
              privacy@leaderbot.live
            </a>
          </p>
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
