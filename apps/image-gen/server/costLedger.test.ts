import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCostLedgerEntry,
  deleteCostLedgerEntriesForUser,
  getCostLedgerReliabilityStats,
  readCostLedgerPeriod,
  resetCostLedgerReliabilityStatsForTests,
  summarizeCostLedgerPeriod,
  summarizeCostLedgerPeriods,
  updateCostLedgerEntry,
  type CostLedgerEntry,
} from "./_core/costLedger";
import { clearStateStore, writeScopedState } from "./_core/stateStore";

afterEach(() => {
  vi.restoreAllMocks();
  clearStateStore();
  resetCostLedgerReliabilityStatsForTests();
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
  it("stores a stable request-id hash for repeated raw request IDs", async () => {
    await appendCostLedgerEntry(
      {
        ...entry({ reqId: "req-stable-id" }),
        id: "req-stable:attempt-1",
      },
      new Date("2026-06-21T10:00:00.000Z")
    );
    await appendCostLedgerEntry(
      {
        ...entry({ reqId: "req-stable-id" }),
        id: "req-stable:attempt-2",
      },
      new Date("2026-06-21T10:01:00.000Z")
    );

    const entries = await readCostLedgerPeriod("2026-06-21");
    const hashValues = entries.map(ledgerEntry => ledgerEntry.reqId);

    expect(new Set(hashValues)).toHaveLength(1);
    expect(hashValues[0]).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(hashValues.join(",")).not.toContain("req-stable-id");
  });

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

  it("summarizes owner-safe spend metadata without user content", async () => {
    await appendCostLedgerEntry(
      {
        id: "req-image:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        pricingModel: "gpt-image-1",
        userKey: "user-key-1",
        reqId: "req-image",
        generationKind: "text_to_image",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      new Date("2026-06-21T01:00:00.000Z")
    );
    await appendCostLedgerEntry(
      {
        id: "req-audio:attempt-1",
        channel: "facebook_messenger",
        operation: "audio_transcription",
        provider: "openai-audio",
        model: "whisper-1",
        userKey: "user-key-2",
        reqId: "req-audio",
        status: "provider_attempt_started",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: false,
        estimateSource: "unpriced",
        unpricedCostComponents: ["audio_duration"],
      },
      new Date("2026-06-21T02:00:00.000Z")
    );
    await appendCostLedgerEntry(
      {
        id: "req-image-edit:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-5",
        pricingModel: "gpt-image-1",
        userKey: "user-key-1",
        reqId: "req-image-edit",
        generationKind: "source_image_edit",
        status: "provider_attempt_started",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.042,
        finalCostUsd: null,
        costEstimateComplete: false,
        estimateSource: "partial_source_image_input_unpriced",
        unpricedCostComponents: ["source_image_input"],
      },
      new Date("2026-06-21T03:00:00.000Z")
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
      unpricedCostComponents: ["audio_duration", "source_image_input"],
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
    expect(JSON.stringify(summary)).not.toContain("prompt");
    expect(JSON.stringify(summary)).not.toContain("private");
    expect(JSON.stringify(summary)).not.toContain("https://");
    expect(JSON.stringify(summary)).not.toContain("facebook:");
  });

  it("serializes concurrent in-memory appends for the same period", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        appendCostLedgerEntry(
          entry({
            id: `req-concurrent:attempt-${index}`,
            reqId: `req-concurrent-${index}`,
          }),
          new Date("2026-06-21T12:00:00.000Z")
        )
      )
    );

    const entries = await readCostLedgerPeriod("2026-06-21");

    expect(entries).toHaveLength(25);
    expect(new Set(entries.map(ledgerEntry => ledgerEntry.id)).size).toBe(25);
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
        status: "provider_attempt_failed",
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
        status: "provider_attempt_succeeded",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.042,
        finalCostUsd: 0.042,
        costEstimateComplete: false,
        unpricedCostComponents: ["input_tokens"],
      }),
      new Date("2026-06-21T12:02:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({
        id: "req-blocked:attempt-1",
        reqId: "req-blocked",
        userKey: "user-key-3",
        status: "blocked",
        estimatedCostUsd: null,
        costEstimateComplete: false,
      }),
      new Date("2026-06-21T12:03:00.000Z")
    );

    const summary = await summarizeCostLedgerPeriod("2026-06-21");

    expect(summary).toMatchObject({
      period: "2026-06-21",
      totalEntries: 4,
      uniqueUserCount: 3,
      estimatedCostUsd: 0.067,
      finalCostUsd: 0.042,
      openAttemptEntries: 1,
      failedAttemptEntries: 1,
      blockedEntries: 1,
      completeEstimateEntries: 1,
      incompleteEstimateEntries: 3,
      unpricedCostComponents: ["audio_seconds", "input_tokens"],
      byStatus: {
        provider_attempt_started: 1,
        provider_attempt_succeeded: 1,
        provider_attempt_failed: 1,
        blocked: 1,
      },
      byOperation: {
        image_generation: {
          attempts: 3,
          estimatedCostUsd: 0.067,
          finalCostUsd: 0.042,
        },
        audio_transcription: {
          attempts: 1,
          estimatedCostUsd: 0,
          finalCostUsd: 0,
        },
      },
      byProvider: {
        "openai-images": {
          attempts: 3,
          estimatedCostUsd: 0.067,
          finalCostUsd: 0.042,
        },
        "openai-audio": {
          attempts: 1,
          estimatedCostUsd: 0,
          finalCostUsd: 0,
        },
      },
    });
    expect(Object.keys(summary.byRequest)).toHaveLength(2);
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

  it("updates provider attempts across UTC midnight by entry id", async () => {
    await appendCostLedgerEntry(
      entry({
        id: "req-midnight:attempt-1",
        reqId: "req-midnight",
        status: "provider_attempt_started",
      }),
      new Date("2026-06-21T23:59:59.000Z")
    );

    await expect(
      updateCostLedgerEntry(
        "req-midnight:attempt-1",
        { status: "provider_attempt_succeeded" },
        new Date("2026-06-22T00:00:01.000Z")
      )
    ).resolves.toMatchObject({
      id: "req-midnight:attempt-1",
      period: "2026-06-21",
      status: "provider_attempt_succeeded",
    });

    expect(await readCostLedgerPeriod("2026-06-21")).toEqual([
      expect.objectContaining({
        id: "req-midnight:attempt-1",
        status: "provider_attempt_succeeded",
      }),
    ]);
    expect(await readCostLedgerPeriod("2026-06-22")).toEqual([]);
  });

  it("warns and reports dropped entries when a period exceeds the retention cap", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recordedAt = new Date("2026-06-21T12:00:00.000Z");
    await writeScopedState(
      "cost:ledger:period",
      "2026-06-21",
      Array.from({ length: 5_000 }, (_, index) => ({
        ...entry({
          id: `req-overflow:attempt-${index}`,
          reqId: `req-overflow-${index}`,
        }),
        period: "2026-06-21",
        recordedAt: recordedAt.toISOString(),
      })),
      60
    );

    await appendCostLedgerEntry(
      entry({
        id: "req-overflow:attempt-5000",
        reqId: "req-overflow-5000",
      }),
      recordedAt
    );

    const periodEntries = await readCostLedgerPeriod("2026-06-21");
    const loggedPayload = JSON.parse(String(warnSpy.mock.calls[0]?.[0]));

    expect(periodEntries).toHaveLength(5_000);
    expect(periodEntries[0]?.id).toBe("req-overflow:attempt-1");
    expect(periodEntries.at(-1)?.id).toBe("req-overflow:attempt-5000");
    expect(getCostLedgerReliabilityStats()).toEqual({
      droppedEntryCount: 1,
      maxEntriesPerPeriod: 5_000,
    });
    expect(loggedPayload).toMatchObject({
      event: "cost_ledger_period_overflow",
      period: "2026-06-21",
      droppedEntries: 1,
      maxEntriesPerPeriod: 5_000,
      totalDroppedEntries: 1,
    });
    expect(JSON.stringify(loggedPayload)).not.toContain("facebook:");
    expect(JSON.stringify(loggedPayload)).not.toContain("prompt");
  });

  it("bounds delete-my-data cleanup to periods containing the user", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const targetUserKey = "target-user-key-private";

    await appendCostLedgerEntry(
      entry({
        id: "req-delete-a:attempt-1",
        reqId: "req-delete-a",
        userKey: targetUserKey,
      }),
      new Date("2026-06-21T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({
        id: "req-delete-b:attempt-1",
        reqId: "req-delete-b",
        userKey: targetUserKey,
      }),
      new Date("2026-06-19T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      entry({
        id: "req-other-user:attempt-1",
        reqId: "req-other-user",
        userKey: "other-user-key",
      }),
      new Date("2026-06-20T12:00:00.000Z")
    );

    await expect(
      deleteCostLedgerEntriesForUser(
        targetUserKey,
        new Date("2026-06-21T23:59:59.000Z")
      )
    ).resolves.toBe(2);

    expect(await readCostLedgerPeriod("2026-06-21")).toEqual([]);
    expect(await readCostLedgerPeriod("2026-06-19")).toEqual([]);
    expect(await readCostLedgerPeriod("2026-06-20")).toEqual([
      expect.objectContaining({
        id: "req-other-user:attempt-1",
        userKey: "other-user-key",
      }),
    ]);

    const loggedPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(loggedPayload).toMatchObject({
      event: "cost_ledger_user_delete_completed",
      scannedPeriods: 90,
      touchedPeriods: 2,
      deletedEntries: 2,
    });
    expect(JSON.stringify(loggedPayload)).not.toContain(targetUserKey);
  });
});
