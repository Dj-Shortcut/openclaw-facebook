import { beforeEach, describe, expect, it, vi } from "vitest";

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ getDatabaseOrThrow: getDatabaseMock }));

import {
  assertWorkspaceBillingProfileEligible,
  getWorkspaceBillingProfileAttestationStatus,
} from "./billingProfileStore";

beforeEach(() => vi.clearAllMocks());

describe("server-owned workspace billing eligibility", () => {
  it.each([
    ["missing", [], "billing_profile_missing"],
    [
      "unverified",
      [profile({ verificationStatus: "unverified", verifiedAt: null })],
      "billing_profile_unverified",
    ],
    [
      "wrong country",
      [profile({ countryCode: "NL" })],
      "billing_country_not_eligible",
    ],
    [
      "cross workspace",
      [profile({ workspaceId: 8 })],
      "billing_profile_tenant_boundary",
    ],
    [
      "business without Peppol",
      [profile({ customerType: "business", peppolReady: 0 })],
      "b2b_checkout_disabled",
    ],
    [
      "business with Peppol",
      [profile({ customerType: "business", peppolReady: 1 })],
      "b2b_checkout_disabled",
    ],
  ])("blocks %s before checkout", async (_label, rows, code) => {
    getDatabaseMock.mockResolvedValue(databaseReturning(rows as unknown[]));
    await expect(assertWorkspaceBillingProfileEligible(7)).rejects.toThrow(
      String(code)
    );
  });

  it("allows one verified Belgian consumer profile", async () => {
    getDatabaseMock.mockResolvedValue(databaseReturning([profile()]));
    await expect(assertWorkspaceBillingProfileEligible(7)).resolves.toEqual({
      eligibilityVersion: 1,
    });
  });
});

describe("Peppol attestation status", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");

  it("reports that an active verified Peppol profile is complete", async () => {
    getDatabaseMock.mockResolvedValue(
      databaseReturning([
        profile({
          customerType: "business",
          peppolReady: true,
          verificationMethod: "provider_attestation",
        }),
      ])
    );

    await expect(
      getWorkspaceBillingProfileAttestationStatus(7, now)
    ).resolves.toEqual({
      eligibilityVersion: 1,
      peppolAttestationActive: true,
    });
  });

  it.each([
    ["missing", []],
    ["consumer", [profile()]],
    [
      "expired",
      [
        profile({
          customerType: "business",
          peppolReady: true,
          verificationExpiresAt: new Date("2026-08-20T00:00:00.000Z"),
        }),
      ],
    ],
  ])("keeps the form available for %s status", async (_label, rows) => {
    getDatabaseMock.mockResolvedValue(databaseReturning(rows as unknown[]));

    await expect(
      getWorkspaceBillingProfileAttestationStatus(7, now)
    ).resolves.toMatchObject({ peppolAttestationActive: false });
  });
});

function profile(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 7,
    countryCode: "BE",
    customerType: "consumer",
    verificationStatus: "verified",
    verificationMethod: "manual_legal_review",
    evidenceReferenceHash: `sha256:${"a".repeat(64)}`,
    verifiedAt: new Date("2026-08-18T00:00:00.000Z"),
    verificationExpiresAt: new Date("2030-08-18T00:00:00.000Z"),
    revokedAt: null,
    verifiedByUserId: 99,
    peppolReady: false,
    eligibilityVersion: 1,
    ...overrides,
  };
}

function databaseReturning(rows: unknown[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
      })),
    })),
  };
}
