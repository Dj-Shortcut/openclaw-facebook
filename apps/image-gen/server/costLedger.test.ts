import { afterEach, describe, expect, it } from "vitest";
import {
  appendCostLedgerEntry,
  readCostLedgerPeriod,
  summarizeCostLedgerPeriod,
  summarizeCostLedgerPeriods,
  updateCostLedgerEntry,
  type CostLedgerEntry,
} from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";

afterEach(() => {
  clearStateStore();
});

function entry(overrides: Partial<CostLedgerEntry>): CostLedgerEntry {
  return {
    id: "req-cost:attempt-1",
    channel: "facebook_messenger",
    operation: "image_generation",
    provider: "openai-images",
    model: "gpt-image-2",
    userKey: "user-key-1",
    reqId: "req-cost",
    status: "provider_attempt_started",
    estimatedCostUsd: 0.025,
    estimatedOutputCostUsd: null,
    finalCostUsd: null,
    costEstimateComplete: true,
    estimateSource: "env_override",
    unpricedCostComponents: [],
    ...overrides,
  };
}

describe("cost ledger", () => {
  it("stores provider attempt metadata by UTC period", async () => {
    await appendCostLedgerEntry(
      entry({ id: "req-cost:attempt-1" }),
      new Date("2026-06-21T23:59:59.000Z")
    );
    await appendCostLedgerEntry(
      entry({ id: "req-cost:attempt-2" }),
      new Date("2026-06-22T00:00:00.000Z")
    );

    expect(await readCostLedgerPeriod("2026-06-21")).toHaveLength(1);
    expect(await readCostLedgerPeriod("2026-06-22")).toMatchObject([
      {
        id: "req-cost:attempt-2",
        period: "2026-06-22",
        recordedAt: "2026-06-22T00:00:00.000Z",
      },
    ]);
  });

  it("summarizes owner-safe spend metadata", async () => {
    await appendCostLedgerEntry(
      entry({
        id: "req-image:attempt-1",
        userKey: "user-key-1",
        estimatedCostUsd: 0.025,
        costEstimateComplete: true,
      }),
      new Date("2026-06-21T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({
        id: "req-audio:attempt-1",
        operation: "audio_transcription",
        provider: "openai-audio",
        model: "gpt-4o-transcribe",
        userKey: "user-key-2",
        estimatedCostUsd: null,
        costEstimateComplete: false,
        estimateSource: null,
        unpricedCostComponents: ["audio_seconds"],
      }),
      new Date("2026-06-21T12:01:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({
        id: "req-image:attempt-2",
        userKey: "user-key-1",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.042,
        costEstimateComplete: false,
        unpricedCostComponents: ["input_tokens"],
      }),
      new Date("2026-06-21T12:02:00.000Z")
    );

    const summary = await summarizeCostLedgerPeriod("2026-06-21");

    expect(summary).toMatchObject({
      period: "2026-06-21",
      totalEntries: 3,
      uniqueUserCount: 2,
      estimatedCostUsd: 0.067,
      finalCostUsd: 0,
      completeEstimateEntries: 1,
      incompleteEstimateEntries: 2,
      unpricedCostComponents: ["audio_seconds", "input_tokens"],
      byOperation: {
        image_generation: {
          attempts: 2,
          estimatedCostUsd: 0.067,
          finalCostUsd: 0,
        },
        audio_transcription: {
          attempts: 1,
          estimatedCostUsd: 0,
          finalCostUsd: 0,
        },
      },
      byProvider: {
        "openai-images": {
          attempts: 2,
          estimatedCostUsd: 0.067,
          finalCostUsd: 0,
        },
        "openai-audio": {
          attempts: 1,
          estimatedCostUsd: 0,
          finalCostUsd: 0,
        },
      },
    });
    expect(Object.keys(summary.byRequest)).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain("prompt");
    expect(JSON.stringify(summary)).not.toContain("facebook:");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("rolls up costs per request without exposing the raw request id", async () => {
    await appendCostLedgerEntry(
      entry({
        id: "mid:private-message-id:attempt-1",
        reqId: "mid:private-message-id",
        estimatedCostUsd: 0.025,
      }),
      new Date("2026-06-21T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({
        id: "mid:private-message-id:attempt-2",
        reqId: "mid:private-message-id",
        status: "provider_attempt_failed",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.042,
        costEstimateComplete: false,
        unpricedCostComponents: ["input_tokens"],
      }),
      new Date("2026-06-21T12:01:00.000Z")
    );

    const summary = await summarizeCostLedgerPeriod("2026-06-21");
    const requestKeys = Object.keys(summary.byRequest);

    expect(requestKeys).toHaveLength(1);
    expect(requestKeys[0]).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(summary.byRequest[requestKeys[0] ?? ""]).toEqual({
      attempts: 2,
      estimatedCostUsd: 0.067,
      finalCostUsd: 0,
      operation: "image_generation",
      provider: "openai-images",
      statuses: {
        provider_attempt_started: 1,
        provider_attempt_failed: 1,
      },
      completeEstimateEntries: 1,
      incompleteEstimateEntries: 1,
      unpricedCostComponents: ["input_tokens"],
    });
    expect(JSON.stringify(summary)).not.toContain("mid:private-message-id");
  });

  it("summarizes multiple UTC periods for monthly spend checks", async () => {
    await appendCostLedgerEntry(
      entry({ id: "req-month-a:attempt-1", reqId: "req-month-a", estimatedCostUsd: 0.02 }),
      new Date("2026-06-01T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({ id: "req-month-b:attempt-1", reqId: "req-month-b", estimatedCostUsd: 0.03 }),
      new Date("2026-06-15T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({ id: "req-other-month:attempt-1", reqId: "req-other-month", estimatedCostUsd: 99 }),
      new Date("2026-07-01T12:00:00.000Z")
    );

    const summary = await summarizeCostLedgerPeriods(
      ["2026-06-01", "2026-06-15"],
      "2026-06"
    );

    expect(summary).toMatchObject({
      period: "2026-06",
      totalEntries: 2,
      estimatedCostUsd: 0.05,
      byOperation: {
        image_generation: {
          attempts: 2,
          estimatedCostUsd: 0.05,
        },
      },
    });
  });

  it("updates an existing provider attempt status and final cost", async () => {
    await appendCostLedgerEntry(
      entry({
        id: "req-finalize:attempt-1",
        reqId: "req-finalize",
        status: "provider_attempt_started",
        finalCostUsd: null,
      }),
      new Date("2026-06-21T12:00:00.000Z")
    );

    await expect(
      updateCostLedgerEntry(
        "req-finalize:attempt-1",
        {
          status: "provider_attempt_succeeded",
          finalCostUsd: 0.025,
        },
        new Date("2026-06-21T12:00:01.000Z")
      )
    ).resolves.toMatchObject({
      id: "req-finalize:attempt-1",
      status: "provider_attempt_succeeded",
      finalCostUsd: 0.025,
    });

    expect(await readCostLedgerPeriod("2026-06-21")).toEqual([
      expect.objectContaining({
        id: "req-finalize:attempt-1",
        status: "provider_attempt_succeeded",
        finalCostUsd: 0.025,
      }),
    ]);
  });
});
