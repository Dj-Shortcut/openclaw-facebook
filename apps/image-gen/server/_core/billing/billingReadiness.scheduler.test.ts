import { describe, expect, it } from "vitest";

import { assertBillingSchedulerRegistryCoherence } from "./billingReadiness";

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
