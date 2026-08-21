import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  list: vi.fn(),
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  listBlockedMessengerPrivacyProviderAttempts: mocks.list,
  reconcileMessengerPrivacyProviderAttempt: mocks.reconcile,
}));

import { privacyAdminRouter } from "./_core/privacyAdminRouter";

const request = {
  requestId: "11111111-1111-4111-8111-111111111111",
  attemptKeyHash: "a".repeat(64),
  workspaceId: 41,
  channelConnectionId: 17,
  expectedBindingEpoch: 3,
  expectedPrivacyEpoch: 8,
  expectedAttemptNumber: 2,
  expectedStatus: "ambiguous" as const,
  resolution: "artifacts_contained" as const,
  evidenceReferenceHash: "b".repeat(64),
};

describe("privacy admin provider-attempt recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcile.mockResolvedValue({ resolved: true, status: "contained" });
    mocks.list.mockResolvedValue([]);
  });

  it("requires a platform admin", async () => {
    await expect(
      privacyAdminRouter
        .createCaller(context("user"))
        .reconcileProviderAttempt(request)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("passes only the exact immutable scope and authenticated actor", async () => {
    await expect(
      privacyAdminRouter
        .createCaller(context("admin"))
        .reconcileProviderAttempt(request)
    ).resolves.toEqual({ resolved: true, status: "contained" });
    expect(mocks.reconcile).toHaveBeenCalledWith({
      ...request,
      actorUserId: 73,
    });
  });

  it("requires a bounded reconciliation disposition and metadata-only evidence hash", async () => {
    await expect(
      privacyAdminRouter
        .createCaller(context("admin"))
        .reconcileProviderAttempt({
          ...request,
          evidenceReferenceHash: "raw-provider-ticket",
        })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("lists metadata only within the requested workspace", async () => {
    await privacyAdminRouter
      .createCaller(context("admin"))
      .blockedProviderAttempts({ workspaceId: 41, limit: 25, beforeId: 901 });
    expect(mocks.list).toHaveBeenCalledWith(41, 25, 901);
  });
});

function context(role: "user" | "admin"): TrpcContext {
  return {
    user: {
      id: 73,
      openId: "privacy-admin-test",
      name: "Privacy Admin",
      email: "privacy-admin@example.invalid",
      loginMethod: "test",
      role,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    },
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}
