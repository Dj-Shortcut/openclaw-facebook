import { describe, expect, it } from "vitest";

import { getBillingOperatorIncidentViews } from "../client/src/components/billingOperatorIncidentView";

describe("BillingOperatorIncidentCard", () => {
  it("maps only metadata fields and exposes ACK only for unread rows", () => {
    const views = getBillingOperatorIncidentViews(
      [
        {
          id: 81,
          eventType: "payment_warning",
          reason: "payment_cancellation_failed",
          occurredAt: new Date("2026-08-24T10:00:00.000Z"),
          readAt: null,
        },
        {
          id: 82,
          eventType: "manual_review",
          reason: "provider_scope_mismatch",
          occurredAt: new Date("2026-08-24T11:00:00.000Z"),
          readAt: new Date("2026-08-24T12:00:00.000Z"),
        },
      ],
      "nl-BE"
    );

    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      id: 81,
      eventType: "payment_warning",
      reason: "payment_cancellation_failed",
      readLabel: null,
      canAcknowledge: true,
    });
    expect(views[1]).toMatchObject({
      id: 82,
      eventType: "manual_review",
      reason: "provider_scope_mismatch",
      canAcknowledge: false,
    });
    expect(Object.keys(views[0] ?? {}).sort()).toEqual([
      "canAcknowledge",
      "eventType",
      "id",
      "occurredLabel",
      "readLabel",
      "reason",
    ]);
  });
});
