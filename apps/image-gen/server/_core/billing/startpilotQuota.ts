export type StartpilotQuota = {
  aiAnswersTotal: 300;
  imagesTotal: 20;
  imagesPerDay: 5;
  workspaces: 1;
  facebookPages: 1;
  imageQuality: "images_2";
};

const STARTPILOT_QUOTA_KEYS = [
  "aiAnswersTotal",
  "facebookPages",
  "imageQuality",
  "imagesPerDay",
  "imagesTotal",
  "workspaces",
] as const;

export function parseStartpilotQuota(value: unknown): StartpilotQuota | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quota = value as Record<string, unknown>;
  const actualKeys = Object.keys(quota).sort();
  if (
    actualKeys.length !== STARTPILOT_QUOTA_KEYS.length ||
    actualKeys.some((key, index) => key !== STARTPILOT_QUOTA_KEYS[index])
  ) {
    return null;
  }
  return quota.aiAnswersTotal === 300 &&
    quota.imagesTotal === 20 &&
    quota.imagesPerDay === 5 &&
    quota.workspaces === 1 &&
    quota.facebookPages === 1 &&
    quota.imageQuality === "images_2"
    ? (quota as StartpilotQuota)
    : null;
}
