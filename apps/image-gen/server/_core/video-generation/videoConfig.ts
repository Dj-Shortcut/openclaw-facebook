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

export function getMessengerVideoFlowTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.MESSENGER_VIDEO_FLOW_TIMEOUT_MS ?? "",
    10
  );
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return getMessengerVideoTimeoutMs() + 60_000;
}
