import { isMollieBillingDrainEnabled, isMollieBillingEnabled } from "./config";

export type MollieRuntimePolicy = Readonly<{
  commercialExposureEnabled: boolean;
  providerDrainEnabled: boolean;
  registerClassicWebhook: boolean;
  registerBillingHistory: boolean;
  startReconciliation: boolean;
  startSafetyOutbox: boolean;
}>;

export function getMollieRuntimePolicy(
  input: {
    commercialExposureEnabled?: boolean;
    providerDrainEnabled?: boolean;
    notificationPlaneEnabled?: boolean;
  } = {}
): MollieRuntimePolicy {
  const commercialExposureEnabled =
    input.commercialExposureEnabled ?? isMollieBillingEnabled();
  const providerDrainEnabled =
    input.providerDrainEnabled ?? isMollieBillingDrainEnabled();
  const notificationPlaneEnabled = input.notificationPlaneEnabled ?? false;
  return Object.freeze({
    commercialExposureEnabled,
    providerDrainEnabled,
    registerClassicWebhook: providerDrainEnabled,
    registerBillingHistory: providerDrainEnabled,
    startReconciliation: providerDrainEnabled,
    startSafetyOutbox: providerDrainEnabled || notificationPlaneEnabled,
  });
}
