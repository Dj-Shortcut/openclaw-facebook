import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  commitStartpilotAiAnswerUsageMock,
  getDatabaseOrThrowMock,
  isMollieEntitlementEnforcementEnabledMock,
  releaseStartpilotAiAnswerUsageMock,
  resolveWorkspaceRuntimePolicyMock,
  reserveStartpilotAiAnswerUsageMock,
} = vi.hoisted(() => ({
  commitStartpilotAiAnswerUsageMock: vi.fn(),
  getDatabaseOrThrowMock: vi.fn(),
  isMollieEntitlementEnforcementEnabledMock: vi.fn(() => true),
  releaseStartpilotAiAnswerUsageMock: vi.fn(),
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
  commitStartpilotAiAnswerUsage: commitStartpilotAiAnswerUsageMock,
  releaseStartpilotAiAnswerUsage: releaseStartpilotAiAnswerUsageMock,
}));
vi.mock("./db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  finalizeInternalAiAnswerQuota,
  reserveInternalAiAnswerQuota,
} from "./_core/internalAiAnswerQuota";

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
  commitStartpilotAiAnswerUsageMock.mockResolvedValue({ committed: true });
  releaseStartpilotAiAnswerUsageMock.mockResolvedValue({ released: true });
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
      })
    ).resolves.toEqual({ status: "not_applicable" });
    expect(reserveStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
  });

  it("fails closed before lookup when image-gen enforcement is disabled", async () => {
    isMollieEntitlementEnforcementEnabledMock.mockReturnValue(false);

    await expect(
      reserveInternalAiAnswerQuota({
        pageId: "paid-page",
        idempotencyKey: `messenger_ai_answer:${"e".repeat(64)}`,
      })
    ).rejects.toMatchObject({
      code: "enforcement_disabled",
      message: "AI answer quota is unavailable",
    });
    expect(resolveWorkspaceRuntimePolicyMock).not.toHaveBeenCalled();
  });

  it("finalizes against the stored reservation scope after enforcement changes", async () => {
    isMollieEntitlementEnforcementEnabledMock.mockReturnValue(false);
    const limitMock = vi
      .fn()
      .mockResolvedValue([
        { workspaceId: 41, entitlementId: 73, mode: "live" },
      ]);
    const whereMock = vi.fn(() => ({ limit: limitMock }));
    const innerJoinMock = vi.fn(() => ({ where: whereMock }));
    const fromMock = vi.fn(() => ({ innerJoin: innerJoinMock }));
    const selectMock = vi.fn(() => ({ from: fromMock }));
    getDatabaseOrThrowMock.mockResolvedValue({ select: selectMock });

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "page-1",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        outcome: "committed",
      })
    ).resolves.toEqual({ status: "finalized" });

    expect(resolveWorkspaceRuntimePolicyMock).not.toHaveBeenCalled();
    expect(commitStartpilotAiAnswerUsageMock).toHaveBeenCalledWith({
      workspaceId: 41,
      entitlementId: 73,
      mode: "live",
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
    });
  });

  it("does not finalize a reservation outside the requested Page scope", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn(() => ({ limit: limitMock }));
    const innerJoinMock = vi.fn(() => ({ where: whereMock }));
    const fromMock = vi.fn(() => ({ innerJoin: innerJoinMock }));
    const selectMock = vi.fn(() => ({ from: fromMock }));
    getDatabaseOrThrowMock.mockResolvedValue({ select: selectMock });

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "another-page",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        outcome: "committed",
      })
    ).rejects.toMatchObject({
      code: "reservation_scope_unavailable",
      message: "AI answer quota is unavailable",
    });
    expect(commitStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
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
      })
    ).resolves.toEqual({ status: "duplicate" });
  });
});
