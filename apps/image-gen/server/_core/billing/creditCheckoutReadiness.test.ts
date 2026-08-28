import { describe, expect, it } from "vitest";

import { assertCreditCheckoutBoundaryReadiness } from "./creditCheckoutReadiness";

function ready(
  overrides: {
    commercialExposureEnabled?: boolean;
    commercialEnabled?: boolean;
    enabled?: boolean;
    controlEpoch?: number;
    laneEpoch?: number;
    deadLetterCount?: number;
  } = {}
) {
  return {
    workspaceId: 42,
    commercialExposureEnabled: overrides.commercialExposureEnabled ?? true,
    controls: [
      {
        workspaceId: 42,
        commercialEnabled: overrides.commercialEnabled ?? true,
        authorizationEpoch: overrides.controlEpoch ?? 7,
      },
    ],
    outboxLanes: [
      {
        workspaceId: 42,
        kind: "outbox",
        enabled: overrides.enabled ?? true,
        executionEpoch: overrides.laneEpoch ?? 7,
        deadLetterCount: overrides.deadLetterCount ?? 0,
      },
    ],
  };
}

describe("credit checkout database boundary readiness", () => {
  it("accepts an enabled exact pilot boundary", () => {
    expect(() => assertCreditCheckoutBoundaryReadiness(ready())).not.toThrow();
  });

  it("keeps the safety lane bootable after commercial exposure is disabled", () => {
    expect(() =>
      assertCreditCheckoutBoundaryReadiness(
        ready({
          commercialExposureEnabled: false,
          commercialEnabled: false,
          deadLetterCount: 2,
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["missing control", { controls: [] }],
    [
      "duplicate control",
      { controls: ready().controls.concat(ready().controls) },
    ],
    ["disabled commercial control", ready({ commercialEnabled: false })],
    ["disabled safety lane", ready({ enabled: false })],
    ["stale safety epoch", ready({ laneEpoch: 6 })],
    ["dead letter", ready({ deadLetterCount: 1 })],
  ])("rejects %s", (_label, value) => {
    const input = "workspaceId" in value ? value : { ...ready(), ...value };
    expect(() => assertCreditCheckoutBoundaryReadiness(input)).toThrow();
  });
});
