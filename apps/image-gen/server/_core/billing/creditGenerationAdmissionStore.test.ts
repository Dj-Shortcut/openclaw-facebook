import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  readCreditGenerationReservation,
  readCurrentCreditWalletIdentity,
} from "./creditGenerationAdmissionStore";

const scope = Object.freeze({
  workspaceId: 42,
  mode: "test" as const,
  channelConnectionId: 12,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: `u2.k1.${"a".repeat(64)}`,
  walletId: "11111111-1111-1111-1111-111111111111",
  financialSubjectRef: "b".repeat(64),
});

const input = Object.freeze({
  scope,
  reservationId: "22222222-2222-8222-8222-222222222222",
  generationRequestKeyHash: "c".repeat(64),
  ownerTokenHash: "d".repeat(64),
  reservedCreditCount: 1 as const,
});

function databaseReturning(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { database: { select }, where, limit };
}

beforeEach(() => {
  getDatabaseOrThrowMock.mockReset();
});

describe("credit generation reservation lookup", () => {
  it("requires one exact user-scoped deterministic reservation", async () => {
    const harness = databaseReturning([{ status: "reserved" }]);
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(readCreditGenerationReservation(input)).resolves.toEqual({
      status: "reserved",
    });

    expect(harness.limit).toHaveBeenCalledWith(2);
    const predicate = harness.where.mock.calls[0]?.[0];
    const compiled = new MySqlDialect().sqlToQuery(predicate);
    expect(compiled.sql).toContain(
      "`credit_reservations`.`reservation_id` = ?"
    );
    expect(compiled.sql).toContain("`credit_reservations`.`wallet_id` = ?");
    expect(compiled.sql).toContain("`credit_reservations`.`workspace_id` = ?");
    expect(compiled.sql).toContain(
      "`credit_reservations`.`channel_connection_id` = ?"
    );
    expect(compiled.sql).toContain("`credit_reservations`.`binding_epoch` = ?");
    expect(compiled.sql).toContain("`credit_reservations`.`privacy_epoch` = ?");
    expect(compiled.sql).toContain(
      "`credit_reservations`.`financial_subject_ref` = ?"
    );
    expect(compiled.sql).toContain(
      "`credit_reservations`.`generation_request_key_hash` = ?"
    );
    expect(compiled.sql).toContain(
      "`credit_reservations`.`owner_token_hash` = ?"
    );
    expect(compiled.sql).toContain(
      "`credit_reservations`.`reserved_credit_count` = ?"
    );
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        input.reservationId,
        scope.walletId,
        scope.workspaceId,
        scope.mode,
        scope.channelConnectionId,
        scope.bindingEpoch,
        scope.privacyEpoch,
        scope.financialSubjectRef,
        input.generationRequestKeyHash,
        input.ownerTokenHash,
        input.reservedCreditCount,
      ])
    );
  });

  it.each([
    { label: "zero", rows: [] },
    {
      label: "duplicate",
      rows: [{ status: "reserved" }, { status: "reserved" }],
    },
  ])("fails closed for $label reservation rows", async ({ rows }) => {
    const harness = databaseReturning(rows);
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(readCreditGenerationReservation(input)).resolves.toBeNull();
  });
});

describe("current credit wallet identity lookup", () => {
  const subject = Object.freeze({
    workspaceId: scope.workspaceId,
    mode: scope.mode,
    channelConnectionId: scope.channelConnectionId,
    bindingEpoch: scope.bindingEpoch,
    privacyEpoch: scope.privacyEpoch,
    userKey: scope.userKey,
  });

  it("resolves one exact non-erased Messenger subject", async () => {
    const identity = {
      walletId: scope.walletId,
      financialSubjectRef: scope.financialSubjectRef,
      status: "active",
      refundAdjustmentEntryId: null,
    };
    const harness = databaseReturning([identity]);
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(readCurrentCreditWalletIdentity(subject)).resolves.toEqual({
      walletId: identity.walletId,
      financialSubjectRef: identity.financialSubjectRef,
      checkoutAvailable: true,
    });
    expect(harness.limit).toHaveBeenCalledWith(2);
    const predicate = harness.where.mock.calls[0]?.[0];
    const compiled = new MySqlDialect().sqlToQuery(predicate);
    expect(compiled.sql).toContain("`credit_wallets`.`workspace_id` = ?");
    expect(compiled.sql).toContain("`credit_wallets`.`mode` = ?");
    expect(compiled.sql).toContain(
      "`credit_wallets`.`channel_connection_id` = ?"
    );
    expect(compiled.sql).toContain("`credit_wallets`.`binding_epoch` = ?");
    expect(compiled.sql).toContain("`credit_wallets`.`privacy_epoch` = ?");
    expect(compiled.sql).toContain(
      "`credit_wallets`.`current_user_key_hash` = ?"
    );
    expect(compiled.sql).toContain("`credit_wallets`.`status` in (?, ?)");
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        subject.workspaceId,
        subject.mode,
        subject.channelConnectionId,
        subject.bindingEpoch,
        subject.privacyEpoch,
        subject.userKey,
        "active",
        "frozen",
      ])
    );
  });

  it.each([
    {
      label: "an exact refund adjustment is pending",
      status: "active",
      refundAdjustmentEntryId: "44444444-4444-4444-8444-444444444444",
    },
    {
      label: "the wallet is frozen",
      status: "frozen",
      refundAdjustmentEntryId: null,
    },
  ])("keeps identity but blocks checkout when $label", async row => {
    const harness = databaseReturning([
      {
        walletId: scope.walletId,
        financialSubjectRef: scope.financialSubjectRef,
        status: row.status,
        refundAdjustmentEntryId: row.refundAdjustmentEntryId,
      },
    ]);
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(readCurrentCreditWalletIdentity(subject)).resolves.toEqual({
      walletId: scope.walletId,
      financialSubjectRef: scope.financialSubjectRef,
      checkoutAvailable: false,
    });
  });

  it("returns no identity for a new subject and rejects ambiguity", async () => {
    const empty = databaseReturning([]);
    getDatabaseOrThrowMock.mockResolvedValueOnce(empty.database);
    await expect(readCurrentCreditWalletIdentity(subject)).resolves.toBeNull();

    const duplicate = databaseReturning([
      {
        walletId: scope.walletId,
        financialSubjectRef: scope.financialSubjectRef,
        status: "active",
        refundAdjustmentEntryId: null,
      },
      {
        walletId: "33333333-3333-3333-3333-333333333333",
        financialSubjectRef: "e".repeat(64),
        status: "active",
        refundAdjustmentEntryId: null,
      },
    ]);
    getDatabaseOrThrowMock.mockResolvedValueOnce(duplicate.database);
    await expect(readCurrentCreditWalletIdentity(subject)).rejects.toThrow(
      "Credit wallet identity is ambiguous"
    );
  });
});
