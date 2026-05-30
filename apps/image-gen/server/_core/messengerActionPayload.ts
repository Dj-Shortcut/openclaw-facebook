const ACTION_INPUT_PREFIX = "OPENCLAW_ACTION:";

export function encodeMessengerActionInput(inputText: string): string {
  return `${ACTION_INPUT_PREFIX}${encodeURIComponent(inputText)}`;
}

export function decodeMessengerActionInput(
  payload: string | undefined
): string | undefined {
  if (!payload?.startsWith(ACTION_INPUT_PREFIX)) {
    return undefined;
  }

  const encodedInput = payload.slice(ACTION_INPUT_PREFIX.length);
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
