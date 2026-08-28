import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

import {
  CreditReservationOperatorResolutionError,
  listOpenCreditReservationTransportReviews,
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
const OUTPUT_NOT_DELIVERED_ENTRY_ID = "55555555-5555-8555-8555-555555555555";
const REVIEW_CASE_REF = "66666666-6666-4666-8666-666666666666";

type AuditRow = {
  event: string;
  userId: number;
  metadata: Record<string, unknown>;
};

type ReservationState = {
  status: "reserved" | "committed" | "released";
  transportState:
    | "transport_started"
    | "known_accepted"
    | "known_rejected"
    | "output_not_delivered";
  providerRejectedStatus: number | null;
};

function operatorInput(
  overrides: Partial<CreditReservationOperatorResolutionInput> = {}
): CreditReservationOperatorResolutionInput {
  return {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: 42,
    mode: "test",
    reservationId: RESERVATION_ID,
    walletId: WALLET_ID,
    actorUserId: 91,
    decision: "delivered_output",
    providerStatus: 200,
    evidenceReference: "messenger-delivery:incident-200",
    ...overrides,
  };
}

function rewriteRequestedAuditAsLegacyV1(
  audit: AuditRow,
  input: CreditReservationOperatorResolutionInput
): void {
  const decision =
    input.decision === "delivered_output"
      ? "provider_accepted"
      : input.decision === "provider_rejected"
        ? "provider_rejected"
        : null;
  const evidenceReferenceHash = audit.metadata.evidenceReferenceHash;
  if (!decision || typeof evidenceReferenceHash !== "string") {
    throw new Error("test input is not representable as a legacy-v1 audit");
  }
  audit.metadata.requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        reservationId: input.reservationId,
        walletId: input.walletId,
        actorUserId: input.actorUserId,
        decision,
        providerStatus: input.providerStatus,
        evidenceReferenceHash,
      })
    )
    .digest("hex");
  audit.metadata.decision = decision;
  delete audit.metadata.mode;
}

function reviewListingHarness(
  payload: Record<string, unknown> = {
    reason: "credit_reservation_transport_ambiguous",
    reservationId: RESERVATION_ID,
    walletId: WALLET_ID,
    creditPurpose: "premium_image_credits",
  }
) {
  let whereCondition: unknown;
  const rows = [
    {
      caseRef: REVIEW_CASE_REF,
      mode: "test" as const,
      deduplicationKey: `credit_reservation_transport_review:${RESERVATION_ID}`,
      payload,
    },
  ];
  const database = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          whereCondition = condition;
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => rows),
            })),
          };
        }),
      })),
    })),
  };
  return {
    provider: vi.fn(async () => database as never),
    whereCondition: () => whereCondition,
  };
}

