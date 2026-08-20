import { describe, expect, it } from "vitest";

import {
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
});
