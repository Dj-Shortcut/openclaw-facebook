import type { GenerationKind } from "./image-generation/generationTypes";

export type GenerationStatsSnapshot = {
  date: string;
  imagesGeneratedToday: number;
  activeUsersToday: number;
  generationKindsUsedToday: number;
  errorCountToday: number;
  averageGenerationLatencyMs: number | null;
};

type DayStats = {
  imagesGenerated: number;
  errors: number;
  latencyTotalMs: number;
  latencyCount: number;
  activeUsers: Set<string>;
  generationKindsUsed: Set<GenerationKind>;
};

const statsByDay = new Map<string, DayStats>();

function getDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function getDayStats(now = Date.now()): DayStats {
  const day = getDayKey(now);
  const existing = statsByDay.get(day);
  if (existing) {
    return existing;
  }

  const created: DayStats = {
    imagesGenerated: 0,
    errors: 0,
    latencyTotalMs: 0,
    latencyCount: 0,
    activeUsers: new Set<string>(),
    generationKindsUsed: new Set<GenerationKind>(),
  };
  statsByDay.set(day, created);
  return created;
}

export function recordActiveUserToday(userId: string, now = Date.now()): void {
  getDayStats(now).activeUsers.add(userId);
}

export function recordGenerationSuccess(
  generationKind: GenerationKind,
  latencyMs: number,
  now = Date.now()
): void {
  const stats = getDayStats(now);
  stats.imagesGenerated += 1;
  stats.generationKindsUsed.add(generationKind);

  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    stats.latencyTotalMs += latencyMs;
    stats.latencyCount += 1;
  }
}

export function recordGenerationError(now = Date.now()): void {
  getDayStats(now).errors += 1;
}

export function getTodayRuntimeStats(now = Date.now()): GenerationStatsSnapshot {
  const day = getDayKey(now);
  const stats = getDayStats(now);

  return {
    date: day,
    imagesGeneratedToday: stats.imagesGenerated,
    activeUsersToday: stats.activeUsers.size,
    generationKindsUsedToday: stats.generationKindsUsed.size,
    errorCountToday: stats.errors,
    averageGenerationLatencyMs:
      stats.latencyCount > 0 ? Math.round(stats.latencyTotalMs / stats.latencyCount) : null,
  };
}

