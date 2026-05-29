const DEFAULT_FACE_MEMORY_RETENTION_DAYS = 30;
const FACE_MEMORY_STATE_TTL_BUFFER_DAYS = 2;

export function getFaceMemoryRetentionDays(): number {
  const parsed = Number(process.env.FACE_MEMORY_RETENTION_DAYS);
  if (Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)) {
    return parsed;
  }

  return DEFAULT_FACE_MEMORY_RETENTION_DAYS;
}

export function getFaceMemoryRetentionMs(): number {
  return getFaceMemoryRetentionDays() * 24 * 60 * 60 * 1000;
}

export function getFaceMemoryStateTtlSeconds(): number {
  return (getFaceMemoryRetentionDays() + FACE_MEMORY_STATE_TTL_BUFFER_DAYS) * 24 * 60 * 60;
}
