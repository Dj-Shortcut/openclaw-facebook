import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CreditReservationOperatorResolutionError,
  resolveAmbiguousPaidCreditReservation,
  type CreditReservationOperatorResolutionDependencies,
  type CreditReservationOperatorResolutionInput,
} from "./creditReservationOperatorResolution";

const USER_KEY = `u2.k1.${"a".repeat(64)}`;
const FINANCIAL_SUBJECT = "b".repeat(64);
const GENERATION_HASH = "c".repeat(64);
const OWNER_TOKEN_HASH = "d".repeat(64);
const RESERVATION_ID = "11111111-1111-8111-8111-111111111111";
const WALLET_ID = "22222222-2222-8222-8222-222222222222";
const COMMIT_ENTRY_ID = "33333333-3333-8333-8333-333333333333";
const REJECTED_ENTRY_ID = "44444444-4444-8444-8444-444444444444";

type AuditRow = {
  event: string;
  userId: number;
  metadata: Record<string, unknown>;
};

type ReservationState = {
  status: "reserved" | "committed" | "released";
  transportState: "transport_started" | "known_accepted" | "known_rejected";
  providerRejectedStatus: number | null;
};

function operatorInput(
  overrides: Partial<CreditReservationOperatorResolutionInput> = {}
): CreditReservationOperatorResolutionInput {
  return {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: 42,
    reservationId: RESERVATION_ID,
    walletId: WALLET_ID,
    actorUserId: 91,
    decision: "provider_accepted",
    providerStatus: 200,
    evidenceReference: "openai-response:incident-200",
    ...overrides,
  };
}

function harness(
  options: {
    reviewExists?: boolean;
    reservationState?: ReservationState;
  } = {}
) {
  const audits: AuditRow[] = [];
  const inserted: Record<string, unknown>[] = [];
  const reservation: ReservationState = options.reservationState ?? {
    status: "reserved",
    transportState: "transport_started",
    providerRejectedStatus: null,
  };
  const markProviderAccepted = vi.fn(async () => {
    reservation.transportState = "known_accepted";
    return { result: "applied" as const, reservationId: RESERVATION_ID };
  });
  const commit = vi.fn(async () => {
    reservation.status = "committed";
    reservation.transportState = "known_accepted";
    return { result: "applied" as const, reservationId: RESERVATION_ID };
  });
  const releaseProviderRejected = vi.fn(
    async (input: { rejectionStatus: number }) => {
      reservation.status = "released";
      reservation.transportState = "known_rejected";
      reservation.providerRejectedStatus = input.rejectionStatus;
      return { result: "applied" as const, reservationId: RESERVATION_ID };
    }
  );

  const database = {
    transaction: vi.fn(
      async (callback: (tx: ReturnType<typeof transaction>) => unknown) =>
        callback(transaction())
    ),
  };

  function transaction() {
    let selectIndex = 0;
    const rowsForSelect = () => {
      const index = selectIndex++;
      if (index === 0) return [{ id: 91 }];
      if (index === 1) return audits.map(row => ({ ...row }));
      if (index === 2) {
        return [
          {
            channelConnectionId: 7,
            bindingEpoch: 3,
            privacyEpoch: 4,
            financialSubjectRef: FINANCIAL_SUBJECT,
            generationRequestKeyHash: GENERATION_HASH,
            ownerTokenHash: OWNER_TOKEN_HASH,
            userKey: USER_KEY,
          },
        ];
      }
      if (index === 3) return [{ workspaceId: 42 }];
      if (index === 4) return [{ id: 7 }];
      if (index === 5) return [{ id: 17 }];
      if (index === 6) return [{ walletId: WALLET_ID }];
      if (index === 7) {
        return [
          {
            ...reservation,
            generationRequestKeyHash: GENERATION_HASH,
            ownerTokenHash: OWNER_TOKEN_HASH,
          },
        ];
      }
      if (index === 8) {
        return options.reviewExists === false
          ? []
          : [
              {
                payload: {
                  reason: "credit_reservation_transport_ambiguous",
                  reservationId: RESERVATION_ID,
                  walletId: WALLET_ID,
                  creditPurpose: "premium_image_credits",
                },
              },
            ];
      }
      if (index === 9) return audits.map(row => ({ ...row }));
      throw new Error(`unexpected select ${index}`);
    };
    return {
      select: vi.fn(() => {
        const rows = rowsForSelect();
        const bounded = {
          for: vi.fn(async () => rows),
          then: (
            resolve: (value: unknown[]) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(rows).then(resolve, reject),
        };
        const where = vi.fn(() => ({ limit: vi.fn(() => bounded) }));
        const fromResult = {
          where,
          innerJoin: vi.fn(() => ({ where })),
        };
        return { from: vi.fn(() => fromResult) };
      }),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Record<string, unknown>) => {
          inserted.push(value);
          if (
            typeof value.event === "string" &&
            typeof value.userId === "number" &&
            value.metadata &&
            typeof value.metadata === "object" &&
            !Array.isArray(value.metadata)
          ) {
            audits.push({
              event: value.event,
              userId: value.userId,
              metadata: value.metadata as Record<string, unknown>,
            });
          }
        }),
      })),
    };
  }

  const dependencies: CreditReservationOperatorResolutionDependencies = {
    mode: () => "test",
    database: vi.fn(async () => database as never),
    markProviderAccepted,
    commit,
    releaseProviderRejected:
      releaseProviderRejected as CreditReservationOperatorResolutionDependencies["releaseProviderRejected"],
    deriveCommit: vi.fn(() => ({
      entryId: COMMIT_ENTRY_ID,
      evidenceHash: "e".repeat(64),
    })),
    deriveProviderRejected: vi.fn(() => ({
      entryId: REJECTED_ENTRY_ID,
      evidenceHash: "f".repeat(64),
    })),
  };
  return {
    audits,
    commit,
    dependencies,
    inserted,
    markProviderAccepted,
    releaseProviderRejected,
  };
}

