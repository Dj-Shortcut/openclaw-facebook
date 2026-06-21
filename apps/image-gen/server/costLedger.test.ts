import { afterEach, describe, expect, it } from "vitest";
import {
  appendCostLedgerEntry,
  readCostLedgerPeriod,
  summarizeCostLedgerPeriod,
} from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";

describe("cost ledger", () => {
  afterEach(() => {
    clearStateStore();
  });

  it("stores metadata-only provider attempt entries by UTC period", async () => {
    await appendCostLedgerEntry(
      {
        id: "req-cost-ledger:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        pricingModel: "gpt-image-1",
        userKey: "pseudonymous-user-key",
        reqId: "req-cost-ledger",
        generationKind: "text_to_image",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      new Date("2026-06-21T12:34:56.000Z")
    );

    const entries = await readCostLedgerPeriod("2026-06-21");

    expect(entries).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^ledger_[a-f0-9]{24}$/),
        createdAt: "2026-06-21T12:34:56.000Z",
        period: "2026-06-21",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "pseudonymous-user-key",
        reqId: expect.stringMatching(/^req_[a-f0-9]{24}$/),
        status: "provider_attempt_started",
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain("req-cost-ledger");
    expect(JSON.stringify(entries)).not.toContain("req-cost-ledger:attempt-1");
    expect(JSON.stringify(entries)).not.toContain("prompt");
    expect(JSON.stringify(entries)).not.toContain("raw");
    expect(JSON.stringify(entries)).not.toContain("facebook:");
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

    expect(summary).toEqual({
      period: "2026-06-21",
      totalEntries: 3,
      uniqueUserCount: 2,
      estimatedCostUsd: 0.067,
      finalCostUsd: 0,
      completeEstimateEntries: 1,
      incompleteEstimateEntries: 2,
      unpricedCostComponents: {
        audio_duration: 1,
        source_image_input: 1,
      },
      byOperation: {
        image_generation: {
          attempts: 2,
          estimatedCostUsd: 0.067,
          finalCostUsd: 0,
          incompleteEstimateEntries: 1,
        },
        audio_transcription: {
          attempts: 1,
          estimatedCostUsd: 0,
          finalCostUsd: 0,
          incompleteEstimateEntries: 1,
        },
      },
      byProvider: {
        "openai-images": {
          attempts: 2,
          estimatedCostUsd: 0.067,
          finalCostUsd: 0,
          incompleteEstimateEntries: 1,
        },
        "openai-audio": {
          attempts: 1,
          estimatedCostUsd: 0,
          finalCostUsd: 0,
          incompleteEstimateEntries: 1,
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
      Array.from({ length: 20 }, (_, index) =>
        appendCostLedgerEntry(
          {
            id: `req-concurrent:attempt-${index}`,
            channel: "facebook_messenger",
            operation: "image_generation",
            provider: "openai-images",
            model: "gpt-image-2",
            userKey: `user-key-${index}`,
            reqId: `req-concurrent-${index}`,
            status: "provider_attempt_started",
            estimatedCostUsd: null,
            estimatedOutputCostUsd: null,
            finalCostUsd: null,
            costEstimateComplete: false,
          },
          new Date("2026-06-21T04:00:00.000Z")
        )
      )
    );

    const entries = await readCostLedgerPeriod("2026-06-21");

    expect(entries).toHaveLength(20);
    expect(new Set(entries.map(entry => entry.userKey)).size).toBe(20);
    expect(JSON.stringify(entries)).not.toContain("req-concurrent");
  });
});
