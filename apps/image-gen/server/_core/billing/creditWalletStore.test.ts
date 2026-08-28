import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock, getDatabaseOrThrowMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  applyCreditChargebackDebit,
  applyCreditChargebackRestore,
  applyCreditRefundDebit,
  commitCreditReservation,
  consumeCreditCheckoutCapability,
  createCreditReservationHold,
  CreditWalletStoreError,
  eraseCreditWallet,
  expireCreditReservation,
  grantCreditPurchase,
  markCreditReservationProviderAccepted,
  markCreditReservationTransportStarted,
  releaseCreditReservation,
  reserveCreditCheckoutIntent,
  scrubTerminalCreditReservation,
} from "./creditWalletStore";

const WALLET_ID = "11111111-1111-1111-1111-111111111111";
const INTENT_ID = "22222222-2222-2222-2222-222222222222";
const RESERVATION_ID = "33333333-3333-3333-3333-333333333333";
const ENTRY_ID = "44444444-4444-4444-4444-444444444444";
const ROOT_ENTRY_ID = "55555555-5555-5555-5555-555555555555";
const USER_KEY = "a".repeat(64);
const FINANCIAL_REF = "b".repeat(64);
const CAPABILITY_HASH = "c".repeat(64);
const NONCE_HASH = "d".repeat(64);
const REQUEST_HASH = "e".repeat(64);
const OWNER_HASH = "f".repeat(64);
const EVIDENCE_HASH = "1".repeat(64);
const METADATA_HASH = "2".repeat(64);
const CHECKOUT_SCOPE_KEY = `credit-checkout:v1:${"3".repeat(64)}`;
const CAPABILITY_EXPIRES_AT = new Date("2026-08-28T12:10:00.000Z");

const scope = {
  workspaceId: 11,
  mode: "test" as const,
  channelConnectionId: 12,
  bindingEpoch: 13,
  privacyEpoch: 14,
  userKey: USER_KEY,
  walletId: WALLET_ID,
  financialSubjectRef: FINANCIAL_REF,
};
const erasureScope = { ...scope, erasurePrivacyEpoch: 15 };

const financialScope = {
  workspaceId: scope.workspaceId,
  mode: scope.mode,
  channelConnectionId: scope.channelConnectionId,
  bindingEpoch: scope.bindingEpoch,
  privacyEpoch: scope.privacyEpoch,
  walletId: scope.walletId,
  financialSubjectRef: scope.financialSubjectRef,
};

const terminalInput = {
  ...scope,
  reservationId: RESERVATION_ID,
  ownerTokenHash: OWNER_HASH,
  entryId: ENTRY_ID,
  evidenceHash: EVIDENCE_HASH,
};

const adjustmentInput = {
  ...financialScope,
  rootGrantEntryId: ROOT_ENTRY_ID,
  providerEffectId: "re_credit_refund_1",
  entryId: ENTRY_ID,
  evidenceHash: EVIDENCE_HASH,
};

const checkoutReservationInput = {
  ...scope,
  intentId: INTENT_ID,
  authorizationEpoch: 15,
  offerSnapshotCode: "premium_images_8_medium_v1" as const,
  expectedAmount: "4.99" as const,
  creditCount: 8 as const,
  description: "Leaderbot - 8 premium beeldcredits" as const,
  metadataHash: METADATA_HASH,
  idempotencyKey: `credit-payment:${INTENT_ID}`,
  checkoutScopeKey: CHECKOUT_SCOPE_KEY,
  capabilityHash: CAPABILITY_HASH,
  capabilityExpiresAt: CAPABILITY_EXPIRES_AT,
};

function procedureResponse(
  result: string,
  identifierColumn: string,
  identifierValue: string
) {
  return [
    [
      [{ result, [identifierColumn]: identifierValue }],
      { affectedRows: 0, fieldCount: 0 },
    ],
    [],
  ];
}

function checkoutReservationResponse(result: string) {
  return [
    [
      [{ result, intent_id: INTENT_ID, wallet_id: WALLET_ID }],
      { affectedRows: 0, fieldCount: 0 },
    ],
    [],
  ];
}

function compiledCall(index = 0): { sql: string; params: unknown[] } {
  const query = executeMock.mock.calls[index]?.[0];
  if (!query) throw new Error("Missing captured SQL call");
  return new MySqlDialect().sqlToQuery(query);
}

