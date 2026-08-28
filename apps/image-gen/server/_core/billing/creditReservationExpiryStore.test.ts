import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import { listExpiredCreditReservations } from "./creditReservationExpiryStore";

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
    expect(compiled.sql).toContain("`credit_reservations`.`transport_state` = ?");
    expect(compiled.params).toContain("pretransport");
    expect(limit).toHaveBeenCalledWith(25);
  });
});
