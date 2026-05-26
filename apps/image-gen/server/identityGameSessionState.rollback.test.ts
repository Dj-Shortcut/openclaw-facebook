import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteScopedStateMock = vi.fn();
const readScopedStateMock = vi.fn();
const writeScopedStateMock = vi.fn();

vi.mock("./_core/stateStore", () => ({
  deleteScopedState: deleteScopedStateMock,
  isPromiseLike: (value: unknown) =>
    Boolean(value) && typeof (value as Promise<unknown>).then === "function",
  readScopedState: readScopedStateMock,
  writeScopedState: writeScopedStateMock,
}));

describe("identityGameSessionState rollback", () => {
  beforeEach(() => {
    deleteScopedStateMock.mockReset();
    readScopedStateMock.mockReset();
    writeScopedStateMock.mockReset();
  });

  it("rolls back the session write when the user reference write fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    writeScopedStateMock
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("ref write failed");
      });
    deleteScopedStateMock.mockReturnValue(Promise.resolve());

    try {
      const { upsertIdentityGameSession } = await import(
        "./_core/identityGameSessionState"
      );

      await expect(
        upsertIdentityGameSession({
          sessionId: "session-rollback",
          userId: "user-rollback",
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
          expiresAt: 1710086400000,
        })
      ).rejects.toThrow("ref write failed");

      expect(deleteScopedStateMock).toHaveBeenCalledWith(
        "identity-game-session",
        "session-rollback"
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "identity_game_session_ref_write_failed",
        expect.objectContaining({
          sessionId: "session-rollback",
          userId: "user-rollback",
          error: "ref write failed",
        })
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("rethrows the original ref write error when rollback also fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    writeScopedStateMock
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("ref write failed");
      });
    deleteScopedStateMock.mockImplementation(async () => {
      throw new Error("rollback failed");
    });

    try {
      const { upsertIdentityGameSession } = await import(
        "./_core/identityGameSessionState"
      );

      await expect(
        upsertIdentityGameSession({
          sessionId: "session-rollback-2",
          userId: "user-rollback-2",
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
          expiresAt: 1710086400000,
        })
      ).rejects.toThrow("ref write failed");

      expect(deleteScopedStateMock).toHaveBeenCalledWith(
        "identity-game-session",
        "session-rollback-2"
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "identity_game_session_ref_write_failed",
        expect.objectContaining({
          sessionId: "session-rollback-2",
          userId: "user-rollback-2",
          error: "ref write failed",
        })
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("preserves the original error when rollback throws synchronously", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    writeScopedStateMock
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(() => {
        throw new Error("ref write failed sync");
      });
    deleteScopedStateMock.mockImplementation(() => {
      throw new Error("rollback failed sync");
    });

    try {
      const { upsertIdentityGameSession } = await import(
        "./_core/identityGameSessionState"
      );

      await expect(
        upsertIdentityGameSession({
          sessionId: "session-rollback-3",
          userId: "user-rollback-3",
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
          expiresAt: 1710086400000,
        })
      ).rejects.toThrow("ref write failed sync");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "identity_game_session_ref_write_failed",
        expect.objectContaining({
          sessionId: "session-rollback-3",
          userId: "user-rollback-3",
          error: "ref write failed sync",
        })
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
