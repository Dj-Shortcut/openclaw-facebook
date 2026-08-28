import { describe, expect, it } from "vitest";

import { getCreditOffer } from "./creditCatalog";
import type { MolliePayment } from "./mollieClient";
import { validateCreditPaymentContract } from "./creditPaymentContract";

const intentId = "018f47a0-4c6f-8000-8000-000000000001";
const metadataHash = "ab".repeat(32);
const offer = getCreditOffer("premium_images_8_medium_v1", 1)!;
const expected = { intentId, metadataHash, mode: "test" as const, offer };

function payment(override: Partial<MolliePayment> = {}): MolliePayment {
  return {
    resource: "payment",
    id: "tr_creditpayment1",
    mode: "test",
    status: "open",
    amount: { currency: "EUR", value: "4.99" },
    description: "Leaderbot - 8 premium beeldcredits",
    sequenceType: "oneoff",
    method: "bancontact",
    customerId: null,
    mandateId: null,
    subscriptionId: null,
    metadata: {
      billingIntentId: intentId,
      purpose: "premium_image_credits",
      version: 1,
      metadataHash,
    },
    createdAt: "2026-08-28T04:00:00.000Z",
    ...override,
  };
}

describe("customerless credit payment contract", () => {
  it("accepts the exact one-off Bancontact payment", () => {
    expect(
      validateCreditPaymentContract(payment(), expected, "creation")
    ).toEqual({ exact: true, paymentId: "tr_creditpayment1" });
  });

  it("allows a missing method only on the immediate creation response", () => {
    expect(
      validateCreditPaymentContract(
        payment({ method: null }),
        expected,
        "creation"
      )
    ).toMatchObject({ exact: true });
    expect(
      validateCreditPaymentContract(
        payment({ method: null }),
        expected,
        "webhook"
      )
    ).toEqual({ exact: false, failure: "method" });
  });

  it.each([
    ["mode", { mode: "live" }],
    ["status", { status: "unknown" }],
    ["amount", { amount: { currency: "EUR", value: "5.00" } }],
    ["description", { description: "Other product" }],
    ["sequence", { sequenceType: "recurring" }],
    ["customer_binding", { customerId: "cst_other" }],
    ["subscription_binding", { subscriptionId: "sub_other" }],
    ["mandate_binding", { mandateId: "mdt_other" }],
    ["method", { method: "creditcard" }],
    ["timestamp", { createdAt: "not-a-timestamp" }],
  ] as const)("rejects an exact-contract %s mismatch", (failure, override) => {
    expect(
      validateCreditPaymentContract(
        payment(override as Partial<MolliePayment>),
        expected,
        "webhook"
      )
    ).toEqual({ exact: false, failure });
  });

  it.each([
    null,
    { billingIntentId: intentId },
    {
      billingIntentId: intentId,
      purpose: "premium_image_credits",
      version: 1,
      metadataHash: "cd".repeat(32),
    },
    {
      billingIntentId: intentId,
      purpose: "premium_image_credits",
      version: 1,
      metadataHash,
      senderId: "must-not-be-accepted",
    },
  ])("rejects non-exact metadata %#", metadata => {
    expect(
      validateCreditPaymentContract(payment({ metadata }), expected, "webhook")
    ).toEqual({ exact: false, failure: "metadata" });
  });
});
