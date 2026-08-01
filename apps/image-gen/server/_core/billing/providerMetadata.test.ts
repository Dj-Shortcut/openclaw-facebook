import { describe, expect, it } from "vitest";
import { metadataIntentId } from "./providerMetadata";

describe("Mollie provider metadata", () => {
  const intentId = "550e8400-e29b-41d4-a716-446655440000";

  it("reads a UUID billing intent id from object metadata", () => {
    expect(metadataIntentId({ billingIntentId: intentId })).toBe(intentId);
  });

  it("rejects arrays even when they carry a billingIntentId property", () => {
    const metadata = Object.assign([], { billingIntentId: intentId });
    expect(metadataIntentId(metadata)).toBeNull();
  });

  it("rejects non-object and non-UUID metadata values", () => {
    expect(metadataIntentId(null)).toBeNull();
    expect(metadataIntentId("metadata")).toBeNull();
    expect(
      metadataIntentId({ billingIntentId: "intent-not-a-uuid" })
    ).toBeNull();
  });
});
