import { describe, expect, it } from "vitest";
import {
  canRetryAttempt,
  getExponentialRetryDelayMs,
} from "./_core/image-generation/retryPolicy";

describe("retry policy", () => {
  it("allows only retryable attempts below the configured limit", () => {
    expect(
      canRetryAttempt({ attempt: 0, maxRetries: 1, retryable: true })
    ).toBe(true);
    expect(
      canRetryAttempt({ attempt: 1, maxRetries: 1, retryable: true })
    ).toBe(false);
    expect(
      canRetryAttempt({ attempt: 0, maxRetries: 1, retryable: false })
    ).toBe(false);
  });

  it("calculates exponential backoff without owning the wait strategy", () => {
    expect(getExponentialRetryDelayMs(500, 0)).toBe(500);
    expect(getExponentialRetryDelayMs(500, 3)).toBe(4_000);
  });
});
