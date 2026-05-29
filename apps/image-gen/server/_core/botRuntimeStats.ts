import type { Style } from "./messengerStyles";

export type GenerationStatsSnapshot = {
  date: string;
  imagesGeneratedToday: number;
  activeUsersToday: number;
  stylesUsedToday: number;
  errorCountToday: number;
  averageGenerationLatencyMs: number | null;
};

type DayStats = {
  imagesGenerated: number;
  errors: number;
  latencyTotalMs: number;
  latencyCount: number;
  activeUsers: Set<string>;
  stylesUsed: Set<Style>;
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
    stylesUsed: new Set<Style>(),
  };
  statsByDay.set(day, created);
  return created;
}

export function recordActiveUserToday(userId: string, now = Date.now()): void {
  getDayStats(now).activeUsers.add(userId);
}

export function recordGenerationSuccess(style: Style, latencyMs: number, now = Date.now()): void {
  const stats = getDayStats(now);
  stats.imagesGenerated += 1;
  stats.stylesUsed.add(style);

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
    stylesUsedToday: stats.stylesUsed.size,
    errorCountToday: stats.errors,
    averageGenerationLatencyMs:
      stats.latencyCount > 0 ? Math.round(stats.latencyTotalMs / stats.latencyCount) : null,
  };
}