describe("creditWalletStore procedure boundary", () => {
  beforeEach(() => {
    executeMock.mockReset();
    getDatabaseOrThrowMock.mockReset();
    getDatabaseOrThrowMock.mockResolvedValue({ execute: executeMock });
  });

  it("calls all fourteen frozen procedures with the exact parameter order", async () => {
    const cases = [
      {
        procedure: "credit_reserve_checkout_intent",
        params: [
          INTENT_ID,
          WALLET_ID,
          11,
          "test",
          12,
          13,
          14,
          USER_KEY,
          FINANCIAL_REF,
          15,
          "premium_images_8_medium_v1",
          "4.99",
          8,
          "Leaderbot - 8 premium beeldcredits",
          METADATA_HASH,
          `credit-payment:${INTENT_ID}`,
          CHECKOUT_SCOPE_KEY,
          CAPABILITY_HASH,
          CAPABILITY_EXPIRES_AT,
        ],
        response: checkoutReservationResponse("applied"),
        invoke: () => reserveCreditCheckoutIntent(checkoutReservationInput),
      },
      {
        procedure: "credit_consume_checkout_capability",
        params: [
          11,
          "test",
          12,
          13,
          14,
          USER_KEY,
          WALLET_ID,
          FINANCIAL_REF,
          INTENT_ID,
          CAPABILITY_HASH,
          NONCE_HASH,
        ],
        response: procedureResponse("applied", "intent_id", INTENT_ID),
        invoke: () =>
          consumeCreditCheckoutCapability({
            ...scope,
            intentId: INTENT_ID,
            capabilityHash: CAPABILITY_HASH,
            sessionNonceHash: NONCE_HASH,
          }),
      },
      {
        procedure: "credit_grant_purchase",
        params: [
          11,
          "test",
          12,
          13,
          14,
          USER_KEY,
          WALLET_ID,
          FINANCIAL_REF,
          INTENT_ID,
          "tr_credit_1",
          ENTRY_ID,
          EVIDENCE_HASH,
        ],
        response: procedureResponse("applied", "entry_id", ENTRY_ID),
        invoke: () =>
          grantCreditPurchase({
            ...scope,
            intentId: INTENT_ID,
            providerPaymentId: "tr_credit_1",
            entryId: ENTRY_ID,
            evidenceHash: EVIDENCE_HASH,
          }),
      },
      {
        procedure: "credit_create_reservation_hold",
        params: [
          11,
          "test",
          12,
          13,
          14,
          USER_KEY,
          WALLET_ID,
          FINANCIAL_REF,
          RESERVATION_ID,
          REQUEST_HASH,
          OWNER_HASH,
          2,
          ENTRY_ID,
          EVIDENCE_HASH,
        ],
        response: procedureResponse(
          "applied",
          "reservation_id",
          RESERVATION_ID
        ),
        invoke: () =>
          createCreditReservationHold({
            ...scope,
            reservationId: RESERVATION_ID,
            generationRequestKeyHash: REQUEST_HASH,
            ownerTokenHash: OWNER_HASH,
            reservedCreditCount: 2,
            entryId: ENTRY_ID,
            evidenceHash: EVIDENCE_HASH,
          }),
      },
      ...[
        [
          "credit_mark_reservation_transport_started",
          markCreditReservationTransportStarted,
        ],
        [
          "credit_mark_reservation_provider_accepted",
          markCreditReservationProviderAccepted,
        ],
      ].map(([procedure, invoke]) => ({
        procedure: procedure as string,
        params: [
          11,
          "test",
          12,
          13,
          14,
          USER_KEY,
          WALLET_ID,
          FINANCIAL_REF,
          RESERVATION_ID,
          OWNER_HASH,
        ],
        response: procedureResponse(
          "applied",
          "reservation_id",
          RESERVATION_ID
        ),
        invoke: () =>
          (invoke as typeof markCreditReservationTransportStarted)({
            ...scope,
            reservationId: RESERVATION_ID,
            ownerTokenHash: OWNER_HASH,
          }),
      })),
      ...[
        ["credit_commit_reservation", commitCreditReservation],
        ["credit_release_reservation", releaseCreditReservation],
        ["credit_expire_reservation", expireCreditReservation],
      ].map(([procedure, invoke]) => ({
        procedure: procedure as string,
        params: [
          11,
          "test",
          12,
          13,
          14,
          USER_KEY,
          WALLET_ID,
          FINANCIAL_REF,
          RESERVATION_ID,
          OWNER_HASH,
          ENTRY_ID,
          EVIDENCE_HASH,
        ],
        response: procedureResponse(
          "applied",
          "reservation_id",
          RESERVATION_ID
        ),
        invoke: () => (invoke as typeof commitCreditReservation)(terminalInput),
      })),
      {
        procedure: "credit_scrub_terminal_reservation",
        params: [
          11,
          "test",
          12,
          13,
          14,
          WALLET_ID,
          FINANCIAL_REF,
          RESERVATION_ID,
        ],
        response: procedureResponse(
          "applied",
          "reservation_id",
          RESERVATION_ID
        ),
        invoke: () =>
          scrubTerminalCreditReservation({
            ...financialScope,
            reservationId: RESERVATION_ID,
          }),
      },
      {
        procedure: "credit_erase_wallet",
        params: [
          11,
          "test",
          12,
          13,
          14,
          15,
          USER_KEY,
          WALLET_ID,
          FINANCIAL_REF,
        ],
        response: procedureResponse("erased", "wallet_id", WALLET_ID),
        invoke: () => eraseCreditWallet(erasureScope),
      },
      ...[
        ["credit_apply_refund_debit", applyCreditRefundDebit],
        ["credit_apply_chargeback_debit", applyCreditChargebackDebit],
      ].map(([procedure, invoke]) => ({
        procedure: procedure as string,
        params: [
          11,
          "test",
          12,
          13,
          14,
          WALLET_ID,
          FINANCIAL_REF,
          ROOT_ENTRY_ID,
          "re_credit_refund_1",
          ENTRY_ID,
          EVIDENCE_HASH,
        ],
        response: procedureResponse("applied", "entry_id", ENTRY_ID),
        invoke: () =>
          (invoke as typeof applyCreditRefundDebit)(adjustmentInput),
      })),
      {
        procedure: "credit_apply_chargeback_restore",
        params: [
          11,
          "test",
          12,
          13,
          14,
          WALLET_ID,
          FINANCIAL_REF,
          ROOT_ENTRY_ID,
          "re_credit_refund_1",
          ENTRY_ID,
          EVIDENCE_HASH,
        ],
        response: procedureResponse(
          "applied_review_required",
          "entry_id",
          ENTRY_ID
        ),
        invoke: () => applyCreditChargebackRestore(adjustmentInput),
      },
    ];

    for (const testCase of cases) {
      executeMock.mockResolvedValueOnce(testCase.response);
      await testCase.invoke();
    }

    expect(executeMock).toHaveBeenCalledTimes(14);
    cases.forEach((testCase, index) => {
      const call = compiledCall(index);
      expect(call.sql).toBe(
        `CALL \`${testCase.procedure}\`(${testCase.params.map(() => "?").join(", ")})`
      );
      expect(call.params).toEqual(testCase.params);
      expect(call.sql).not.toMatch(/\b(?:insert|update|delete)\b/i);
      expect(call.sql).not.toMatch(/credit_(?:wallets|ledger|reservations)/i);
    });
  });

  it("preserves review, pending, erasure, and replay statuses", async () => {
    executeMock
      .mockResolvedValueOnce(
        procedureResponse("pending_holds", "root_grant_entry_id", ROOT_ENTRY_ID)
      )
      .mockResolvedValueOnce(
        procedureResponse("manual_review", "root_grant_entry_id", ROOT_ENTRY_ID)
      )
      .mockResolvedValueOnce(
        procedureResponse("pending_provider", "wallet_id", WALLET_ID)
      )
      .mockResolvedValueOnce(
        procedureResponse("already_applied", "entry_id", ENTRY_ID)
      );

    await expect(applyCreditRefundDebit(adjustmentInput)).resolves.toEqual({
      result: "pending_holds",
      rootGrantEntryId: ROOT_ENTRY_ID,
    });
    await expect(applyCreditChargebackDebit(adjustmentInput)).resolves.toEqual({
      result: "manual_review",
      rootGrantEntryId: ROOT_ENTRY_ID,
    });
    await expect(eraseCreditWallet(erasureScope)).resolves.toEqual({
      result: "pending_provider",
      walletId: WALLET_ID,
    });
    await expect(
      applyCreditChargebackRestore(adjustmentInput)
    ).resolves.toEqual({ result: "already_applied", entryId: ENTRY_ID });
  });

  it("rejects invalid input before obtaining a database connection", async () => {
    const invalidCalls = [
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          workspaceId: 0,
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          mode: "sandbox" as "test",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          channelConnectionId: 0,
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          bindingEpoch: 0,
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          privacyEpoch: 0,
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          userKey: "raw-psid",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          walletId: "AAAAAAAA-1111-1111-1111-111111111111",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          financialSubjectRef: FINANCIAL_REF.toUpperCase(),
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          intentId: "invalid",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          authorizationEpoch: 0,
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          offerSnapshotCode: "wrong" as "premium_images_8_medium_v1",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          expectedAmount: "5.00" as "4.99",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          creditCount: 9 as 8,
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          description: "wrong" as "Leaderbot - 8 premium beeldcredits",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          metadataHash: "invalid",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          idempotencyKey: "wrong",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          checkoutScopeKey: "wrong",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          capabilityHash: "invalid",
        }),
      () =>
        reserveCreditCheckoutIntent({
          ...checkoutReservationInput,
          capabilityExpiresAt: new Date(Number.NaN),
        }),
      () =>
        consumeCreditCheckoutCapability({
          ...scope,
          intentId: "invalid",
          capabilityHash: CAPABILITY_HASH,
          sessionNonceHash: NONCE_HASH,
        }),
      () =>
        consumeCreditCheckoutCapability({
          ...scope,
          intentId: INTENT_ID,
          capabilityHash: "invalid",
          sessionNonceHash: NONCE_HASH,
        }),
      () =>
        consumeCreditCheckoutCapability({
          ...scope,
          intentId: INTENT_ID,
          capabilityHash: CAPABILITY_HASH,
          sessionNonceHash: "invalid",
        }),
      () =>
        grantCreditPurchase({
          ...scope,
          intentId: INTENT_ID,
          providerPaymentId: "tr invalid",
          entryId: ENTRY_ID,
          evidenceHash: EVIDENCE_HASH,
        }),
      () =>
        createCreditReservationHold({
          ...scope,
          reservationId: RESERVATION_ID,
          generationRequestKeyHash: REQUEST_HASH,
          ownerTokenHash: OWNER_HASH,
          reservedCreditCount: 0,
          entryId: ENTRY_ID,
          evidenceHash: EVIDENCE_HASH,
        }),
      () =>
        applyCreditRefundDebit({
          ...adjustmentInput,
          providerEffectId: "refund effect with spaces",
        }),
    ];

    for (const invoke of invalidCalls) {
      await expect(invoke()).rejects.toBeInstanceOf(CreditWalletStoreError);
    }
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["non-tuple response", []],
    [
      "direct row response",
      [[{ result: "applied", wallet_id: WALLET_ID }], []],
    ],
    [
      "duplicate result sets",
      [
        [
          [{ result: "applied", wallet_id: WALLET_ID }],
          [{ result: "applied", wallet_id: WALLET_ID }],
        ],
        [],
      ],
    ],
    [
      "duplicate rows",
      [
        [
          [
            { result: "applied", wallet_id: WALLET_ID },
            { result: "applied", wallet_id: WALLET_ID },
          ],
          {},
        ],
        [],
      ],
    ],
    ["unknown status", procedureResponse("unexpected", "wallet_id", WALLET_ID)],
    ["wrong identifier", procedureResponse("applied", "wallet_id", INTENT_ID)],
    [
      "extra result column",
      [[[{ result: "applied", wallet_id: WALLET_ID, balance: 99 }], {}], []],
    ],
  ])("fails closed on a %s", async (_label, response) => {
    executeMock.mockResolvedValueOnce(response);
    await expect(
      reserveCreditCheckoutIntent(checkoutReservationInput)
    ).rejects.toBeInstanceOf(CreditWalletStoreError);
  });

  it.each([
    ["unknown status", checkoutReservationResponse("unexpected")],
    [
      "wrong intent",
      [
        [
          [
            {
              result: "applied",
              intent_id: RESERVATION_ID,
              wallet_id: WALLET_ID,
            },
          ],
          {},
        ],
        [],
      ],
    ],
    [
      "wrong wallet",
      [
        [
          [
            {
              result: "applied",
              intent_id: INTENT_ID,
              wallet_id: RESERVATION_ID,
            },
          ],
          {},
        ],
        [],
      ],
    ],
    [
      "extra column",
      [
        [
          [
            {
              result: "applied",
              intent_id: INTENT_ID,
              wallet_id: WALLET_ID,
              balance: 0,
            },
          ],
          {},
        ],
        [],
      ],
    ],
  ])("fails closed on a checkout reservation %s", async (_label, response) => {
    executeMock.mockResolvedValueOnce(response);
    await expect(
      reserveCreditCheckoutIntent(checkoutReservationInput)
    ).rejects.toBeInstanceOf(CreditWalletStoreError);
  });
});
