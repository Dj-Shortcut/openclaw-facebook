import { describe, expect, it, vi } from "vitest";

import type {
  ExpiredCreditReservation,
  ExpiredPristineCreditCheckout,
} from "./creditReservationExpiryStore";
import type { DueCreditReservationResolution } from "./creditReservationExpiryStore";
import {
  runCreditReservationExpiryOnce,
  type CreditReservationExpiryDependencies,
} from "./creditReservationExpiryWorker";

const ROW: ExpiredCreditReservation = Object.freeze({
  reservationId: "11111111-1111-8111-8111-111111111111",
  walletId: "22222222-2222-8222-8222-222222222222",
  workspaceId: 42,
  mode: "test",
  channelConnectionId: 7,
  bindingEpoch: 3,
  privacyEpoch: 4,
  userKey: `u2.k1.${"a".repeat(64)}`,
  financialSubjectRef: "b".repeat(64),
  ownerTokenHash: "c".repeat(64),
});

const DUE_TRANSPORT: DueCreditReservationResolution = Object.freeze({
  ...ROW,
  transportState: "transport_started",
  generationRequestKeyHash: "d".repeat(64),
});

const PRISTINE_CHECKOUT: ExpiredPristineCreditCheckout = Object.freeze({
  intentId: "44444444-4444-8444-8444-444444444444",
  walletId: ROW.walletId,
  workspaceId: ROW.workspaceId,
  mode: ROW.mode,
  channelConnectionId: ROW.channelConnectionId,
  bindingEpoch: ROW.bindingEpoch,
  privacyEpoch: ROW.privacyEpoch,
  userKey: ROW.userKey,
  financialSubjectRef: ROW.financialSubjectRef,
});

function dependencies(
  overrides: Partial<CreditReservationExpiryDependencies> = {}
): CreditReservationExpiryDependencies {
  return {
    mode: () => "test" as const,
    list: vi.fn(async () => []),
    listDue: vi.fn(async () => []),
    listPristineCheckouts: vi.fn(async () => []),
    expire: vi.fn(async () => ({
      result: "applied" as const,
      reservationId: ROW.reservationId,
    })),
    expirePristineCheckout: vi.fn(async () => ({
      result: "applied" as const,
      intentId: PRISTINE_CHECKOUT.intentId,
    })),
    commit: vi.fn(async () => ({
      result: "applied" as const,
      reservationId: ROW.reservationId,
    })),
    deriveCommit: vi.fn(() => ({
      entryId: "33333333-3333-8333-8333-333333333333",
      evidenceHash: "e".repeat(64),
    })),
    review: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("credit reservation expiry worker", () => {
  it("expires each due hold with stable exact terminal evidence", async () => {
    const expire = vi.fn(async () => ({
      result: "applied" as const,
      reservationId: ROW.reservationId,
    }));
    const workerDependencies = dependencies({
      list: vi.fn(async () => [ROW]),
      expire,
    });
    const now = new Date("2026-08-28T12:00:00.000Z");

    await expect(
      runCreditReservationExpiryOnce(25, now, workerDependencies)
    ).resolves.toBe(1);
    const first = expire.mock.calls[0]?.[0];
    expect(first).toEqual({
      ...ROW,
      entryId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    expire.mockClear();
    await runCreditReservationExpiryOnce(25, now, workerDependencies);
    expect(expire.mock.calls[0]?.[0]).toEqual(first);
  });

  it("does nothing when no reservation is due", async () => {
    const expire = vi.fn();
    await expect(
      runCreditReservationExpiryOnce(
        25,
        new Date(),
        dependencies({
          list: vi.fn(async () => []),
          expire,
        })
      )
    ).resolves.toBe(0);
    expect(expire).not.toHaveBeenCalled();
  });

  it("propagates a terminal failure so the next poll retries", async () => {
    const expire = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(
      runCreditReservationExpiryOnce(
        25,
        new Date(),
        dependencies({
          list: vi.fn(async () => [ROW]),
          expire,
        })
      )
    ).rejects.toThrow("database unavailable");
  });

  it("removes a bounded expired checkout only through the definer routine", async () => {
    const expirePristineCheckout = vi.fn(async () => ({
      result: "applied" as const,
      intentId: PRISTINE_CHECKOUT.intentId,
    }));
    const listPristineCheckouts = vi.fn(async () => [PRISTINE_CHECKOUT]);
    const now = new Date("2026-08-28T12:00:00.000Z");

    await expect(
      runCreditReservationExpiryOnce(
        25,
        now,
        dependencies({ listPristineCheckouts, expirePristineCheckout })
      )
    ).resolves.toBe(1);

    expect(listPristineCheckouts).toHaveBeenCalledWith("test", now, 25);
    expect(expirePristineCheckout).toHaveBeenCalledWith(PRISTINE_CHECKOUT);
  });

  it("commits a known accepted provider result with reconstructed exact evidence", async () => {
    const commit = vi.fn(async () => ({
      result: "applied" as const,
      reservationId: ROW.reservationId,
    }));
    const review = vi.fn(async () => undefined);
    const knownAccepted: DueCreditReservationResolution = {
      ...DUE_TRANSPORT,
      transportState: "known_accepted",
    };
    const workerDependencies = dependencies({
      listDue: vi.fn(async () => [knownAccepted]),
      commit,
      review,
    });

    await expect(
      runCreditReservationExpiryOnce(25, new Date(), workerDependencies)
    ).resolves.toBe(1);

    expect(commit).toHaveBeenCalledWith({
      workspaceId: ROW.workspaceId,
      mode: ROW.mode,
      channelConnectionId: ROW.channelConnectionId,
      bindingEpoch: ROW.bindingEpoch,
      privacyEpoch: ROW.privacyEpoch,
      userKey: ROW.userKey,
      walletId: ROW.walletId,
      financialSubjectRef: ROW.financialSubjectRef,
      reservationId: ROW.reservationId,
      ownerTokenHash: ROW.ownerTokenHash,
      entryId: "33333333-3333-8333-8333-333333333333",
      evidenceHash: "e".repeat(64),
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("queues one durable review and keeps an ambiguous transport held", async () => {
    const commit = vi.fn();
    const expire = vi.fn();
    const review = vi.fn(async () => undefined);
    const workerDependencies = dependencies({
      listDue: vi.fn(async () => [DUE_TRANSPORT]),
      commit,
      expire,
      review,
    });

    await expect(
      runCreditReservationExpiryOnce(25, new Date(), workerDependencies)
    ).resolves.toBe(1);

    expect(review).toHaveBeenCalledWith(DUE_TRANSPORT);
    expect(commit).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
  });

  it("contains an unprovable known response for review instead of guessing a debit", async () => {
    const commit = vi.fn();
    const review = vi.fn(async () => undefined);
    const knownAccepted: DueCreditReservationResolution = {
      ...DUE_TRANSPORT,
      transportState: "known_accepted",
    };
    const workerDependencies = dependencies({
      listDue: vi.fn(async () => [knownAccepted]),
      deriveCommit: vi.fn(() => null),
      commit,
      review,
    });

    await runCreditReservationExpiryOnce(25, new Date(), workerDependencies);

    expect(commit).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledWith(knownAccepted);
  });
});
