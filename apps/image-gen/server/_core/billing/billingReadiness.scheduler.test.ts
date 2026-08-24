import { describe, expect, it } from "vitest";

import {
  assertBillingSchedulerRegistryCoherence,
  assertPinnedBillingProfileReadiness,
} from "./billingReadiness";

const kinds = [
  "outbox",
  "reconciliation",
  "profile_expiry",
  "ai_finalization",
] as const;

function lanes(input: { commercialEnabled: boolean; epoch: number }) {
  return kinds.map(kind => ({
    workspaceId: 17,
    kind,
    enabled: input.commercialEnabled || kind === "outbox",
    executionEpoch: input.epoch,
    operatorRequestId: input.commercialEnabled ? "request" : null,
    enabledByUserId: input.commercialEnabled ? 3 : null,
    enabledAt: input.commercialEnabled ? new Date("2030-01-01") : null,
    deadLetterCount: 0,
  }));
}

describe("billing scheduler readiness state machine", () => {
  it("boots a commercially disabled tenant with only its safety outbox enabled", () => {
    expect(() =>
      assertBillingSchedulerRegistryCoherence(
        [
          {
            workspaceId: 17,
            commercialEnabled: false,
            authorizationEpoch: 1,
          },
        ],
        lanes({ commercialEnabled: false, epoch: 1 })
      )
    ).not.toThrow();
  });

  it("requires all four audited lanes for commercial execution", () => {
    expect(() =>
      assertBillingSchedulerRegistryCoherence(
        [
          {
            workspaceId: 17,
            commercialEnabled: true,
            authorizationEpoch: 2,
          },
        ],
        lanes({ commercialEnabled: true, epoch: 2 })
      )
    ).not.toThrow();
  });

  it("rejects a disabled commercial lane or a stale execution epoch", () => {
    const incoherent = lanes({ commercialEnabled: false, epoch: 1 });
    incoherent[1] = { ...incoherent[1], enabled: true };
    expect(() =>
      assertBillingSchedulerRegistryCoherence(
        [
          {
            workspaceId: 17,
            commercialEnabled: false,
            authorizationEpoch: 2,
          },
        ],
        incoherent
      )
    ).toThrow(/epoch|enablement/);
  });
});

describe("pinned billing profile readiness", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");

  it("accepts one verified Belgian consumer with complete evidence", () => {
    expect(() =>
      assertPinnedBillingProfileReadiness([eligibleProfile()], 17, { now })
    ).not.toThrow();
  });

  it("keeps the safety drain ready with commercial billing disabled and an expired profile", () => {
    expect(() =>
      assertPinnedBillingProfileReadiness(
        [
          {
            ...eligibleProfile(),
            verificationExpiresAt: new Date("2026-08-24T12:00:00.000Z"),
          },
        ],
        17,
        { commercialEnabled: false, now }
      )
    ).not.toThrow();
  });

  it("still rejects that expired profile when commercial billing is enabled", () => {
    expect(() =>
      assertPinnedBillingProfileReadiness(
        [
          {
            ...eligibleProfile(),
            verificationExpiresAt: new Date("2026-08-24T12:00:00.000Z"),
          },
        ],
        17,
        { commercialEnabled: true, now }
      )
    ).toThrow("Pinned billing workspace has no eligible profile");
  });

  it.each([
    ["business", { customerType: "business" }],
    ["Peppol buyer flag", { peppolReady: true }],
    ["missing proof", { evidenceReferenceHash: null }],
    ["missing actor", { verifiedByUserId: null }],
    [
      "expired evidence",
      { verificationExpiresAt: new Date("2026-08-24T12:00:00.000Z") },
    ],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      assertPinnedBillingProfileReadiness(
        [{ ...eligibleProfile(), ...override }],
        17,
        { now }
      )
    ).toThrow("Pinned billing workspace has no eligible profile");
  });
});

function eligibleProfile() {
  return {
    workspaceId: 17,
    countryCode: "BE",
    customerType: "consumer",
    verificationStatus: "verified",
    verificationMethod: "manual_legal_review",
    evidenceReferenceHash: `hmac-sha256:${"a".repeat(64)}`,
    verifiedAt: new Date("2026-08-23T12:00:00.000Z"),
    verificationExpiresAt: new Date("2026-09-23T12:00:00.000Z"),
    revokedAt: null,
    verifiedByUserId: 91,
    peppolReady: false,
    eligibilityVersion: 3,
  };
}