describe("ambiguous paid-credit operator resolution", () => {
  beforeEach(() => {
    vi.stubEnv("BILLING_PROFILE_EVIDENCE_HMAC_SECRET", "s".repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("commits only a reviewed explicit 2xx and audits no hidden scope", async () => {
    const test = harness();
    const input = operatorInput();

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toEqual({
      result: "applied",
      reservationId: RESERVATION_ID,
      decision: "provider_accepted",
    });

    expect(test.markProviderAccepted).toHaveBeenCalledWith({
      workspaceId: 42,
      mode: "test",
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 4,
      userKey: USER_KEY,
      walletId: WALLET_ID,
      financialSubjectRef: FINANCIAL_SUBJECT,
      reservationId: RESERVATION_ID,
      generationRequestKeyHash: GENERATION_HASH,
      ownerTokenHash: OWNER_TOKEN_HASH,
    });
    expect(test.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: RESERVATION_ID,
        entryId: COMMIT_ENTRY_ID,
        evidenceHash: "e".repeat(64),
      })
    );
    expect(test.audits.map(row => row.event)).toEqual([
      "credit_reservation.operator_resolution_requested",
      "credit_reservation.operator_resolution_completed",
    ]);
    const serializedAudit = JSON.stringify(test.inserted);
    expect(serializedAudit).not.toContain(input.evidenceReference);
    expect(serializedAudit).not.toContain(USER_KEY);
    expect(serializedAudit).not.toContain(FINANCIAL_SUBJECT);
    expect(serializedAudit).not.toContain(GENERATION_HASH);
    expect(serializedAudit).not.toContain(OWNER_TOKEN_HASH);
    expect(serializedAudit).toContain("hmac-sha256:");

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toMatchObject({ result: "already_applied" });
    expect(test.markProviderAccepted).toHaveBeenCalledOnce();
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.audits).toHaveLength(2);
  });

  it("releases only an exact non-retryable 4xx and rejects the opposite result", async () => {
    const test = harness();
    const rejected = operatorInput({
      decision: "provider_rejected",
      providerStatus: 400,
      evidenceReference: "openai-response:incident-400",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(rejected, test.dependencies)
    ).resolves.toMatchObject({ result: "applied" });
    expect(test.releaseProviderRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        rejectionStatus: 400,
        entryId: REJECTED_ENTRY_ID,
        evidenceHash: "f".repeat(64),
      })
    );
    expect(test.markProviderAccepted).not.toHaveBeenCalled();
    expect(test.commit).not.toHaveBeenCalled();

    const opposite = harness({
      reservationState: {
        status: "released",
        transportState: "known_rejected",
        providerRejectedStatus: 400,
      },
    });
    await expect(
      resolveAmbiguousPaidCreditReservation(
        operatorInput({
          requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          decision: "provider_accepted",
          providerStatus: 200,
        }),
        opposite.dependencies
      )
    ).rejects.toMatchObject({
      code: "credit_reservation_operator_scope_conflict",
    });
    expect(opposite.markProviderAccepted).not.toHaveBeenCalled();
  });

  it.each([408, 429])(
    "keeps provider status %s held before database access",
    async providerStatus => {
      const test = harness();
      await expect(
        resolveAmbiguousPaidCreditReservation(
          operatorInput({
            decision: "provider_rejected",
            providerStatus,
          }),
          test.dependencies
        )
      ).rejects.toBeInstanceOf(CreditReservationOperatorResolutionError);
      expect(test.dependencies.database).not.toHaveBeenCalled();
      expect(test.releaseProviderRejected).not.toHaveBeenCalled();
    }
  );

  it("requires the exact durable manual-review item before changing the hold", async () => {
    const test = harness({ reviewExists: false });
    await expect(
      resolveAmbiguousPaidCreditReservation(operatorInput(), test.dependencies)
    ).rejects.toMatchObject({
      code: "credit_reservation_operator_review_required",
    });
    expect(test.markProviderAccepted).not.toHaveBeenCalled();
    expect(test.commit).not.toHaveBeenCalled();
    expect(test.audits).toHaveLength(0);
  });
});
