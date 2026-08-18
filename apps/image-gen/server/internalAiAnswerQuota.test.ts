import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const {
  commitStartpilotAiAnswerUsageMock,
  getDatabaseOrThrowMock,
  isMollieEntitlementEnforcementEnabledMock,
  releaseStartpilotAiAnswerUsageMock,
  resolveWorkspaceRuntimePolicyMock,
  resolveMessengerGenerationOwnershipMock,
  reserveStartpilotAiAnswerUsageMock,
} = vi.hoisted(() => ({
  commitStartpilotAiAnswerUsageMock: vi.fn(),
  getDatabaseOrThrowMock: vi.fn(),
  isMollieEntitlementEnforcementEnabledMock: vi.fn(() => true),
  releaseStartpilotAiAnswerUsageMock: vi.fn(),
  resolveWorkspaceRuntimePolicyMock: vi.fn(),
  resolveMessengerGenerationOwnershipMock: vi.fn(),
  reserveStartpilotAiAnswerUsageMock: vi.fn(),
}));

vi.mock("./_core/billing/config", () => ({
  assertTenantBillingWorkerWorkspace: vi.fn(),
  isMollieEntitlementEnforcementEnabled:
    isMollieEntitlementEnforcementEnabledMock,
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  resolveWorkspaceRuntimePolicy: resolveWorkspaceRuntimePolicyMock,
  resolveMessengerGenerationOwnership: resolveMessengerGenerationOwnershipMock,
  assertMessengerGenerationOwnership: vi.fn(),
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
  markInternalAiAnswerDeliveryStarted,
  reserveInternalAiAnswerQuota,
} from "./_core/internalAiAnswerQuota";

const originalDatabaseUrl = process.env.DATABASE_URL;
const OWNER_TOKEN = "11111111-1111-4111-8111-111111111111";

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
  resolveMessengerGenerationOwnershipMock.mockResolvedValue({
    workspaceId: 1,
    channelConnectionId: 3,
    bindingEpoch: 4,
    pageId: "page-1",
  });
  commitStartpilotAiAnswerUsageMock.mockResolvedValue({ committed: true });
  releaseStartpilotAiAnswerUsageMock.mockResolvedValue({ released: true });
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function mockStoredReservationScope(
  scope = { workspaceId: 41, entitlementId: 73, mode: "live" as const }
) {
  const limitMock = vi.fn().mockResolvedValue([scope]);
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  getDatabaseOrThrowMock.mockResolvedValue({ select: selectMock });
  return scope;
}

describe("internal Startpilot AI-answer quota service", () => {
  it("leaves a Page without an active paid entitlement unaffected", async () => {
    resolveWorkspaceRuntimePolicyMock.mockResolvedValue({ kind: "free" });

    await expect(
      reserveInternalAiAnswerQuota({
        pageId: "free-page",
        idempotencyKey: `messenger_ai_answer:${"f".repeat(64)}`,
        ownerToken: OWNER_TOKEN,
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
        ownerToken: OWNER_TOKEN,
      })
    ).rejects.toMatchObject({
      code: "enforcement_disabled",
      message: "AI answer quota is unavailable",
    });
    expect(resolveWorkspaceRuntimePolicyMock).not.toHaveBeenCalled();
  });

  it("finalizes against the stored reservation scope after enforcement changes", async () => {
    isMollieEntitlementEnforcementEnabledMock.mockReturnValue(false);
    const scope = mockStoredReservationScope();

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "page-1",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        ownerToken: OWNER_TOKEN,
        outcome: "committed",
      })
    ).resolves.toEqual({ status: "finalized" });

    expect(resolveWorkspaceRuntimePolicyMock).not.toHaveBeenCalled();
    expect(commitStartpilotAiAnswerUsageMock).toHaveBeenCalledWith({
      ...scope,
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
      ownerTokenHash:
        "bd7662a5eeb41614e720d477abfcb2272e19a8a70a93b7e3bc8560d44ad326e9",
    });
  });

  it("releases against the stored reservation scope", async () => {
    const scope = mockStoredReservationScope();

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "page-1",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        ownerToken: OWNER_TOKEN,
        outcome: "released",
      })
    ).resolves.toEqual({ status: "finalized" });

    expect(releaseStartpilotAiAnswerUsageMock).toHaveBeenCalledWith({
      ...scope,
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
      ownerTokenHash:
        "bd7662a5eeb41614e720d477abfcb2272e19a8a70a93b7e3bc8560d44ad326e9",
    });
    expect(commitStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
  });

  it("rejects a commit that the store did not finalize", async () => {
    mockStoredReservationScope();
    commitStartpilotAiAnswerUsageMock.mockResolvedValue({ committed: false });

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "page-1",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        ownerToken: OWNER_TOKEN,
        outcome: "committed",
      })
    ).rejects.toMatchObject({
      code: "reservation_not_finalized",
      message: "AI answer quota is unavailable",
    });
    expect(releaseStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
  });

  it("rejects a release that the store did not finalize", async () => {
    mockStoredReservationScope();
    releaseStartpilotAiAnswerUsageMock.mockResolvedValue({ released: false });

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "page-1",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        ownerToken: OWNER_TOKEN,
        outcome: "released",
      })
    ).rejects.toMatchObject({
      code: "reservation_not_finalized",
      message: "AI answer quota is unavailable",
    });
    expect(commitStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
  });

  it("does not finalize a reservation for a different owner capability", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const whereMock = vi.fn(() => ({ limit: limitMock }));
    const fromMock = vi.fn(() => ({ where: whereMock }));
    const selectMock = vi.fn(() => ({ from: fromMock }));
    getDatabaseOrThrowMock.mockResolvedValue({ select: selectMock });

    await expect(
      finalizeInternalAiAnswerQuota({
        pageId: "another-page",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        ownerToken: "22222222-2222-4222-8222-222222222222",
        outcome: "committed",
      })
    ).rejects.toMatchObject({
      code: "reservation_scope_unavailable",
      message: "AI answer quota is unavailable",
    });
    expect(commitStartpilotAiAnswerUsageMock).not.toHaveBeenCalled();
  });

  it("resumes an in-flight idempotent reservation for the same owner", async () => {
    reserveStartpilotAiAnswerUsageMock.mockResolvedValue({
      allowed: true,
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
      alreadyReserved: true,
    });

    await expect(
      reserveInternalAiAnswerQuota({
        pageId: "page-1",
        idempotencyKey: `messenger_ai_answer:${"a".repeat(64)}`,
        ownerToken: OWNER_TOKEN,
      })
    ).resolves.toEqual({
      status: "reserved",
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
    });
  });

  it("marks one transport attempt and idempotently accepts only the same attempt", async () => {
    const now = new Date("2026-08-18T10:00:00.000Z");
    const attemptToken = "22222222-2222-4222-8222-222222222222";
    const reservation = {
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
      workspaceId: 41,
      entitlementId: 73,
      mode: "test" as const,
      kind: "ai_answer" as const,
      status: "reserved" as const,
      ownerTokenHash: createHash("sha256").update(OWNER_TOKEN).digest("hex"),
      ownerLeaseUntil: new Date("2026-08-18T10:01:00.000Z"),
      deliveryStartedAt: null as Date | null,
      deliveryAttemptTokenHash: null as string | null,
    };
    const updateSet = vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(async () => {
        if ("deliveryStartedAt" in values) Object.assign(reservation, values);
        return [{ affectedRows: 1 }];
      }),
    }));
    const tx = {
      select: vi.fn((selection?: unknown) => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () =>
                selection === undefined ? [reservation] : [{ enabled: true }]
              ),
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });
    const input = {
      pageId: "page-1",
      reservationId: reservation.reservationId,
      ownerToken: OWNER_TOKEN,
      deliveryAttemptToken: attemptToken,
      now,
    };

    await expect(markInternalAiAnswerDeliveryStarted(input)).resolves.toEqual({
      status: "delivery_started",
    });
    await expect(markInternalAiAnswerDeliveryStarted(input)).resolves.toEqual({
      status: "delivery_started",
    });
    await expect(
      markInternalAiAnswerDeliveryStarted({
        ...input,
        deliveryAttemptToken: "33333333-3333-4333-8333-333333333333",
      })
    ).rejects.toMatchObject({ code: "reservation_not_finalized" });
    expect(
      updateSet.mock.calls.filter(([values]) => "deliveryStartedAt" in values)
    ).toHaveLength(1);
  });
});
