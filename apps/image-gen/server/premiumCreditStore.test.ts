import { describe, expect, it } from "vitest";

import { calculatePremiumCreditBalance } from "./_core/premiumCreditStore";

describe("premium credit balance", () => {
  it("adds five credits per verified paid purchase and reserves atomically", () => {
    expect(calculatePremiumCreditBalance(0, 0)).toEqual({
      purchased: 0,
      committedOrReserved: 0,
      remaining: 0,
    });
    expect(calculatePremiumCreditBalance(2, 3)).toEqual({
      purchased: 10,
      committedOrReserved: 3,
      remaining: 7,
    });
  });

  it("never exposes a negative spendable balance", () => {
    expect(calculatePremiumCreditBalance(1, 7).remaining).toBe(0);
    expect(() => calculatePremiumCreditBalance(-1, 0)).toThrow(
      "inputs are invalid"
    );
  });
});
