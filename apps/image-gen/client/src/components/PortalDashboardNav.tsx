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
  workspaceLabel: string;
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
  workspaceLabel,
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
      className="sticky top-3 z-20 mt-4 overflow-hidden rounded-[1.6rem] border border-white/10 bg-[#102820] p-3 text-white shadow-[0_24px_70px_-35px_rgba(15,42,34,0.8)] lg:top-6 lg:col-start-1 lg:row-span-5 lg:row-start-1 lg:mt-0 lg:flex lg:h-[calc(100vh-3rem)] lg:flex-col lg:p-4"
    >
      <div className="flex items-center gap-3 px-2 py-1.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-lime-300 text-base font-black text-[#102820] shadow-sm">
          L
        </span>
        <div className="min-w-0">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-lime-300">
            Leaderbot
          </p>
          <p className="truncate text-sm font-semibold text-white">
            {dashboardLabel}
          </p>
        </div>
      </div>

      <div className="mt-3 hidden rounded-2xl border border-white/10 bg-white/[0.06] p-3 lg:block">
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-stone-400">
          {workspaceLabel}
        </p>
        <p className="mt-1 truncate text-sm font-semibold text-white">
          {workspaceName}
        </p>
      </div>

      <div className="mt-3 flex gap-1 overflow-x-auto pb-1 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {items.map(({ href, icon: Icon, label }) => (
          <a
            className="group inline-flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-sm font-medium text-stone-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 lg:w-full"
            href={href}
            key={href}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.07] text-lime-300 transition group-hover:bg-lime-300 group-hover:text-[#102820]">
              <Icon aria-hidden="true" className="h-4 w-4" />
            </span>
            {label}
          </a>
        ))}
      </div>

      <div className="mt-4 hidden items-center gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.07] p-3 text-xs leading-5 text-emerald-100 lg:flex">
        <ShieldCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-lime-300" />
        <span>{privacyLabel}</span>
      </div>
    </nav>
  );
}
