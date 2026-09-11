import { describe, expect, it } from "vitest";
import {
  decodeMessengerActionInput,
  encodeMessengerActionInput,
} from "./_core/messengerActionPayload";

describe("Messenger action payloads", () => {
  it("keeps new buttons compatible with existing and rollback runtimes", () => {
    expect(encodeMessengerActionInput("Pas foto aan 🖼️")).toBe(
      "OPENCLAW_ACTION:Pas%20foto%20aan%20%F0%9F%96%BC%EF%B8%8F"
    );
  });

  it.each(["LEADERBOT_ACTION:", "OPENCLAW_ACTION:"])(
    "decodes current and already-sent buttons with prefix %s",
    prefix => {
      expect(decodeMessengerActionInput(`${prefix}new_image`)).toBe(
        "new_image"
      );
      expect(
        decodeMessengerActionInput(`${prefix}%20Pas%20foto%20aan%20`)
      ).toBe("Pas foto aan");
    }
  );

  it.each([undefined, "", "new_image", "UNKNOWN_ACTION:new_image"])(
    "rejects unknown payload %s",
    payload => {
      expect(decodeMessengerActionInput(payload)).toBeUndefined();
    }
  );

  it.each(["LEADERBOT_ACTION:", "OPENCLAW_ACTION:"])(
    "rejects empty and malformed action input with prefix %s",
    prefix => {
      for (const input of ["", "%20%09", "%", "%GG", "%E0%A4%A"]) {
        expect(decodeMessengerActionInput(`${prefix}${input}`)).toBeUndefined();
      }
    }
  );
});
