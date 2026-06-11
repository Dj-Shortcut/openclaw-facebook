export function isMessengerVideoGenerationEnabled(): boolean {
  return process.env.MESSENGER_VIDEO_GENERATION_ENABLED === "true";
}

export function getMessengerVideoTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.MESSENGER_VIDEO_GENERATION_TIMEOUT_MS ?? "",
    10
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 240_000;
}
