import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashCanonicalSnapshot } from "./ids";

describe("canonical billing snapshot hashes", () => {
  it("orders object keys by locale-independent code units", () => {
    const expected = createHash("sha256").update('{"B":2,"a":1}').digest("hex");

    expect(hashCanonicalSnapshot({ a: 1, B: 2 })).toBe(expected);
    expect(hashCanonicalSnapshot({ B: 2, a: 1 })).toBe(expected);
  });
});
