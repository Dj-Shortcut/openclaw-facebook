import {
  Bot,
  CreditCard,
  Database,
  Gauge,
  LayoutDashboard,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";

import {
  getVisiblePortalDashboardSections,
  PORTAL_DASHBOARD_SECTION_IDS,
} from "./portalDashboardSections";

type PortalDashboardNavProps = {
  ariaLabel: string;
  assistantLabel: string;
  billingLabel: string;
  dashboardLabel: string;
  knowledgeLabel: string;
  messengerLabel: string;
  overviewLabel: string;
  privacyLabel: string;
  showBilling: boolean;
  usageLabel: string;
  workspaceName: string;
};

export function PortalDashboardNav({
  ariaLabel,
  assistantLabel,
  billingLabel,
  dashboardLabel,
  knowledgeLabel,
  messengerLabel,
  overviewLabel,
  privacyLabel,
  showBilling,
  usageLabel,
  workspaceName,
}: PortalDashboardNavProps) {
  const sectionPresentation = {
    overview: { icon: LayoutDashboard, label: overviewLabel },
    assistant: { icon: Bot, label: assistantLabel },
    messenger: { icon: MessageCircle, label: messengerLabel },
    usage: { icon: Gauge, label: usageLabel },
    billing: { icon: CreditCard, label: billingLabel },
    privacy: { icon: ShieldCheck, label: privacyLabel },
    knowledge: { icon: Database, label: knowledgeLabel },
  };
  const items = getVisiblePortalDashboardSections(showBilling).map(section => ({
    href: `#${PORTAL_DASHBOARD_SECTION_IDS[section]}`,
    ...sectionPresentation[section],
  }));

  return (
    <nav
      aria-label={ariaLabel}
      className="sticky top-3 z-20 mt-5 rounded-2xl border border-white/10 bg-[#10211d]/95 p-3 text-white shadow-xl shadow-stone-950/10 backdrop-blur"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 px-2 lg:w-56">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-lime-300">
            {dashboardLabel}
          </p>
          <p className="truncate text-sm font-semibold text-white">
            {workspaceName}
          </p>
        </div>
        <div className="flex flex-1 gap-1 overflow-x-auto pb-1 lg:pb-0">
          {items.map(({ href, icon: Icon, label }) => (
            <a
              className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium text-stone-200 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
              href={href}
              key={href}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  );
}
