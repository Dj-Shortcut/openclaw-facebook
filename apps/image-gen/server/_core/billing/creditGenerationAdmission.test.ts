import { describe, expect, it, vi } from "vitest";

import type { CreditCheckoutPilotConfig } from "./creditCheckoutConfig";
import {
  PaidCreditGenerationAdmissionError,
  reservePaidCreditGeneration,
  type CreditGenerationAdmissionDependencies,
  type PaidCreditGenerationInput,
} from "./creditGenerationAdmission";

const USER_KEY = "a".repeat(64);
const CONFIG: CreditCheckoutPilotConfig = Object.freeze({
  checkoutEnabled: true,
  paidCreditsEnabled: true,
  workspaceId: 42,
  mode: "test",
});
const INPUT: PaidCreditGenerationInput = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 12,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: USER_KEY,
  requestId: "generation-request-1",
});

function dependencies(
  overrides: Partial<CreditGenerationAdmissionDependencies> = {}
): CreditGenerationAdmissionDependencies {
  return {
    enabled: () => true,
    config: () => CONFIG,
    withSecret: callback => callback(Buffer.from("s".repeat(32), "ascii")),
    readWallet: vi.fn(async () => ({ creditBalance: 8, reservedCredits: 0 })),
    readReservation: vi.fn(async () => null),
    reserve: vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    })),
    markTransportStarted: vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    })),
    markProviderAccepted: vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    })),
    commit: vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    })),
    release: vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    })),
    ...overrides,
  };
}

