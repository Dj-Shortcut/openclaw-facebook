import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const stateStoreMocks = vi.hoisted(() => ({
  decrementExpiringCounter: vi.fn(),
  deleteEphemeralKeyIfValue: vi.fn(),
  hasEphemeralKey: vi.fn(),
  incrementExpiringCounter: vi.fn(),
  isRedisStateStoreEnabled: vi.fn(),
  readScopedState: vi.fn(),
  setEphemeralKey: vi.fn(),
  setEphemeralKeyIfAbsent: vi.fn(),
  writeScopedState: vi.fn(),
}));

const notificationMocks = vi.hoisted(() => ({
  notifyOwner: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  safeLog: vi.fn(),
}));

function hashRequestId(reqId: string): string {
  const digest = createHash("sha256").update(reqId).digest("hex").slice(0, 24);
  return `req_${digest}`;
}

const TEST_COST_SCOPE = {
  workspaceId: 41,
  channelConnectionId: 7,
  bindingEpoch: 3,
  privacyEpoch: 1,
} as const;

function budgetAggregate(estimatedCostUsd: number) {
  return {
    version: 2,
    period: "2026-06-01",
    attempts: estimatedCostUsd > 0 ? 1 : 0,
    estimatedCostUsd,
    completeEstimateEntries: estimatedCostUsd > 0 ? 1 : 0,
    incompleteEstimateEntries: 0,
    unpricedCostComponents: [],
    byOperation: {},
    byProvider: {},
  };
}

