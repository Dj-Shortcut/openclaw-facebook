import { describe, expect, it } from "vitest";
import {
  normalizeMessengerLanguage,
  tMessenger,
} from "./messenger-i18n.js";

describe("Messenger i18n", () => {
  it("keeps Dutch as the backward-compatible default", () => {
    expect(normalizeMessengerLanguage(undefined)).toBe("nl");
    expect(normalizeMessengerLanguage("fr")).toBe("nl");
    expect(tMessenger("nl", "fastLaneStatus")).toContain(
      "Messenger is verbonden",
    );
  });

  it("returns English operational copy", () => {
    expect(normalizeMessengerLanguage(" en ")).toBe("en");
    expect(tMessenger("en", "fastLaneStatus")).toContain("Messenger is connected");
  });
});