describe("paid credit generation admission", () => {
  it("does nothing while paid credits are disabled", async () => {
    const readWallet = vi.fn();
    const deps = dependencies({ enabled: () => false, readWallet });

    await expect(reservePaidCreditGeneration(INPUT, deps)).resolves.toEqual({
      available: false,
      reason: "disabled",
    });
    expect(readWallet).not.toHaveBeenCalled();
  });

  it("rejects a workspace outside the explicit pilot without reading a wallet", async () => {
    const readWallet = vi.fn();
    const deps = dependencies({
      config: () => ({ ...CONFIG, workspaceId: 41 }),
      readWallet,
    });

    await expect(reservePaidCreditGeneration(INPUT, deps)).resolves.toEqual({
      available: false,
      reason: "outside_pilot",
    });
    expect(readWallet).not.toHaveBeenCalled();
  });

  it.each([
    ["missing wallet", null],
    ["zero balance", { creditBalance: 0, reservedCredits: 0 }],
    ["fully reserved", { creditBalance: 8, reservedCredits: 8 }],
  ])("returns an empty decision for %s", async (_label, wallet) => {
    const reserve = vi.fn();
    const deps = dependencies({
      readWallet: vi.fn(async () => wallet),
      reserve,
    });

    await expect(reservePaidCreditGeneration(INPUT, deps)).resolves.toEqual({
      available: false,
      reason: "empty",
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("holds one exact user-scoped credit with deterministic opaque evidence", async () => {
    const readWallet = vi.fn(async () => ({
      creditBalance: 8,
      reservedCredits: 1,
    }));
    const reserve = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const deps = dependencies({ readWallet, reserve });

    const first = await reservePaidCreditGeneration(INPUT, deps);
    const replay = await reservePaidCreditGeneration(INPUT, deps);
    expect(first.available).toBe(true);
    expect(replay.available).toBe(true);
    if (!first.available || !replay.available) throw new Error("unreachable");

    expect(first.reservation.reservationId).toBe(
      replay.reservation.reservationId
    );
    expect(first.reservation.reservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(readWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        mode: "test",
        channelConnectionId: 12,
        bindingEpoch: 3,
        privacyEpoch: 5,
        userKey: USER_KEY,
        walletId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        financialSubjectRef: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        reservedCreditCount: 1,
        generationRequestKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        ownerTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        entryId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
    expect(first.reservation.toJSON()).toEqual({
      reservationId: first.reservation.reservationId,
      imageQuality: "medium",
    });
    expect(JSON.stringify(first.reservation)).not.toContain(USER_KEY);
  });

  it("commits a known provider success exactly once and never releases it", async () => {
    const markTransportStarted = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const markProviderAccepted = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const commit = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const release = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const decision = await reservePaidCreditGeneration(
      INPUT,
      dependencies({
        markTransportStarted,
        markProviderAccepted,
        commit,
        release,
      })
    );
    if (!decision.available) throw new Error("unreachable");

    await decision.reservation.markTransportStarted();
    await decision.reservation.markTransportStarted();
    await decision.reservation.commitProviderSuccess();
    await decision.reservation.commitProviderSuccess();
    await decision.reservation.releaseBeforeTransport();

    expect(markTransportStarted).toHaveBeenCalledOnce();
    expect(markProviderAccepted).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: decision.reservation.reservationId,
        ownerTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        entryId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("retains accepted evidence when the debit commit fails and retries only the debit", async () => {
    const markTransportStarted = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const markProviderAccepted = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("database interrupted after acceptance"))
      .mockImplementationOnce(async input => ({
        result: "applied" as const,
        reservationId: input.reservationId,
      }));
    const release = vi.fn();
    const decision = await reservePaidCreditGeneration(
      INPUT,
      dependencies({
        markTransportStarted,
        markProviderAccepted,
        commit,
        release,
      })
    );
    if (!decision.available) throw new Error("unreachable");

    await decision.reservation.markTransportStarted();
    await expect(
      decision.reservation.commitProviderSuccess()
    ).rejects.toThrow("database interrupted after acceptance");
    await decision.reservation.releaseBeforeTransport();
    await decision.reservation.commitProviderSuccess();

    expect(markTransportStarted).toHaveBeenCalledOnce();
    expect(markProviderAccepted).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
  });

  it("releases a pre-transport hold exactly once and refuses a later commit", async () => {
    const commit = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const release = vi.fn(async input => ({
      result: "applied" as const,
      reservationId: input.reservationId,
    }));
    const decision = await reservePaidCreditGeneration(
      INPUT,
      dependencies({ commit, release })
    );
    if (!decision.available) throw new Error("unreachable");

    await decision.reservation.releaseBeforeTransport();
    await decision.reservation.releaseBeforeTransport();
    await expect(
      decision.reservation.commitProviderSuccess()
    ).rejects.toBeInstanceOf(PaidCreditGenerationAdmissionError);

    expect(release).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("uses a different exact reservation for a different generation request", async () => {
    const deps = dependencies();
    const first = await reservePaidCreditGeneration(INPUT, deps);
    const second = await reservePaidCreditGeneration(
      { ...INPUT, requestId: "generation-request-2" },
      deps
    );
    if (!first.available || !second.available) throw new Error("unreachable");

    expect(second.reservation.reservationId).not.toBe(
      first.reservation.reservationId
    );
  });

  it.each(["initializing", "reserved"] as const)(
    "keeps an existing %s request provider-silent",
    async status => {
      const reserve = vi.fn();
      await expect(
        reservePaidCreditGeneration(
          INPUT,
          dependencies({
            readWallet: vi.fn(async () => ({
              creditBalance: 1,
              reservedCredits: 1,
            })),
            readReservation: vi.fn(async () => ({ status })),
            reserve,
          })
        )
      ).resolves.toEqual({
        available: false,
        reason: "request_in_progress",
      });
      expect(reserve).not.toHaveBeenCalled();
    }
  );

  it("does not admit the loser of a concurrent deterministic hold", async () => {
    const reserve = vi.fn(async input => ({
      result: "already_applied" as const,
      reservationId: input.reservationId,
    }));

    await expect(
      reservePaidCreditGeneration(INPUT, dependencies({ reserve }))
    ).resolves.toEqual({
      available: false,
      reason: "request_in_progress",
    });
    expect(reserve).toHaveBeenCalledOnce();
  });

  it.each(["committed", "released", "expired"] as const)(
    "never reopens a %s reservation for another provider call",
    async status => {
      const reserve = vi.fn();
      await expect(
        reservePaidCreditGeneration(
          INPUT,
          dependencies({
            readWallet: vi.fn(async () => ({
              creditBalance: status === "committed" ? 0 : 1,
              reservedCredits: 0,
            })),
            readReservation: vi.fn(async () => ({ status })),
            reserve,
          })
        )
      ).resolves.toEqual({
        available: false,
        reason: "request_closed",
      });
      expect(reserve).not.toHaveBeenCalled();
    }
  );

  it("rejects a raw Messenger identifier before touching dependencies", async () => {
    const readWallet = vi.fn();
    const deps = dependencies({ readWallet });

    await expect(
      reservePaidCreditGeneration(
        { ...INPUT, userKey: "1234567890123456" },
        deps
      )
    ).rejects.toBeInstanceOf(PaidCreditGenerationAdmissionError);
    expect(readWallet).not.toHaveBeenCalled();
  });
});
