import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "../context";

const mocks = vi.hoisted(() => ({
  attestProfile: vi.fn(),
  getProfileStatus: vi.fn(),
  revokeProfile: vi.fn(),
  registerSchedulerTenant: vi.fn(),
  enableSchedulerTenant: vi.fn(),
  disableSchedulerTenant: vi.fn(),
  listOperatorNotifications: vi.fn(),
  acknowledgeOperatorNotification: vi.fn(),
  listCreditReservationTransportReviews: vi.fn(),
  resolveCreditReservationTransport: vi.fn(),
}));

vi.mock("./billingProfileStore", () => ({
  attestWorkspaceBillingProfile: mocks.attestProfile,
  getWorkspaceBillingProfileAttestationStatus: mocks.getProfileStatus,
  revokeWorkspaceBillingProfile: mocks.revokeProfile,
}));

vi.mock("./billingSchedulerStore", () => ({
  registerBillingSchedulerTenant: mocks.registerSchedulerTenant,
  enableBillingSchedulerTenant: mocks.enableSchedulerTenant,
  disableBillingSchedulerTenant: mocks.disableSchedulerTenant,
}));

vi.mock("./billingNotificationInboxStore", () => ({
  listOperatorBillingNotifications: mocks.listOperatorNotifications,
  acknowledgeOperatorBillingNotification: mocks.acknowledgeOperatorNotification,
}));

vi.mock("./creditReservationOperatorResolution", () => ({
  listOpenCreditReservationTransportReviews:
    mocks.listCreditReservationTransportReviews,
  resolveAmbiguousPaidCreditReservation:
    mocks.resolveCreditReservationTransport,
}));

vi.mock("./config", () => ({
  getConfiguredBillingMode: () => "test",
}));

import { billingAdminRouter } from "./billingAdminRouter";

const admin: NonNullable<TrpcContext["user"]> = {
  id: 91,
  openId: "billing-admin-91",
  email: "billing-admin@example.test",
  name: "Billing Admin",
  loginMethod: "facebook",
  role: "admin",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignedIn: new Date(0),
};

function createCaller(user: TrpcContext["user"] = admin) {
  return billingAdminRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });
}

describe("portal Belgian consumer billing attestation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.attestProfile.mockResolvedValue({ eligibilityVersion: 4 });
    mocks.registerSchedulerTenant.mockResolvedValue(undefined);
  });

  it("keeps buyer classification server-owned for the consumer launch", async () => {
    const expiresAt = new Date("2026-09-23T12:00:00.000Z");
    const caller = createCaller();

    await expect(
      caller.attestProfile({
        requestId: "b35ee776-d81e-4dd4-8799-45d4f34d4892",
        workspaceId: 42,
        expectedVersion: 3,
        evidenceReference: "consumer-review:case-42",
        expiresAt,
      })
    ).resolves.toEqual({ success: true, eligibilityVersion: 4 });

    expect(mocks.attestProfile).toHaveBeenCalledWith({
      requestId: "b35ee776-d81e-4dd4-8799-45d4f34d4892",
      workspaceId: 42,
      actorUserId: admin.id,
      expectedVersion: 3,
      evidenceReference: "consumer-review:case-42",
      expiresAt,
    });
    expect(mocks.registerSchedulerTenant).toHaveBeenCalledWith(
      42,
      "test",
      expect.any(Date),
      expect.any(Date),
      expiresAt
    );
  });

  it("rejects a portal attempt to inject business or Peppol buyer policy", async () => {
    const caller = createCaller();
    const attestProfile = caller.attestProfile as (
      input: Record<string, unknown>
    ) => Promise<unknown>;

    await expect(
      attestProfile({
        requestId: "b35ee776-d81e-4dd4-8799-45d4f34d4892",
        workspaceId: 42,
        expectedVersion: 3,
        evidenceReference: "peppol:0208:1040495145",
        expiresAt: new Date("2026-09-23T12:00:00.000Z"),
        customerType: "business",
        peppolReady: true,
      })
    ).rejects.toThrow();

    expect(mocks.attestProfile).not.toHaveBeenCalled();
    expect(mocks.registerSchedulerTenant).not.toHaveBeenCalled();
  });
});

