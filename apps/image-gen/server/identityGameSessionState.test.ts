import { describe, expect, it } from "vitest";
import type { ActiveExperience } from "./_core/activeExperience";
import {
  clearIdentityGameSession,
  getIdentityGameSessionByActiveExperience,
  getIdentityGameSessionBySessionId,
  getIdentityGameSessionByUserId,
  upsertIdentityGameSession,
} from "./_core/identityGameSessionState";
import { resetStateStore } from "./_core/messengerState";

describe("identityGameSessionState", () => {
  it("retrieves sessions by userId, sessionId, and activeExperience reference", () => {
    resetStateStore();

    const session = {
      sessionId: "session-1",
      userId: "user-1",
      gameId: "party-alter-ego",
      gameVersion: "v1",
      entryIntent: {
        sourceChannel: "messenger" as const,
        sourceType: "referral" as const,
        targetExperienceType: "identity_game" as const,
        targetExperienceId: "party-alter-ego",
        receivedAt: 1710000000000,
      },
      status: "started" as const,
      answers: [],
      derivedTraits: {},
      startedAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };

    upsertIdentityGameSession(session);

    expect(getIdentityGameSessionBySessionId("session-1")).toEqual(session);
    expect(getIdentityGameSessionByUserId("user-1")).toEqual(session);

    const activeExperience: ActiveExperience = {
      type: "identity_game",
      id: "party-alter-ego",
      sessionId: "session-1",
      status: "started",
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    };

    expect(getIdentityGameSessionByActiveExperience(activeExperience)).toEqual(
      session
    );

    clearIdentityGameSession("session-1", "user-1");
    expect(getIdentityGameSessionBySessionId("session-1")).toBeNull();
    expect(getIdentityGameSessionByUserId("user-1")).toBeNull();
  });

  it("returns null for an expired session when loaded by userId", () => {
    resetStateStore();

    const now = Date.now();
    upsertIdentityGameSession({
      sessionId: "expired-session-1",
      userId: "expired-user-1",
      gameId: "party-alter-ego",
      gameVersion: "v1",
      entryIntent: {
        sourceChannel: "messenger",
        sourceType: "referral",
        targetExperienceType: "identity_game",
        targetExperienceId: "party-alter-ego",
        receivedAt: now - 10_000,
      },
      status: "started",
      answers: [],
      derivedTraits: {},
      startedAt: now - 10_000,
      updatedAt: now - 10_000,
      expiresAt: now - 1_000,
    });

    expect(getIdentityGameSessionByUserId("expired-user-1")).toBeNull();
  });

  it("returns null for an expired session when loaded by sessionId", () => {
    resetStateStore();

    const now = Date.now();
    upsertIdentityGameSession({
      sessionId: "expired-session-2",
      userId: "expired-user-2",
      gameId: "party-alter-ego",
      gameVersion: "v1",
      entryIntent: {
        sourceChannel: "messenger",
        sourceType: "referral",
        targetExperienceType: "identity_game",
        targetExperienceId: "party-alter-ego",
        receivedAt: now - 10_000,
      },
      status: "started",
      answers: [],
      derivedTraits: {},
      startedAt: now - 10_000,
      updatedAt: now - 10_000,
      expiresAt: now - 1_000,
    });

    expect(getIdentityGameSessionBySessionId("expired-session-2")).toBeNull();
  });

  it("returns null when activeExperience points at a session from another game", () => {
    resetStateStore();

    const now = Date.now();
    const session = {
      sessionId: "cross-game-session",
      userId: "cross-game-user",
      gameId: "game-b",
      gameVersion: "v1",
      entryIntent: {
        sourceChannel: "messenger" as const,
        sourceType: "referral" as const,
        targetExperienceType: "identity_game" as const,
        targetExperienceId: "game-b",
        receivedAt: now,
      },
      status: "started" as const,
      answers: [],
      derivedTraits: {},
      startedAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    };

    upsertIdentityGameSession(session);

    const activeExperience: ActiveExperience = {
      type: "identity_game",
      id: "game-a",
      sessionId: "cross-game-session",
      status: "started",
      startedAt: now,
      updatedAt: now,
    };

    expect(getIdentityGameSessionByActiveExperience(activeExperience)).toBeNull();
  });
});
