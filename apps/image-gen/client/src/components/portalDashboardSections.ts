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

export function getPortalDashboardSectionIdFromHash(
  hash: string,
  showBilling: boolean
): string | null {
  const sectionId = hash.startsWith("#") ? hash.slice(1) : hash;
  const visibleSectionIds = new Set<string>(
    getVisiblePortalDashboardSections(showBilling).map(
      section => PORTAL_DASHBOARD_SECTION_IDS[section]
    )
  );
  return visibleSectionIds.has(sectionId) ? sectionId : null;
}
