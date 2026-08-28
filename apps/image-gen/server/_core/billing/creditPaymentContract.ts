import type { MollieMode } from "./config";
import type { CreditOffer } from "./creditCatalog";
import type { MolliePayment } from "./mollieClient";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type CreditPaymentExpectedBinding = Readonly<{
  intentId: string;
  mode: MollieMode;
  metadataHash: string;
  offer: CreditOffer;
}>;

export type CreditPaymentContractStage = "creation" | "webhook";

export type CreditPaymentContractFailure =
  | "resource"
  | "payment_id"
  | "mode"
  | "status"
  | "amount"
  | "description"
  | "sequence"
  | "customer_binding"
  | "subscription_binding"
  | "mandate_binding"
  | "method"
  | "metadata"
  | "timestamp";

export type CreditPaymentContractResult =
  | Readonly<{ exact: true; paymentId: string }>
  | Readonly<{ exact: false; failure: CreditPaymentContractFailure }>;

const KNOWN_PAYMENT_STATUSES = new Set([
  "open",
  "pending",
  "authorized",
  "paid",
  "failed",
  "canceled",
  "expired",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isAbsentProviderBinding(value: unknown): boolean {
  return value === undefined || value === null;
}

function hasExactCreditMetadata(
  value: unknown,
  expected: CreditPaymentExpectedBinding
): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "billingIntentId" ||
    keys[1] !== "metadataHash" ||
    keys[2] !== "purpose" ||
    keys[3] !== "version"
  ) {
    return false;
  }
  return (
    value.billingIntentId === expected.intentId &&
    value.purpose === "premium_image_credits" &&
    value.version === 1 &&
    value.metadataHash === expected.metadataHash
  );
}

function isValidProviderTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().length > 0;
}

/**
 * Verifies the complete customerless credit-payment shape. Callers must keep
 * this check conjunctive before persisting, granting, reconciling, or
 * canceling a provider resource.
 */
export function validateCreditPaymentContract(
  payment: MolliePayment,
  expected: CreditPaymentExpectedBinding,
  stage: CreditPaymentContractStage
): CreditPaymentContractResult {
  if (payment.resource !== "payment") {
    return { exact: false, failure: "resource" };
  }
  if (!PAYMENT_ID_PATTERN.test(payment.id)) {
    return { exact: false, failure: "payment_id" };
  }
  if (
    !UUID_PATTERN.test(expected.intentId) ||
    !SHA256_PATTERN.test(expected.metadataHash)
  ) {
    return { exact: false, failure: "metadata" };
  }
  if (payment.mode !== expected.mode) {
    return { exact: false, failure: "mode" };
  }
  if (!KNOWN_PAYMENT_STATUSES.has(payment.status)) {
    return { exact: false, failure: "status" };
  }
  if (
    payment.amount.currency !== expected.offer.amount.currency ||
    payment.amount.value !== expected.offer.amount.value
  ) {
    return { exact: false, failure: "amount" };
  }
  if (payment.description !== expected.offer.mollieDescription) {
    return { exact: false, failure: "description" };
  }
  if (payment.sequenceType !== "oneoff") {
    return { exact: false, failure: "sequence" };
  }
  if (!isAbsentProviderBinding(payment.customerId)) {
    return { exact: false, failure: "customer_binding" };
  }
  if (!isAbsentProviderBinding(payment.subscriptionId)) {
    return { exact: false, failure: "subscription_binding" };
  }
  if (!isAbsentProviderBinding(payment.mandateId)) {
    return { exact: false, failure: "mandate_binding" };
  }
  if (
    payment.method !== "bancontact" &&
    !(stage === "creation" && isAbsentProviderBinding(payment.method))
  ) {
    return { exact: false, failure: "method" };
  }
  if (!hasExactCreditMetadata(payment.metadata, expected)) {
    return { exact: false, failure: "metadata" };
  }
  if (!isValidProviderTimestamp(payment.createdAt)) {
    return { exact: false, failure: "timestamp" };
  }
  return { exact: true, paymentId: payment.id };
}
