import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDatabaseMock = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ getDatabaseOrThrow: getDatabaseMock }));

import {
  assertWorkspaceBillingProfileEligible,
  attestWorkspaceBillingProfile,
  getWorkspaceBillingProfileAttestationStatus,
} from "./billingProfileStore";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("server-owned workspace billing eligibility", () => {
  it.each([
    ["missing", [], "billing_profile_missing"],
    [
      "unverified",
      [profile({ verificationStatus: "unverified", verifiedAt: null })],
      "billing_profile_unverified",
    ],
    [
      "consumer without a manual legal review",
      [profile({ verificationMethod: "provider_attestation" })],
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
    [
      "consumer profile carrying a Peppol buyer flag",
      [profile({ customerType: "consumer", peppolReady: 1 })],
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

  it("persists the portal attestation as a Belgian consumer without a Peppol buyer flag", async () => {
    vi.stubEnv("BILLING_PROFILE_EVIDENCE_HMAC_SECRET", "s".repeat(32));
    const { database, updatedValues } = databaseForAttestation();
    getDatabaseMock.mockResolvedValue(database);
    const now = new Date("2026-08-24T10:00:00.000Z");
    const expiresAt = new Date("2026-09-23T10:00:00.000Z");

    await expect(
      attestWorkspaceBillingProfile({
        requestId: "b35ee776-d81e-4dd4-8799-45d4f34d4892",
        workspaceId: 7,
        actorUserId: 99,
        expectedVersion: 0,
        evidenceReference: "consumer-review:case-7",
        expiresAt,
        now,
      })
    ).resolves.toEqual({ eligibilityVersion: 1 });

    expect(updatedValues).toContainEqual(
      expect.objectContaining({
        countryCode: "BE",
        customerType: "consumer",
        verificationStatus: "verified",
        verificationMethod: "manual_legal_review",
        peppolReady: false,
        verifiedAt: now,
        verificationExpiresAt: expiresAt,
      })
    );
  });
});

describe("consumer attestation status", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");

  it("reports that an active verified Belgian consumer profile is complete", async () => {
    getDatabaseMock.mockResolvedValue(databaseReturning([profile()]));

    await expect(
      getWorkspaceBillingProfileAttestationStatus(7, now)
    ).resolves.toEqual({
      eligibilityVersion: 1,
      consumerAttestationActive: true,
    });
  });

  it.each([
    ["missing", []],
    ["business", [profile({ customerType: "business" })]],
    ["Peppol buyer flag", [profile({ peppolReady: true })]],
    [
      "provider-attested consumer",
      [profile({ verificationMethod: "provider_attestation" })],
    ],
    ["non-Belgian country", [profile({ countryCode: "NL" })]],
    [
      "expired",
      [
        profile({
          verificationExpiresAt: new Date("2026-08-20T00:00:00.000Z"),
        }),
      ],
    ],
  ])("keeps the form available for %s status", async (_label, rows) => {
    getDatabaseMock.mockResolvedValue(databaseReturning(rows as unknown[]));

    await expect(
      getWorkspaceBillingProfileAttestationStatus(7, now)
    ).resolves.toMatchObject({ consumerAttestationActive: false });
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

function databaseForAttestation() {
  const selectedRows = [
    [{ userId: 99 }],
    [],
    [{ id: 17, eligibilityVersion: 0, verificationStatus: "unverified" }],
    [],
  ];
  const updatedValues: unknown[] = [];
  const tx = {
    select: vi.fn(() => {
      const rows = selectedRows.shift() ?? [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => rows),
            })),
          })),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onDuplicateKeyUpdate: vi.fn(async () => undefined),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updatedValues.push(values);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };
  return {
    database: {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      ),
    },
    updatedValues,
  };
}
