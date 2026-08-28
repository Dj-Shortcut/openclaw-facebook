import { describe, expect, it, vi } from "vitest";

import type { ExpiredCreditReservation } from "./creditReservationExpiryStore";
import { runCreditReservationExpiryOnce } from "./creditReservationExpiryWorker";

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

describe("credit reservation expiry worker", () => {
  it("expires each due hold with stable exact terminal evidence", async () => {
    const expire = vi.fn(async () => ({
      result: "applied" as const,
      reservationId: ROW.reservationId,
    }));
    const dependencies = {
      mode: () => "test" as const,
      list: vi.fn(async () => [ROW]),
      expire,
    };
    const now = new Date("2026-08-28T12:00:00.000Z");

    await expect(
      runCreditReservationExpiryOnce(25, now, dependencies)
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
    await runCreditReservationExpiryOnce(25, now, dependencies);
    expect(expire.mock.calls[0]?.[0]).toEqual(first);
  });

  it("does nothing when no reservation is due", async () => {
    const expire = vi.fn();
    await expect(
      runCreditReservationExpiryOnce(25, new Date(), {
        mode: () => "test",
        list: vi.fn(async () => []),
        expire,
      })
    ).resolves.toBe(0);
    expect(expire).not.toHaveBeenCalled();
  });

  it("propagates a terminal failure so the next poll retries", async () => {
    const expire = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(
      runCreditReservationExpiryOnce(25, new Date(), {
        mode: () => "test",
        list: vi.fn(async () => [ROW]),
        expire,
      })
    ).rejects.toThrow("database unavailable");
  });
});