describe("generationGuard", () => {
  let guard: typeof import("./_core/generationGuard");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("./_core/stateStore", () => stateStoreMocks);
    vi.doMock("./_core/logger", () => loggerMocks);
    vi.doMock("./_core/notification", () => notificationMocks);
    vi.doMock("./_core/logger", () => loggerMocks);
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.decrementExpiringCounter.mockResolvedValue(1);
    stateStoreMocks.incrementExpiringCounter.mockResolvedValue(1);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);
    stateStoreMocks.readScopedState.mockResolvedValue(null);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockResolvedValue(true);
    stateStoreMocks.writeScopedState.mockResolvedValue(undefined);
    stateStoreMocks.deleteEphemeralKeyIfValue.mockResolvedValue(true);
    notificationMocks.notifyOwner.mockResolvedValue(true);
    guard = await import("./_core/generationGuard");
  });

  afterEach(() => {
    delete process.env.MESSENGER_MAX_IMAGE_JOBS;
    delete process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS;
    delete process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP;
    delete process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
    delete process.env.MESSENGER_GLOBAL_DAILY_VIDEO_CAP;
    delete process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;
    delete process.env.MESSENGER_OWNER_COST_ALERTS;
    delete process.env.MESSENGER_PSID_COOLDOWN_MS;
    delete process.env.MESSENGER_PSID_LOCK_TTL_MS;
    vi.restoreAllMocks();
    vi.doUnmock("./_core/stateStore");
    vi.doUnmock("./_core/logger");
    vi.doUnmock("./_core/notification");
    vi.doUnmock("./_core/logger");
    vi.clearAllMocks();
  });

  it("uses Redis-backed global slots when Redis state is enabled", async () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "2";
    process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS = "5000";
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(true);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockImplementation(
      async (key: string) => {
        if (key === "messenger:inflight:psid-1") {
          return true;
        }

        return key === "messenger:global-inflight:1";
      }
    );

    await expect(
      guard.runGuardedGeneration("psid-1", async () => "done")
    ).resolves.toBe("done");

    expect(stateStoreMocks.setEphemeralKeyIfAbsent).toHaveBeenCalledWith(
      "messenger:global-inflight:0",
      expect.any(String),
      5
    );
    expect(stateStoreMocks.setEphemeralKeyIfAbsent).toHaveBeenCalledWith(
      "messenger:global-inflight:1",
      expect.any(String),
      5
    );
    expect(stateStoreMocks.deleteEphemeralKeyIfValue).toHaveBeenCalledWith(
      "messenger:global-inflight:1",
      expect.any(String)
    );
  });

  it("skips distributed global slots in memory mode", async () => {
    stateStoreMocks.hasEphemeralKey.mockResolvedValue(false);
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);
    stateStoreMocks.setEphemeralKeyIfAbsent.mockResolvedValue(true);

    await expect(
      guard.runGuardedGeneration("psid-2", async () => "done")
    ).resolves.toBe("done");

    expect(stateStoreMocks.setEphemeralKeyIfAbsent).not.toHaveBeenCalledWith(
      expect.stringContaining("messenger:global-inflight"),
      expect.any(String),
      expect.any(Number)
    );
  });

  it("reports Redis-backed global slot usage", async () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "3";
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(true);
    stateStoreMocks.hasEphemeralKey.mockImplementation(
      async (key: string) =>
        key === "messenger:global-inflight:0" ||
        key === "messenger:global-inflight:2"
    );

    await expect(
      guard.getMessengerGenerationGlobalLimitStats()
    ).resolves.toEqual({
      redisBacked: true,
      max: 3,
      active: 2,
    });
  });

  it("reports configured max without active slots in memory mode", async () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "4";
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(false);

    await expect(
      guard.getMessengerGenerationGlobalLimitStats()
    ).resolves.toEqual({
      redisBacked: false,
      max: 4,
      active: 0,
    });
  });

  it("reports startup config for the global generation limiter", () => {
    process.env.MESSENGER_MAX_IMAGE_JOBS = "5";
    process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS = "45000";
    stateStoreMocks.isRedisStateStoreEnabled.mockReturnValue(true);

    expect(guard.getMessengerGenerationGlobalLimitConfig()).toEqual({
      redisBacked: true,
      max: 5,
      lockTtlMs: 45000,
    });
  });

  it("reports whether the daily image budget cap is enabled", () => {
    expect(guard.getMessengerDailyImageBudgetConfig()).toEqual({
      enabled: false,
      cap: null,
    });

    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "25";

    expect(guard.getMessengerDailyImageBudgetConfig()).toEqual({
      enabled: true,
      cap: 25,
    });
  });

  it("does not reserve daily image budget when no cap is configured", async () => {
    await expect(
      guard.assertMessengerDailyImageBudgetAvailable({ reqId: "req-no-cap" })
    ).resolves.toBeUndefined();

    expect(stateStoreMocks.incrementExpiringCounter).not.toHaveBeenCalled();
  });

  it("reserves budget in a UTC daily counter when a cap is configured", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "2";
    const now = new Date("2026-06-01T23:59:30.000Z");

    await expect(
      guard.assertMessengerDailyImageBudgetAvailable({
        reqId: "req-budget",
        now,
      })
    ).resolves.toBeUndefined();

    expect(stateStoreMocks.incrementExpiringCounter).toHaveBeenCalledWith(
      "messenger:daily-image-budget:2026-06-01",
      30
    );
  });

  it("throws when the configured daily image budget is exceeded", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";
    stateStoreMocks.incrementExpiringCounter.mockResolvedValue(2);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      guard.assertMessengerDailyImageBudgetAvailable({
        reqId: "req-over-budget",
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(guard.MessengerDailyImageBudgetExceededError);
    expect(stateStoreMocks.decrementExpiringCounter).toHaveBeenCalledWith(
      "messenger:daily-image-budget:2026-06-01"
    );
    expect(loggerMocks.safeLog).toHaveBeenCalledWith(
      "messenger_daily_image_budget_reached",
      expect.objectContaining({
        reqId: hashRequestId("req-over-budget"),
        cap: 1,
        count: 2,
        level: "warn",
      })
    );
    expect(loggerMocks.safeLog).toHaveBeenCalledTimes(1);
  });

  it("reserves audio transcription budget in a UTC daily counter", async () => {
    process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP = "2";
    const now = new Date("2026-06-01T23:59:30.000Z");

    await expect(
      guard.assertMessengerDailyAudioTranscriptionBudgetAvailable({
        reqId: "req-audio-budget",
        now,
      })
    ).resolves.toBeUndefined();

    expect(stateStoreMocks.incrementExpiringCounter).toHaveBeenCalledWith(
      "messenger:daily-audio-transcription-budget:2026-06-01",
      30
    );
  });

  it("throws when the configured daily audio transcription budget is exceeded", async () => {
    process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP = "1";
    stateStoreMocks.incrementExpiringCounter.mockResolvedValue(2);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      guard.assertMessengerDailyAudioTranscriptionBudgetAvailable({
        reqId: "req-audio-over-budget",
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(
      guard.MessengerDailyAudioTranscriptionBudgetExceededError
    );
    expect(stateStoreMocks.decrementExpiringCounter).toHaveBeenCalledWith(
      "messenger:daily-audio-transcription-budget:2026-06-01"
    );
    expect(loggerMocks.safeLog).toHaveBeenCalledWith(
      "messenger_daily_audio_transcription_budget_reached",
      expect.objectContaining({
        reqId: hashRequestId("req-audio-over-budget"),
        cap: 1,
        count: 2,
        level: "warn",
      })
    );
  });

  it("reports whether the daily spend budget cap is enabled", () => {
    expect(guard.getMessengerDailySpendBudgetConfig()).toEqual({
      enabled: false,
      capUsd: null,
    });

    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "1.25";

    expect(guard.getMessengerDailySpendBudgetConfig()).toEqual({
      enabled: true,
      capUsd: 1.25,
    });
  });

  it("allows a priced provider attempt within the daily spend cap", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.05";
    stateStoreMocks.readScopedState.mockResolvedValue(budgetAggregate(0.02));

    await expect(
      guard.assertMessengerDailySpendBudgetAvailable({
        reqId: "req-spend-ok",
        estimatedCostUsd: 0.025,
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).resolves.toBeUndefined();
    expect(stateStoreMocks.readScopedState).toHaveBeenCalledWith(
      "cost:ledger:v2:budget-period",
      "2026-06-01"
    );
  });

  it.each([
    ["negative total", { ...budgetAggregate(0), estimatedCostUsd: -0.01 }],
    ["non-finite total", { ...budgetAggregate(0), estimatedCostUsd: NaN }],
    [
      "untyped operation bucket",
      {
        ...budgetAggregate(0),
        byOperation: {
          image_generation: { attempts: {}, estimatedCostUsd: 0 },
        },
      },
    ],
  ])(
    "fails closed before provider admission for a corrupt daily budget: %s",
    async (_label, aggregate) => {
      process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "1";
      stateStoreMocks.readScopedState.mockResolvedValue(aggregate);
      const providerStart = vi.fn();

      await expect(
        guard.admitMessengerProviderSpend({
          reqId: "corrupt-daily-budget",
          attemptId: "corrupt-daily-budget:attempt-1",
          scope: TEST_COST_SCOPE,
          userKey: "daily-budget-user",
          estimatedCostUsd: 0.01,
          costEstimateComplete: true,
          now: new Date("2026-06-01T12:00:00.000Z"),
          recordAttempt: providerStart,
        })
      ).rejects.toThrow("Cost ledger budget aggregate is invalid");
      expect(providerStart).not.toHaveBeenCalled();
    }
  );

  it("throws when a priced provider attempt would exceed the daily spend cap", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.03";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stateStoreMocks.readScopedState.mockResolvedValue(budgetAggregate(0.02));

    await expect(
      guard.assertMessengerDailySpendBudgetAvailable({
        reqId: "req-spend-over",
        estimatedCostUsd: 0.025,
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
  });

  it("sends an owner cost alert when an opted-in daily spend cap is reached", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.03";
    process.env.MESSENGER_OWNER_COST_ALERTS = "1";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stateStoreMocks.readScopedState.mockResolvedValue(budgetAggregate(0.02));

    await expect(
      guard.assertMessengerDailySpendBudgetAvailable({
        reqId: "req-spend-alert-private",
        estimatedCostUsd: 0.025,
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);

    expect(notificationMocks.notifyOwner).toHaveBeenCalledWith({
      title: "Messenger cost alert",
      content: [
        "scope=global_daily",
        "reason=cap_reached",
        "period=2026-06-01",
        "capUsd=0.03",
        "currentSpendUsd=0.02",
        "attemptEstimateUsd=0.025",
        "projectedSpendUsd=0.045",
      ].join("\n"),
    });
    expect(
      JSON.stringify(notificationMocks.notifyOwner.mock.calls[0]?.[0])
    ).not.toContain("req-spend-alert-private");
  });

  it("fails closed for unpriced provider attempts when the daily spend cap is enabled", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "1";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      guard.assertMessengerDailySpendBudgetAvailable({
        reqId: "req-unpriced",
        estimatedCostUsd: null,
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
  });

  it("fails closed for a positive but incomplete daily attempt estimate", async () => {
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "1";

    await expect(
      guard.assertMessengerDailySpendBudgetAvailable({
        reqId: "req-partial-daily",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.25,
        costEstimateComplete: false,
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
    expect(stateStoreMocks.readScopedState).not.toHaveBeenCalled();
  });

  it("reports whether the monthly spend budget cap is enabled", () => {
    expect(guard.getMessengerMonthlySpendBudgetConfig()).toEqual({
      enabled: false,
      capUsd: null,
    });

    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "25.5";

    expect(guard.getMessengerMonthlySpendBudgetConfig()).toEqual({
      enabled: true,
      capUsd: 25.5,
    });
  });

  it("throws when a priced provider attempt would exceed the monthly spend cap", async () => {
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "0.03";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stateStoreMocks.readScopedState.mockImplementation(
      async (_scope: string, period: string) =>
        period === "2026-06-01" ? budgetAggregate(0.02) : null
    );

    await expect(
      guard.assertMessengerMonthlySpendBudgetAvailable({
        reqId: "req-monthly-spend-over",
        estimatedCostUsd: 0.025,
        now: new Date("2026-06-15T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
  });

  it("fails closed before provider admission for a corrupt monthly budget", async () => {
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "1";
    stateStoreMocks.readScopedState.mockImplementation(
      async (_scope: string, period: string) =>
        period === "2026-06-01"
          ? { ...budgetAggregate(0), estimatedCostUsd: -0.01 }
          : null
    );
    const providerStart = vi.fn();

    await expect(
      guard.admitMessengerProviderSpend({
        reqId: "corrupt-monthly-budget",
        attemptId: "corrupt-monthly-budget:attempt-1",
        scope: TEST_COST_SCOPE,
        userKey: "monthly-budget-user",
        estimatedCostUsd: 0.01,
        costEstimateComplete: true,
        now: new Date("2026-06-15T12:00:00.000Z"),
        recordAttempt: providerStart,
      })
    ).rejects.toThrow("Cost ledger budget aggregate is invalid");
    expect(providerStart).not.toHaveBeenCalled();
  });

  it("fails closed for unpriced provider attempts when the monthly spend cap is enabled", async () => {
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "1";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      guard.assertMessengerMonthlySpendBudgetAvailable({
        reqId: "req-monthly-unpriced",
        estimatedCostUsd: null,
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
  });

  it("fails closed for a positive but incomplete monthly attempt estimate", async () => {
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "1";

    await expect(
      guard.assertMessengerMonthlySpendBudgetAvailable({
        reqId: "req-partial-monthly",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.25,
        costEstimateComplete: false,
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
    expect(stateStoreMocks.readScopedState).not.toHaveBeenCalled();
  });

  it("reports whether the per-user daily spend budget cap is enabled", () => {
    expect(guard.getMessengerUserDailySpendBudgetConfig()).toEqual({
      enabled: false,
      capUsd: null,
    });

    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.75";

    expect(guard.getMessengerUserDailySpendBudgetConfig()).toEqual({
      enabled: true,
      capUsd: 0.75,
    });
  });

  it("counts only the matching user for the per-user daily spend cap", async () => {
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.05";
    stateStoreMocks.readScopedState.mockResolvedValue([
      {
        scope: TEST_COST_SCOPE,
        id: "same-user",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "same-user-key",
        reqId: "sha256:req-same-user",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.02,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
        period: "2026-06-01",
        recordedAt: "2026-06-01T10:00:00.000Z",
      },
      {
        scope: TEST_COST_SCOPE,
        id: "other-user",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "other-user-key",
        reqId: "sha256:req-other-user",
        status: "provider_attempt_started",
        estimatedCostUsd: 99,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
        period: "2026-06-01",
        recordedAt: "2026-06-01T10:00:00.000Z",
      },
    ]);

    await expect(
      guard.assertMessengerUserDailySpendBudgetAvailable({
        reqId: "req-user-spend-ok",
        scope: TEST_COST_SCOPE,
        userKey: "same-user-key",
        estimatedCostUsd: 0.025,
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).resolves.toBeUndefined();
    expect(stateStoreMocks.readScopedState).toHaveBeenCalledWith(
      "cost:ledger:v2:workspace-period",
      "{cost-ledger-v2:41}:period:2026-06-01"
    );
  });

  it("throws when a matching user would exceed the per-user daily spend cap", async () => {
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.03";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stateStoreMocks.readScopedState.mockResolvedValue([
      {
        scope: TEST_COST_SCOPE,
        id: "same-user",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "same-user-key",
        reqId: "sha256:req-same-user",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.02,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
        period: "2026-06-01",
        recordedAt: "2026-06-01T10:00:00.000Z",
      },
    ]);

    await expect(
      guard.assertMessengerUserDailySpendBudgetAvailable({
        reqId: "req-user-spend-over",
        scope: TEST_COST_SCOPE,
        userKey: "same-user-key",
        estimatedCostUsd: 0.025,
        now: new Date("2026-06-01T12:00:00.000Z"),
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
    expect(loggerMocks.safeLog).toHaveBeenCalledWith(
      "messenger_user_daily_spend_budget_reached",
      expect.objectContaining({
        reqId: hashRequestId("req-user-spend-over"),
        capUsd: 0.03,
        user: expect.any(String),
        level: "warn",
      })
    );
  });

  it("fails closed before provider admission for a corrupt user budget entry", async () => {
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "1";
    stateStoreMocks.readScopedState.mockResolvedValue([
      {
        scope: TEST_COST_SCOPE,
        id: "corrupt-user-entry",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "same-user-key",
        reqId: "sha256:corrupt-user-entry",
        status: "provider_attempt_started",
        estimatedCostUsd: -0.5,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
        period: "2026-06-01",
        recordedAt: "2026-06-01T10:00:00.000Z",
      },
    ]);
    const providerStart = vi.fn();

    await expect(
      guard.admitMessengerProviderSpend({
        reqId: "corrupt-user-budget",
        attemptId: "corrupt-user-budget:attempt-1",
        scope: TEST_COST_SCOPE,
        userKey: "same-user-key",
        estimatedCostUsd: 0.01,
        costEstimateComplete: true,
        now: new Date("2026-06-01T12:00:00.000Z"),
        recordAttempt: providerStart,
      })
    ).rejects.toThrow("Cost ledger entry scope is invalid");
    expect(providerStart).not.toHaveBeenCalled();
  });

  it("fails closed for unpriced provider attempts when the per-user spend cap is enabled", async () => {
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "1";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      guard.assertMessengerUserDailySpendBudgetAvailable({
        reqId: "req-user-unpriced",
        scope: TEST_COST_SCOPE,
        userKey: "user-key",
        estimatedCostUsd: null,
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
  });

  it("fails closed for a positive but incomplete per-user attempt estimate", async () => {
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "1";

    await expect(
      guard.assertMessengerUserDailySpendBudgetAvailable({
        reqId: "req-user-partial",
        scope: TEST_COST_SCOPE,
        userKey: "user-key",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.25,
        costEstimateComplete: false,
      })
    ).rejects.toBeInstanceOf(guard.MessengerSpendBudgetExceededError);
    expect(stateStoreMocks.readScopedState).not.toHaveBeenCalled();
  });
});
