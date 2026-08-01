import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  isMollieEntitlementEnforcementEnabledMock,
  resolveWorkspaceRuntimePolicyMock,
  reserveStartpilotAiAnswerUsageMock,
} = vi.hoisted(() => ({
  isMollieEntitlementEnforcementEnabledMock: vi.fn(() => true),
  resolveWorkspaceRuntimePolicyMock: vi.fn(),
  reserveStartpilotAiAnswerUsageMock: vi.fn(),
}));

vi.mock("./_core/billing/config", () => ({
  isMollieEntitlementEnforcementEnabled:
    isMollieEntitlementEnforcementEnabledMock,
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  resolveWorkspaceRuntimePolicy: resolveWorkspaceRuntimePolicyMock,
}));
vi.mock("./_core/billing/entitlementUsageStore", () => ({
  reserveStartpilotAiAnswerUsage: reserveStartpilotAiAnswerUsageMock,
  commitStartpilotAiAnswerUsage: vi.fn(),
  releaseStartpilotAiAnswerUsage: vi.fn(),
}));

import { reserveInternalAiAnswerQuota } from "./_core/internalAiAnswerQuota";

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "mysql://quota.test/database";
  isMollieEntitlementEnforcementEnabledMock.mockReturnValue(true);
  resolveWorkspaceRuntimePolicyMock.mockResolvedValue({
    kind: "startpilot",
    workspaceId: 1,
    entitlementId: 2,
    mode: "test",
  });
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("internal Startpilot AI-answer quota service", () => {
  it("leaves a Page without an active paid entitlement unaffected", async () => {
    resolveWorkspaceRuntimePolicyMock.mockResolvedValue({ kind: "free" });

    await expect(
      reserveInternalAiAnswerQuota({
        pageId: "free-page",
        idempotencyKey: `messenger_ai_answer:${"f".repeat(64)}`,
      }),
    ).resolves.toEqual({ status: "not_applicable" });
    expect(reserveStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
  });

  it("fails closed before lookup when image-gen enforcement is disabled", async () => {
    isMollieEntitlementEnforcementEnabledMock.mockReturnValue(false);

    await expect(
      reserveInternalAiAnswerQuota({
        pageId: "paid-page",
        idempotencyKey: `messenger_ai_answer:${"e".repeat(64)}`,
      }),
    ).rejects.toThrow("paid entitlement enforcement is disabled");
    expect(resolveWorkspaceRuntimePolicyMock).not.toHaveBeenCalled();
  });

  it("maps an in-flight idempotent reservation to duplicate", async () => {
    reserveStartpilotAiAnswerUsageMock.mockResolvedValue({
      allowed: true,
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
      alreadyReserved: true,
    });

    await expect(
      reserveInternalAiAnswerQuota({
        pageId: "page-1",
        idempotencyKey: `messenger_ai_answer:${"a".repeat(64)}`,
      }),
    ).resolves.toEqual({ status: "duplicate" });
  });
});
