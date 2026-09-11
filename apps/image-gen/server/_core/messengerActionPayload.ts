const ACTION_INPUT_PREFIX = "LEADERBOT_ACTION:";
// Wire compatibility for already-sent buttons and rollback images, not a runtime dependency.
const LEGACY_ACTION_INPUT_PREFIX = "OPENCLAW_ACTION:";

export function encodeMessengerActionInput(inputText: string): string {
  return `${LEGACY_ACTION_INPUT_PREFIX}${encodeURIComponent(inputText)}`;
}

export function decodeMessengerActionInput(
  payload: string | undefined
): string | undefined {
  const prefix = [ACTION_INPUT_PREFIX, LEGACY_ACTION_INPUT_PREFIX].find(value =>
    payload?.startsWith(value)
  );
  if (!prefix || !payload) {
    return undefined;
  }

  const encodedInput = payload.slice(prefix.length);
  if (!encodedInput) {
    return undefined;
  }

  try {
    const inputText = decodeURIComponent(encodedInput).trim();
    return inputText || undefined;
  } catch {
    return undefined;
  }
}
