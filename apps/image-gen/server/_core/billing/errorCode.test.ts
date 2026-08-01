import { describe, expect, it } from "vitest";
import { MollieApiError } from "./mollieClient";
import { safeBillingErrorCode } from "./errorCode";

describe("safe billing error codes", () => {
  it.each([
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
  ])("maps %j to %s", (message, expectedCode) => {
    expect(safeBillingErrorCode(new Error(message))).toBe(expectedCode);
  });

  it("preserves provider error codes and safe custom error names", () => {
    expect(safeBillingErrorCode(new MollieApiError(503, "http_503"))).toBe(
      "http_503"
    );
    const customError = new Error("database unavailable");
    customError.name = "DatabaseUnavailableError";
    expect(safeBillingErrorCode(customError)).toBe("DatabaseUnavailableError");
  });

  it("uses safe fallbacks without exposing arbitrary error messages", () => {
    expect(safeBillingErrorCode(new Error("database unavailable"))).toBe(
      "BillingOperationError"
    );
    expect(safeBillingErrorCode("database unavailable")).toBe("UnknownError");
  });

  it.each([
    "MOLLIE_API_KEY is missing",
    "APP_BASE_URL must be an https URL",
    "BILLING_SUPPORT_EMAIL must be a valid email address",
  ])("maps configuration error %j to one opaque code", message => {
    expect(safeBillingErrorCode(new Error(message))).toBe(
      "BillingConfigurationError"
    );
  });
});
