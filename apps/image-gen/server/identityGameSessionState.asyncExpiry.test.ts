import { beforeEach, describe, expect, it, vi } from "vitest";

const readScopedStateMock = vi.fn();

vi.mock("./_core/stateStore", () => ({
  deleteScopedState: vi.fn(),
  isPromiseLike: (value: unknown) =>
    Boolean(value) && typeof (value as Promise<unknown>).then === "function",
  readScopedState: readScopedStateMock,
  writeScopedState: vi.fn(),
}));

describe("identityGameSessionState async expiry", () => {
  beforeEach(() => {
    vi.resetModules();
    readScopedStateMock.mockReset();
  });

  it("returns null for an expired session in the async sessionId read path", async () => {
    readScopedStateMock.mockResolvedValue({
      sessionId: "expired-async-session",
      userId: "expired-async-user",
      gameId: "party-alter-ego",
      gameVersion: "v1",
      entryIntent: {
        sourceChannel: "messenger",
        sourceType: "referral",
        targetExperienceType: "identity_game",
        targetExperienceId: "party-alter-ego",
        receivedAt: 1710000000000,
      },
      status: "started",
      answers: [],
      derivedTraits: {},
      startedAt: 1710000000000,
      updatedAt: 1710000000000,
      expiresAt: Date.now() - 1000,
    });

    const { getIdentityGameSessionBySessionId } = await import(
      "./_core/identityGameSessionState"
    );

    await expect(
      Promise.resolve(getIdentityGameSessionBySessionId("expired-async-session"))
    ).resolves.toBeNull();
  });
});
