import { describe, expect, it } from "vitest";
import {
  getIdentityAiV1AnswerIdsByQuestion,
  isIdentityAiV1SessionResumable,
  resolveIdentityAiV1Archetype,
} from "./_core/identityAiV1";

describe("identityAiV1 resolver", () => {
  it("resolves every valid answer triple deterministically to one archetype", () => {
    const [q1Answers, q2Answers, q3Answers] = getIdentityAiV1AnswerIdsByQuestion();

    for (const q1 of q1Answers) {
      for (const q2 of q2Answers) {
        for (const q3 of q3Answers) {
          expect(
            resolveIdentityAiV1Archetype([q1, q2, q3])
          ).toMatch(/^(builder|visionary|analyst|operator)$/);
        }
      }
    }
  });

  it("treats expired sessions as not resumable", () => {
    expect(
      isIdentityAiV1SessionResumable({
        sessionId: "expired-identity-ai-v1-session",
        userId: "user-1",
        gameId: "identity-ai-v1",
        gameVersion: "v1",
        entryIntent: {
          sourceChannel: "messenger",
          sourceType: "referral",
          targetExperienceType: "identity_game",
          targetExperienceId: "identity-ai-v1",
          receivedAt: Date.now() - 10_000,
        },
        status: "in_progress",
        currentQuestionId: "identity-ai-v1-q2",
        answers: [],
        derivedTraits: {},
        startedAt: Date.now() - 10_000,
        updatedAt: Date.now() - 5_000,
        expiresAt: Date.now() - 1_000,
      })
    ).toBe(false);
  });
});