describe("platform operator billing incidents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOperatorNotifications.mockResolvedValue([]);
    mocks.acknowledgeOperatorNotification.mockResolvedValue({
      acknowledgedAt: new Date("2026-08-24T12:00:00.000Z"),
    });
    mocks.listCreditReservationTransportReviews.mockResolvedValue([
      {
        caseRef: "66666666-6666-4666-8666-666666666666",
        mode: "test",
        reservationId: "11111111-1111-8111-8111-111111111111",
        walletId: "22222222-2222-8222-8222-222222222222",
        reason: "credit_reservation_transport_ambiguous",
      },
    ]);
    mocks.resolveCreditReservationTransport.mockResolvedValue({
      result: "applied",
      reservationId: "11111111-1111-8111-8111-111111111111",
      decision: "provider_rejected",
    });
  });

  it("lists and acknowledges only through the global-admin tenant scope", async () => {
    const caller = createCaller();

    await expect(
      caller.operatorNotifications({ workspaceId: 42, limit: 10 })
    ).resolves.toEqual([]);
    await expect(
      caller.acknowledgeOperatorNotification({
        workspaceId: 42,
        notificationId: 81,
      })
    ).resolves.toEqual({
      acknowledgedAt: new Date("2026-08-24T12:00:00.000Z"),
    });

    expect(mocks.listOperatorNotifications).toHaveBeenCalledWith({
      workspaceId: 42,
      limit: 10,
    });
    expect(mocks.acknowledgeOperatorNotification).toHaveBeenCalledWith({
      workspaceId: 42,
      notificationId: 81,
      actorUserId: admin.id,
    });
  });

  it("forbids a non-admin before reading or acknowledging incidents", async () => {
    const caller = createCaller({ ...admin, role: "user" });

    await expect(
      caller.operatorNotifications({ workspaceId: 42 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.acknowledgeOperatorNotification({
        workspaceId: 42,
        notificationId: 81,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.listOperatorNotifications).not.toHaveBeenCalled();
    expect(mocks.acknowledgeOperatorNotification).not.toHaveBeenCalled();
  });

  it("lists an opaque mode-scoped review and resolves that exact reservation", async () => {
    const caller = createCaller();
    const reviews = await caller.creditReservationTransportReviews({
      workspaceId: 42,
      mode: "test",
      limit: 10,
    });
    const review = reviews[0]!;

    expect(reviews).toEqual([
      {
        caseRef: "66666666-6666-4666-8666-666666666666",
        mode: "test",
        reservationId: "11111111-1111-8111-8111-111111111111",
        walletId: "22222222-2222-8222-8222-222222222222",
        reason: "credit_reservation_transport_ambiguous",
      },
    ]);
    expect(mocks.listCreditReservationTransportReviews).toHaveBeenCalledWith({
      workspaceId: 42,
      mode: "test",
      limit: 10,
    });

    const resolution = {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: 42,
      mode: review.mode,
      reservationId: review.reservationId,
      walletId: review.walletId,
      decision: "output_not_delivered" as const,
      evidenceReference: `review-case:${review.caseRef}`,
    };
    await expect(
      caller.resolveCreditReservationTransport(resolution)
    ).resolves.toMatchObject({ result: "applied" });
    expect(mocks.resolveCreditReservationTransport).toHaveBeenCalledWith({
      ...resolution,
      actorUserId: admin.id,
    });
  });

  it("forbids a non-admin before listing transport reviews", async () => {
    await expect(
      createCaller({
        ...admin,
        role: "user",
      }).creditReservationTransportReviews({
        workspaceId: 42,
        mode: "test",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.listCreditReservationTransportReviews).not.toHaveBeenCalled();
  });

  it("resolves one reviewed transport without accepting hidden user scope", async () => {
    const caller = createCaller();
    const input = {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: 42,
      mode: "test" as const,
      reservationId: "11111111-1111-8111-8111-111111111111",
      walletId: "22222222-2222-8222-8222-222222222222",
      decision: "provider_rejected" as const,
      providerStatus: 400,
      evidenceReference: "openai-response:case-400",
    };

    await expect(
      caller.resolveCreditReservationTransport(input)
    ).resolves.toMatchObject({ result: "applied" });
    expect(mocks.resolveCreditReservationTransport).toHaveBeenCalledWith({
      ...input,
      actorUserId: admin.id,
    });

    const unsafeCaller = caller.resolveCreditReservationTransport as (
      value: Record<string, unknown>
    ) => Promise<unknown>;
    await expect(
      unsafeCaller({
        ...input,
        userKey: `u2.k1.${"a".repeat(64)}`,
        ownerTokenHash: "b".repeat(64),
      })
    ).rejects.toThrow();
  });

  it.each([408, 429])(
    "keeps an ambiguous provider %s response held before store access",
    async providerStatus => {
      await expect(
        createCaller().resolveCreditReservationTransport({
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspaceId: 42,
          mode: "test",
          reservationId: "11111111-1111-8111-8111-111111111111",
          walletId: "22222222-2222-8222-8222-222222222222",
          decision: "provider_rejected",
          providerStatus,
          evidenceReference: `openai-response:case-${providerStatus}`,
        })
      ).rejects.toThrow();
      expect(mocks.resolveCreditReservationTransport).not.toHaveBeenCalled();
    }
  );

  it("accepts a reviewed output non-delivery without inventing a provider status", async () => {
    const input = {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: 42,
      mode: "test" as const,
      reservationId: "11111111-1111-8111-8111-111111111111",
      walletId: "22222222-2222-8222-8222-222222222222",
      decision: "output_not_delivered" as const,
      evidenceReference: "messenger-nondelivery:network-ambiguous",
    };

    await expect(
      createCaller().resolveCreditReservationTransport(input)
    ).resolves.toMatchObject({ result: "applied" });
    expect(mocks.resolveCreditReservationTransport).toHaveBeenCalledWith({
      ...input,
      actorUserId: admin.id,
    });
  });

  it("forbids a non-admin before resolving a reviewed transport", async () => {
    await expect(
      createCaller({
        ...admin,
        role: "user",
      }).resolveCreditReservationTransport({
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: 42,
        mode: "test",
        reservationId: "11111111-1111-8111-8111-111111111111",
        walletId: "22222222-2222-8222-8222-222222222222",
        decision: "delivered_output",
        providerStatus: 200,
        evidenceReference: "openai-response:case-200",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.resolveCreditReservationTransport).not.toHaveBeenCalled();
  });
});
