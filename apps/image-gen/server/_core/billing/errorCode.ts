import { MollieApiError } from "./mollieClient";

const BILLING_ERROR_CODES = new Map<string, string>([
  ["workspace not found", "BillingWorkspaceNotFound"],
  [
    "workspace already has a billing subscription",
    "BillingSubscriptionAlreadyExists",
  ],
  [
    "workspace has no subscription to update",
    "BillingSubscriptionUpdateUnavailable",
  ],
  [
    "workspace already has a checkout in progress",
    "BillingCheckoutAlreadyInProgress",
  ],
  ["billing subscription not found", "BillingSubscriptionNotFound"],
  ["billing plan is unavailable", "BillingPlanUnavailable"],
  ["invalid billing amount", "BillingAmountInvalid"],
  ["unsupported billing interval", "BillingIntervalUnsupported"],
  ["billing customer is not ready", "BillingCustomerNotReady"],
  [
    "checkout creation is being reconciled; no retry was issued",
    "BillingCheckoutReconciliationPending",
  ],
  [
    "billing customer creation requires manual reconciliation",
    "BillingCustomerManualReview",
  ],
  [
    "checkout was superseded before it could be opened",
    "BillingCheckoutSuperseded",
  ],
  [
    "payment method cannot be changed in the current state",
    "BillingPaymentMethodChangeUnavailable",
  ],
  [
    "payment method change is too close to collection",
    "BillingPaymentMethodChangeCollectionWindow",
  ],
  [
    "an existing subscription collection is still in progress",
    "BillingCollectionInProgress",
  ],
  ["billing intent not found", "BillingIntentNotFound"],
  ["billing intent was not persisted", "BillingIntentPersistenceFailed"],
  [
    "billing customer claim was not persisted",
    "BillingCustomerClaimPersistenceFailed",
  ],
  [
    "billing customer reservation was not persisted",
    "BillingCustomerReservationPersistenceFailed",
  ],
  [
    "Leaderbot billing is available in Belgium only",
    "BillingCountryUnavailable",
  ],
  [
    "B2B checkout is unavailable until Peppol invoicing is configured",
    "BillingBusinessCheckoutUnavailable",
  ],
  [
    "Mollie Bancontact and SEPA Direct Debit must both be enabled before checkout",
    "BillingPaymentMethodsUnavailable",
  ],
  ["Mollie customer mode mismatch", "BillingProviderCustomerModeMismatch"],
  [
    "Mollie payment response did not match the billing intent",
    "BillingProviderPaymentMismatch",
  ],
  ["invalid Mollie resource ID", "BillingProviderResourceInvalid"],
  ["Mollie customer was not attached", "BillingCustomerAttachmentFailed"],
  [
    "Mollie customer conflict for workspace billing",
    "BillingCustomerAttachmentConflict",
  ],
  [
    "Mollie payment has no hosted checkout URL",
    "BillingHostedCheckoutUnavailable",
  ],
  [
    "Mollie returned an unexpected checkout host",
    "BillingHostedCheckoutHostMismatch",
  ],
  ["Mollie pagination cycle detected", "BillingProviderPaginationCycle"],
  [
    "Mollie returned an unexpected pagination URL",
    "BillingProviderPaginationUrlInvalid",
  ],
  [
    "Mollie billing is disabled; enable it only after the billing launch gates are approved",
    "BillingDisabled",
  ],
  [
    "Mollie live billing is disabled; set MOLLIE_LIVE_BILLING_ENABLED=true only after launch approval",
    "BillingLiveDisabled",
  ],
  [
    "Mollie billing is unavailable for this workspace until a tenant-scoped worker is configured",
    "BillingTenantWorkerUnavailable",
  ],
]);

const CONFIGURATION_ERROR_PATTERN =
  /^(?:MOLLIE_|APP_BASE_URL|BILLING_SUPPORT_EMAIL)/;
const SAFE_CUSTOM_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function safeBillingErrorCode(error: unknown): string {
  if (error instanceof MollieApiError) return error.code;
  if (!(error instanceof Error)) return "UnknownError";

  const knownCode = BILLING_ERROR_CODES.get(error.message);
  if (knownCode) return knownCode;
  if (CONFIGURATION_ERROR_PATTERN.test(error.message)) {
    return "BillingConfigurationError";
  }
  if (
    error.name !== "Error" &&
    SAFE_CUSTOM_ERROR_NAME_PATTERN.test(error.name)
  ) {
    return error.name;
  }
  return "BillingOperationError";
}
