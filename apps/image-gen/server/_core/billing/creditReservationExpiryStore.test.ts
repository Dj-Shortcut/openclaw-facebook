import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  enqueueCreditReservationTransportReview,
  listDueCreditReservationResolutions,
  listExpiredCreditReservations,
  type DueCreditReservationResolution,
} from "./creditReservationExpiryStore";

describe("credit reservation expiry store", () => {
  beforeEach(() => {
    getDatabaseOrThrowMock.mockReset();
  });

  it("selects only pre-transport holds for expiry", async () => {
    let capturedWhere: unknown;
    const limit = vi.fn(async () => []);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(predicate => {
      capturedWhere = predicate;
      return { orderBy };
    });
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    getDatabaseOrThrowMock.mockResolvedValue({
      select: vi.fn(() => ({ from })),
    });

    await expect(
      listExpiredCreditReservations(
        "test",
        new Date("2026-08-28T12:00:00.000Z"),
        25
      )
    ).resolves.toEqual([]);

    if (!capturedWhere) throw new Error("expiry predicate was not captured");
    const compiled = new MySqlDialect().sqlToQuery(capturedWhere as never);
    expect(compiled.sql).toContain(
      "`credit_reservations`.`transport_state` = ?"
    );
    expect(compiled.params).toContain("pretransport");
    expect(limit).toHaveBeenCalledWith(25);
  });

  it("selects only bounded due transports for deterministic resolution", async () => {
    let capturedWhere: unknown;
    const limit = vi.fn(async () => []);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(predicate => {
      capturedWhere = predicate;
      return { orderBy };
    });
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    getDatabaseOrThrowMock.mockResolvedValue({
      select: vi.fn(() => ({ from })),
    });

    await expect(
      listDueCreditReservationResolutions(
        "test",
        new Date("2026-08-28T12:00:00.000Z"),
        25
      )
    ).resolves.toEqual([]);

    if (!capturedWhere)
      throw new Error("resolution predicate was not captured");
    const compiled = new MySqlDialect().sqlToQuery(capturedWhere as never);
    expect(compiled.sql).toContain(
      "`credit_reservations`.`resolution_due_at` <= ?"
    );
    expect(compiled.params).toEqual(
      expect.arrayContaining(["transport_started", "known_accepted"])
    );
    expect(compiled.sql).toContain("NOT EXISTS");
    expect(compiled.sql).toContain("`credit_transport_reviews`");
    expect(compiled.sql).toContain("credit_reservation_transport_review:");
    expect(limit).toHaveBeenCalledWith(25);
  });

  it("uses per-reservation durable review keys so replayed rows do not starve later rows", async () => {
    const onDuplicateKeyUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
    const insert = vi.fn(() => ({ values }));
    getDatabaseOrThrowMock.mockResolvedValue({ insert });
    const row: DueCreditReservationResolution = {
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
      generationRequestKeyHash: "d".repeat(64),
      transportState: "transport_started",
    };

    const nextRow: DueCreditReservationResolution = {
      ...row,
      reservationId: "33333333-3333-8333-8333-333333333333",
      walletId: "44444444-4444-8444-8444-444444444444",
    };
    await enqueueCreditReservationTransportReview(row);
    await enqueueCreditReservationTransportReview(row);
    await enqueueCreditReservationTransportReview(nextRow);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        mode: "test",
        eventType: "manual_review",
        deduplicationKey:
          "credit_reservation_transport_review:11111111-1111-8111-8111-111111111111",
        payload: {
          reason: "credit_reservation_transport_ambiguous",
          reservationId: row.reservationId,
          walletId: row.walletId,
          creditPurpose: "premium_image_credits",
        },
      })
    );
    expect(JSON.stringify(values.mock.calls[0]?.[0])).not.toContain(
      row.userKey
    );
    expect(values.mock.calls.map(call => call[0]?.deduplicationKey)).toEqual([
      "credit_reservation_transport_review:11111111-1111-8111-8111-111111111111",
      "credit_reservation_transport_review:11111111-1111-8111-8111-111111111111",
      "credit_reservation_transport_review:33333333-3333-8333-8333-333333333333",
    ]);
    expect(JSON.stringify(values.mock.calls[0]?.[0])).not.toContain(
      row.financialSubjectRef
    );
    expect(onDuplicateKeyUpdate).toHaveBeenCalledTimes(3);
  });
});
