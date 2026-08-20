export const PORTAL_DASHBOARD_SECTION_IDS = {
  overview: "portal-overview",
  assistant: "portal-assistant",
  messenger: "portal-messenger",
  usage: "portal-usage",
  billing: "portal-billing",
  privacy: "portal-privacy",
  knowledge: "portal-knowledge",
} as const;

export type PortalDashboardSection = keyof typeof PORTAL_DASHBOARD_SECTION_IDS;

export function getVisiblePortalDashboardSections(
  showBilling: boolean
): PortalDashboardSection[] {
  return [
    "overview",
    "assistant",
    "messenger",
    "usage",
    ...(showBilling ? (["billing"] as const) : []),
    "privacy",
    "knowledge",
  ];
}
