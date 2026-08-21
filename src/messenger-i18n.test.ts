import { describe, expect, it } from "vitest";
import {
  buildMessengerPlanQuotaReachedReply,
  normalizeMessengerLanguage,
  normalizeMessengerCustomerPortalUrl,
  tMessenger,
} from "./messenger-i18n.js";

describe("Messenger i18n", () => {
  it("keeps Dutch as the backward-compatible default", () => {
    expect(normalizeMessengerLanguage(undefined)).toBe("nl");
    expect(normalizeMessengerLanguage("fr")).toBe("nl");
    expect(tMessenger("nl", "fastLaneStatus")).toContain("Messenger is verbonden");
  });

  it("returns English operational and plan-neutral copy", () => {
    expect(normalizeMessengerLanguage(" en ")).toBe("en");
    expect(tMessenger("en", "gatewayImageBudgetReached")).toContain(
      "daily image budget",
    );
    const quotaCopy = tMessenger("en", "planQuotaReached");
    expect(quotaCopy).toContain("current plan");
    expect(quotaCopy).not.toContain("Startpilot");
    expect(quotaCopy).not.toContain("300");
  });

  it("keeps the plan-neutral portal handoff visible and HTTPS-only", () => {
    expect(
      buildMessengerPlanQuotaReachedReply(
        "en",
        "https://portal.example.test/account",
      ),
    ).toContain("https://portal.example.test/account");
    expect(normalizeMessengerCustomerPortalUrl("http://unsafe.example.test"))
      .toBe("https://leaderbot.live/");
    expect(
      normalizeMessengerCustomerPortalUrl(
        "https://user:secret@unsafe.example.test",
      ),
    ).toBe("https://leaderbot.live/");
  });
});