function harness(
  options: {
    failCompletionOnce?: boolean;
    reviewExists?: boolean;
    reservationState?: ReservationState;
  } = {}
) {
  const audits: AuditRow[] = [];
  const inserted: Record<string, unknown>[] = [];
  let completionFailurePending = options.failCompletionOnce === true;
  let transactionCount = 0;
  let walletErased = false;
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
  const releaseOutputNotDelivered = vi.fn(async () => {
    reservation.status = "released";
    reservation.transportState = "output_not_delivered";
    return { result: "applied" as const, reservationId: RESERVATION_ID };
  });

  const database = {
    transaction: vi.fn(
      async (callback: (tx: ReturnType<typeof transaction>) => unknown) => {
        transactionCount += 1;
        if (completionFailurePending && transactionCount === 2) {
          completionFailurePending = false;
          throw new Error("simulated crash before completion audit");
        }
        return callback(transaction());
      }
    ),
  };

  function transaction() {
    let selectIndex = 0;
    const rowsForSelect = () => {
      const index = selectIndex++;
      if (index === 0) return [{ id: 91 }];
      if (index === 1) return audits.map(row => ({ ...row }));
      const recoveringTerminal =
        audits.some(row =>
          row.event.endsWith("operator_resolution_requested")
        ) && reservation.status !== "reserved";
      if (index === 2) {
        if (recoveringTerminal) {
          return [
            {
              channelConnectionId: 7,
              bindingEpoch: 3,
              privacyEpoch: 4,
              financialSubjectRef: FINANCIAL_SUBJECT,
              reservedCreditCount: 1,
              terminalLedgerEntryId:
                reservation.status === "committed"
                  ? COMMIT_ENTRY_ID
                  : reservation.transportState === "output_not_delivered"
                    ? OUTPUT_NOT_DELIVERED_ENTRY_ID
                    : REJECTED_ENTRY_ID,
              terminalEvidenceHash:
                reservation.status === "committed"
                  ? "e".repeat(64)
                  : reservation.transportState === "output_not_delivered"
                    ? "1".repeat(64)
                    : "f".repeat(64),
              ...reservation,
            },
          ];
        }
        return [
          {
            channelConnectionId: 7,
            bindingEpoch: 3,
            privacyEpoch: 4,
            financialSubjectRef: FINANCIAL_SUBJECT,
            generationRequestKeyHash: GENERATION_HASH,
            ownerTokenHash: OWNER_TOKEN_HASH,
            userKey: walletErased ? null : USER_KEY,
          },
        ];
      }
      if (index === 3) {
        if (recoveringTerminal) {
          return [
            {
              entryId:
                reservation.status === "committed"
                  ? COMMIT_ENTRY_ID
                  : reservation.transportState === "output_not_delivered"
                    ? OUTPUT_NOT_DELIVERED_ENTRY_ID
                    : REJECTED_ENTRY_ID,
              entryKind:
                reservation.status === "committed"
                  ? "generation_spend"
                  : "reservation_release",
              terminalStatus:
                reservation.status === "committed" ? "committed" : "released",
              evidenceHash:
                reservation.status === "committed"
                  ? "e".repeat(64)
                  : reservation.transportState === "output_not_delivered"
                    ? "1".repeat(64)
                    : "f".repeat(64),
            },
          ];
        }
        return [{ workspaceId: 42 }];
      }
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
    database: vi.fn(async () => database as never),
    markProviderAccepted,
    commit,
    releaseProviderRejected:
      releaseProviderRejected as CreditReservationOperatorResolutionDependencies["releaseProviderRejected"],
    releaseOutputNotDelivered,
    deriveCommit: vi.fn(() => ({
      entryId: COMMIT_ENTRY_ID,
      evidenceHash: "e".repeat(64),
    })),
    deriveProviderRejected: vi.fn(() => ({
      entryId: REJECTED_ENTRY_ID,
      evidenceHash: "f".repeat(64),
    })),
    deriveOutputNotDelivered: vi.fn(() => ({
      entryId: OUTPUT_NOT_DELIVERED_ENTRY_ID,
      evidenceHash: "1".repeat(64),
    })),
  };
  return {
    audits,
    commit,
    dependencies,
    eraseWallet: () => {
      walletErased = true;
    },
    inserted,
    markProviderAccepted,
    releaseProviderRejected,
    releaseOutputNotDelivered,
  };
}

describe("ambiguous paid-credit operator resolution", () => {
  beforeEach(() => {
    vi.stubEnv("BILLING_PROFILE_EVIDENCE_HMAC_SECRET", "s".repeat(32));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists one enqueued opaque review case and resolves its exact scope", async () => {
    const listing = reviewListingHarness();
    const reviews = await listOpenCreditReservationTransportReviews(
      { workspaceId: 42, mode: "test", limit: 10 },
      listing.provider
    );

    expect(reviews).toEqual([
      {
        caseRef: REVIEW_CASE_REF,
        mode: "test",
        reservationId: RESERVATION_ID,
        walletId: WALLET_ID,
        reason: "credit_reservation_transport_ambiguous",
      },
    ]);
    expect(JSON.stringify(reviews)).not.toContain(USER_KEY);
    expect(JSON.stringify(reviews)).not.toContain(FINANCIAL_SUBJECT);

    const query = new MySqlDialect().sqlToQuery(
      listing.whereCondition() as never
    );
    expect(query.sql).toContain("`billing_outbox`.`workspace_id` = ?");
    expect(query.sql).toContain("`billing_outbox`.`mode` = ?");
    expect(query.sql).toContain("NOT EXISTS");
    expect(query.params).toEqual(
      expect.arrayContaining([
        42,
        "test",
        "manual_review",
        "credit_reservation_transport_ambiguous",
        "credit_reservation.operator_resolution_completed",
      ])
    );

    const resolution = harness();
    await expect(
      resolveAmbiguousPaidCreditReservation(
        operatorInput({
          mode: reviews[0]!.mode,
          reservationId: reviews[0]!.reservationId,
          walletId: reviews[0]!.walletId,
          decision: "output_not_delivered",
          providerStatus: undefined,
          evidenceReference: `review-case:${reviews[0]!.caseRef}`,
        }),
        resolution.dependencies
      )
    ).resolves.toMatchObject({ result: "applied" });
    expect(resolution.releaseOutputNotDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: RESERVATION_ID,
        walletId: WALLET_ID,
        mode: "test",
      })
    );
  });

  it("commits only reviewed delivered output with an explicit provider 2xx", async () => {
    const test = harness();
    const input = operatorInput();

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toEqual({
      result: "applied",
      reservationId: RESERVATION_ID,
      decision: "delivered_output",
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
          decision: "delivered_output",
          providerStatus: 200,
        }),
        opposite.dependencies
      )
    ).rejects.toMatchObject({
      code: "credit_reservation_operator_scope_conflict",
    });
    expect(opposite.markProviderAccepted).not.toHaveBeenCalled();
  });

  it.each(["transport_started", "known_accepted"] as const)(
    "releases %s output only with an explicit non-delivery decision",
    async transportState => {
      const test = harness({
        reservationState: {
          status: "reserved",
          transportState,
          providerRejectedStatus: null,
        },
      });
      const input = operatorInput({
        decision: "output_not_delivered",
        evidenceReference: "messenger-nondelivery:incident-200",
      });

      await expect(
        resolveAmbiguousPaidCreditReservation(input, test.dependencies)
      ).resolves.toEqual({
        result: "applied",
        reservationId: RESERVATION_ID,
        decision: "output_not_delivered",
      });

      expect(test.releaseOutputNotDelivered).toHaveBeenCalledWith(
        expect.objectContaining({
          reservationId: RESERVATION_ID,
          entryId: OUTPUT_NOT_DELIVERED_ENTRY_ID,
          evidenceHash: "1".repeat(64),
        })
      );
      expect(test.markProviderAccepted).not.toHaveBeenCalled();
      expect(test.commit).not.toHaveBeenCalled();
      expect(test.releaseProviderRejected).not.toHaveBeenCalled();

      await expect(
        resolveAmbiguousPaidCreditReservation(input, test.dependencies)
      ).resolves.toMatchObject({ result: "already_applied" });
      expect(test.releaseOutputNotDelivered).toHaveBeenCalledOnce();
    }
  );

  it("records an absent provider status for a proven output non-delivery", async () => {
    const test = harness();
    const input = operatorInput({
      decision: "output_not_delivered",
      providerStatus: undefined,
      evidenceReference: "messenger-nondelivery:network-ambiguous",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toMatchObject({
      result: "applied",
      decision: "output_not_delivered",
    });

    expect(test.releaseOutputNotDelivered).toHaveBeenCalledOnce();
    expect(test.inserted).toHaveLength(2);
    for (const audit of test.inserted) {
      expect(audit.metadata).toEqual(
        expect.objectContaining({ providerStatus: null })
      );
    }
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

  it("completes an identical request after terminal mutation and wallet erasure", async () => {
    const test = harness({ failCompletionOnce: true });
    const input = operatorInput({
      decision: "output_not_delivered",
      providerStatus: undefined,
      evidenceReference: "messenger-nondelivery:crash-after-release",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).rejects.toThrow("simulated crash before completion audit");
    expect(test.releaseOutputNotDelivered).toHaveBeenCalledOnce();
    expect(test.audits.map(row => row.event)).toEqual([
      "credit_reservation.operator_resolution_requested",
    ]);

    test.eraseWallet();

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toEqual({
      result: "already_applied",
      reservationId: RESERVATION_ID,
      decision: "output_not_delivered",
    });
    expect(test.releaseOutputNotDelivered).toHaveBeenCalledOnce();
    expect(test.audits.map(row => row.event)).toEqual([
      "credit_reservation.operator_resolution_requested",
      "credit_reservation.operator_resolution_completed",
    ]);
    expect(test.audits[1]?.metadata).toEqual(
      expect.objectContaining({
        mode: "test",
        result: "already_applied",
        terminalEntryId: OUTPUT_NOT_DELIVERED_ENTRY_ID,
      })
    );
    expect(JSON.stringify(test.audits)).not.toContain(USER_KEY);
  });

  it("normalizes an exact legacy-v1 provider_accepted request after terminal mutation", async () => {
    const test = harness({ failCompletionOnce: true });
    const input = operatorInput({
      evidenceReference: "messenger-delivery:legacy-crash-recovery",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).rejects.toThrow("simulated crash before completion audit");
    expect(test.audits).toHaveLength(1);
    rewriteRequestedAuditAsLegacyV1(test.audits[0]!, input);
    test.eraseWallet();

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toEqual({
      result: "already_applied",
      reservationId: RESERVATION_ID,
      decision: "delivered_output",
    });
    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).resolves.toMatchObject({ result: "already_applied" });

    expect(test.markProviderAccepted).toHaveBeenCalledOnce();
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.audits).toHaveLength(2);
    expect(test.audits[0]?.metadata).toEqual(
      expect.objectContaining({
        decision: "provider_accepted",
        providerStatus: 200,
      })
    );
    expect(test.audits[0]?.metadata).not.toHaveProperty("mode");
    expect(test.audits[1]?.metadata).toEqual(
      expect.objectContaining({
        decision: "delivered_output",
        mode: "test",
        result: "already_applied",
        terminalEntryId: COMMIT_ENTRY_ID,
      })
    );
  });

  it("rejects a legacy-v1 request when its exact evidence no longer matches", async () => {
    const test = harness({ failCompletionOnce: true });
    const input = operatorInput({
      evidenceReference: "messenger-delivery:legacy-original-evidence",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).rejects.toThrow("simulated crash before completion audit");
    rewriteRequestedAuditAsLegacyV1(test.audits[0]!, input);

    await expect(
      resolveAmbiguousPaidCreditReservation(
        {
          ...input,
          evidenceReference: "messenger-delivery:legacy-wrong-evidence",
        },
        test.dependencies
      )
    ).rejects.toMatchObject({
      code: "credit_reservation_operator_request_conflict",
    });
    expect(test.markProviderAccepted).toHaveBeenCalledOnce();
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.audits).toHaveLength(1);
  });

  it("rejects a legacy fingerprint carrying a mode it never authenticated", async () => {
    const test = harness({ failCompletionOnce: true });
    const input = operatorInput({
      evidenceReference: "messenger-delivery:legacy-mode-mismatch",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).rejects.toThrow("simulated crash before completion audit");
    rewriteRequestedAuditAsLegacyV1(test.audits[0]!, input);
    test.audits[0]!.metadata.mode = "live";

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).rejects.toMatchObject({
      code: "credit_reservation_operator_request_conflict",
    });
    expect(test.markProviderAccepted).toHaveBeenCalledOnce();
    expect(test.commit).toHaveBeenCalledOnce();
    expect(test.audits).toHaveLength(1);
  });

  it("rejects conflicting evidence after terminal mutation without repeating it", async () => {
    const test = harness({ failCompletionOnce: true });
    const input = operatorInput({
      decision: "output_not_delivered",
      providerStatus: undefined,
      evidenceReference: "messenger-nondelivery:original-evidence",
    });

    await expect(
      resolveAmbiguousPaidCreditReservation(input, test.dependencies)
    ).rejects.toThrow("simulated crash before completion audit");

    await expect(
      resolveAmbiguousPaidCreditReservation(
        {
          ...input,
          evidenceReference: "messenger-nondelivery:conflicting-evidence",
        },
        test.dependencies
      )
    ).rejects.toMatchObject({
      code: "credit_reservation_operator_request_conflict",
    });
    expect(test.releaseOutputNotDelivered).toHaveBeenCalledOnce();
    expect(test.audits).toHaveLength(1);
  });
});
