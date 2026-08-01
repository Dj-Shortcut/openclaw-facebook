import { describe, expect, it } from "vitest";
import {
  hasRemoteCollectionStateMismatch,
  shouldPreserveRemoteSubscription,
  sortPaymentsOldestFirst,
} from "./reconciliation";

describe("billing reconciliation collection-risk detection", () => {
  it.each(["canceled", "completed", "suspended", "manual_review"] as const)(
    "flags local %s while Mollie remains active",
    localStatus => {
      expect(hasRemoteCollectionStateMismatch(localStatus, "active")).toBe(true);
    }
  );

  it("flags a stopped local subscription while Mollie remains pending", () => {
    expect(hasRemoteCollectionStateMismatch("canceled", "pending")).toBe(true);
  });

  it("does not flag expected active or non-collecting remote states", () => {
    expect(hasRemoteCollectionStateMismatch("active", "active")).toBe(false);
    expect(hasRemoteCollectionStateMismatch("canceled", "canceled")).toBe(false);
    expect(hasRemoteCollectionStateMismatch("manual_review", "suspended")).toBe(
      false
    );
  });

  it("replays missed payments from oldest to newest", () => {
    const newest = { id: "tr_new", createdAt: "2026-09-01T00:00:00.000Z" };
    const oldest = { id: "tr_old", createdAt: "2026-08-01T00:00:00.000Z" };

    expect(sortPaymentsOldestFirst([newest, oldest])).toEqual([
      oldest,
      newest,
    ]);
  });

  it("preserves a remote that became the current valid subscription", () => {
    expect(
      shouldPreserveRemoteSubscription(
        { status: "active", sourceIntentId: "intent-new" },
        { status: "active", metadata: { billingIntentId: "intent-new" } },
        true
      )
    ).toBe(true);
    expect(
      shouldPreserveRemoteSubscription(
        { status: "provisioning", sourceIntentId: "intent-new" },
        { status: "pending", metadata: { billingIntentId: "intent-new" } },
        false
      )
    ).toBe(true);
    expect(
      shouldPreserveRemoteSubscription(
        { status: "canceled", sourceIntentId: "intent-old" },
        { status: "active", metadata: { billingIntentId: "intent-old" } },
        true
      )
    ).toBe(false);
  });
});
