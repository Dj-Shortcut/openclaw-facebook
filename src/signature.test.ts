import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateMessengerSignature } from "./signature.js";

describe("validateMessengerSignature", () => {
  it("validates Meta sha256 signatures over the raw body", () => {
    const rawBody = '{"object":"page"}';
    const appSecret = "secret";
    const signature = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;

    expect(validateMessengerSignature(rawBody, signature, appSecret)).toBe(true);
    expect(validateMessengerSignature(`${rawBody}\n`, signature, appSecret)).toBe(false);
  });
});
