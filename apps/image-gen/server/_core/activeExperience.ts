type ActiveExperienceStatus =
  | "started"
  | "in_progress"
  | "resolving"
  | "completed"
  | "abandoned"
  | "failed";

export type ActiveExperience = {
  type: "identity_game";
  id: string;
  sessionId: string;
  status: ActiveExperienceStatus;
  startedAt: number;
  updatedAt: number;
};

export type IdentityGameSession = {
  sessionId: string;
  userId: string;
  gameId: string;
  gameVersion: string;
  entryIntent: import("./entryIntent").EntryIntent;
  status: ActiveExperienceStatus;
  currentQuestionId?: string;
  answers: Array<{
    questionId: string;
    answerId: string;
    recordedAt: number;
  }>;
  derivedTraits: Record<string, number>;
  resultRef?: string;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
};
