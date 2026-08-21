import { describe, expect, it } from "vitest";

import {
  getPortalDashboardSectionIdFromHash,
  getVisiblePortalDashboardSections,
  PORTAL_DASHBOARD_SECTION_IDS,
} from "../client/src/components/portalDashboardSections";

describe("PortalDashboardNav", () => {
  it("exposes only tenant-safe portal section identifiers", () => {
    const sectionIds = Object.values(PORTAL_DASHBOARD_SECTION_IDS);

    expect(sectionIds).toHaveLength(7);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    expect(sectionIds.every(sectionId => sectionId.startsWith("portal-"))).toBe(
      true
    );
    expect(sectionIds.join(" ")).not.toMatch(/gateway|token|secret/i);
  });

  it("only exposes billing navigation when the billing section is visible", () => {
    expect(getVisiblePortalDashboardSections(false)).toEqual([
      "overview",
      "assistant",
      "messenger",
      "usage",
      "privacy",
      "knowledge",
    ]);
    expect(getVisiblePortalDashboardSections(true)).toEqual([
      "overview",
      "assistant",
      "messenger",
      "usage",
      "billing",
      "privacy",
      "knowledge",
    ]);
  });

  it("resolves only visible dashboard hashes after the sections mount", () => {
    expect(getPortalDashboardSectionIdFromHash("#portal-usage", false)).toBe(
      "portal-usage"
    );
    expect(getPortalDashboardSectionIdFromHash("#portal-billing", false)).toBe(
      null
    );
    expect(getPortalDashboardSectionIdFromHash("#portal-billing", true)).toBe(
      "portal-billing"
    );
    expect(getPortalDashboardSectionIdFromHash("#gateway", true)).toBe(null);
  });
});
