import { describe, expect, it } from "vitest";

import { getMollieRuntimePolicy } from "./billingRuntimePolicy";

describe("Mollie runtime policy", () => {
  it("keeps the provider drain active after commercial exposure is disabled", () => {
    expect(
      getMollieRuntimePolicy({
        commercialExposureEnabled: false,
        providerDrainEnabled: true,
        notificationPlaneEnabled: true,
      })
    ).toEqual({
      commercialExposureEnabled: false,
      providerDrainEnabled: true,
      registerClassicWebhook: true,
      registerBillingHistory: true,
      startReconciliation: true,
      startSafetyOutbox: true,
    });
  });

  it("does not expose provider drain capabilities before their lifecycle flag", () => {
    expect(
      getMollieRuntimePolicy({
        commercialExposureEnabled: false,
        providerDrainEnabled: false,
        notificationPlaneEnabled: false,
      })
    ).toEqual({
      commercialExposureEnabled: false,
      providerDrainEnabled: false,
      registerClassicWebhook: false,
      registerBillingHistory: false,
      startReconciliation: false,
      startSafetyOutbox: false,
    });
  });
});
