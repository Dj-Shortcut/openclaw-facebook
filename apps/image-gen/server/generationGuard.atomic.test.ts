import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendCostLedgerEntry,
  readCostLedgerPeriod,
  type CostLedgerScope,
} from "./_core/costLedger";
import {
  admitMessengerProviderSpend,
  MessengerSpendBudgetExceededError,
} from "./_core/generationGuard";
import { clearStateStore } from "./_core/stateStore";

const PERIOD = "2026-08-18";
const NOW = new Date(`${PERIOD}T12:00:00.000Z`);
const SCOPE: CostLedgerScope = {
  workspaceId: 41,
  channelConnectionId: 7,
  bindingEpoch: 3,
  privacyEpoch: 1,
};

describe("atomic Messenger spend admission", () => {
  beforeEach(async () => {
    delete process.env.REDIS_URL;
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.05";
    clearStateStore();
  });

  afterEach(() => {
    delete process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;
  });

  it("admits only attempts that fit when concurrent workers race the last budget", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        recordAttempt(`concurrent-${index}`, "user-a", 0.01)
      )
    );

    expect(
      attempts.filter(result => result.status === "fulfilled")
    ).toHaveLength(5);
    const rejected = attempts.filter(result => result.status === "rejected");
    expect(rejected).toHaveLength(15);
    expect(
      rejected.every(
        result => result.reason instanceof MessengerSpendBudgetExceededError
      )
    ).toBe(true);

    const stored = await readCostLedgerPeriod(SCOPE, PERIOD);
    expect(stored).toHaveLength(5);
    expect(
      stored.reduce((total, entry) => total + (entry.estimatedCostUsd ?? 0), 0)
    ).toBeCloseTo(0.05, 8);
  });

  it("keeps per-user admission isolated while preserving the global cap", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.06";
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.02";

    const attempts = await Promise.allSettled([
      ...Array.from({ length: 4 }, (_, index) =>
        recordAttempt(`user-a-${index}`, "user-a", 0.01)
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        recordAttempt(`user-b-${index}`, "user-b", 0.01)
      ),
    ]);

    expect(
      attempts.filter(result => result.status === "fulfilled")
    ).toHaveLength(4);
    const stored = await readCostLedgerPeriod(SCOPE, PERIOD);
    expect(stored.filter(entry => entry.userKey === "user-a")).toHaveLength(2);
    expect(stored.filter(entry => entry.userKey === "user-b")).toHaveLength(2);
  });

  it("fails before provider admission when the durable ledger write fails", async () => {
    let providerStarted = false;

    await expect(
      admitMessengerProviderSpend({
        reqId: "ledger-failure",
        attemptId: "ledger-failure:attempt-1",
        scope: SCOPE,
        userKey: "user-a",
        estimatedCostUsd: 0.01,
        costEstimateComplete: true,
        now: NOW,
        recordAttempt: async () => {
          throw new Error("ledger unavailable");
        },
      }).then(() => {
        providerStarted = true;
      })
    ).rejects.toThrow("ledger unavailable");

    expect(providerStarted).toBe(false);
    await expect(
      recordAttempt("after-failure", "user-a", 0.05)
    ).resolves.toBeUndefined();
  });
});

async function recordAttempt(
  reqId: string,
  userKey: string,
  estimatedCostUsd: number
): Promise<void> {
  await admitMessengerProviderSpend({
    reqId,
    attemptId: reqId,
    scope: SCOPE,
    userKey,
    estimatedCostUsd,
    costEstimateComplete: true,
    now: NOW,
    recordAttempt: async () => {
      await appendCostLedgerEntry(
        {
          scope: SCOPE,
          id: reqId,
          channel: "facebook_messenger",
          operation: "image_generation",
          provider: "test-provider",
          model: "test-model",
          userKey,
          reqId,
          status: "provider_attempt_started",
          estimatedCostUsd,
          estimatedOutputCostUsd: null,
          finalCostUsd: null,
          costEstimateComplete: true,
          estimateSource: "test",
          unpricedCostComponents: [],
        },
        NOW
      );
    },
  });
}
