import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toUserKey } from "./_core/privacy";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("privacy hashing", () => {
  beforeAll(() => {
    process.env.PRIVACY_PEPPER = TEST_PEPPER;
  });

  beforeEach(() => {
    process.env.PRIVACY_PEPPER = TEST_PEPPER;
  });

  afterAll(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }

    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("produces deterministic hash for same input", () => {
    const first = toUserKey("user123");
    const second = toUserKey("user123");

    expect(first).toBe(second);
  });

  it("changes hash when pepper changes", () => {
    process.env.PRIVACY_PEPPER = "pepper1";
    const first = toUserKey("user123");

    process.env.PRIVACY_PEPPER = "pepper2";
    const second = toUserKey("user123");

    expect(first).not.toBe(second);
  });

  it("does not return raw input", () => {
    const result = toUserKey("user123");

    expect(result).not.toBe("user123");
  });
});
