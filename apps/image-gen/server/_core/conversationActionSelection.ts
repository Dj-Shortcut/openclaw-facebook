import type { ConversationAction } from "./botResponse";

const ACTION_SELECTION_PATTERN =
  /^(?:(?:nr|nummer|optie|keuze|choice|option)\s*)?(\d{1,2})(?:\b|\s|[.!?])/iu;

function normalizeActionLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
}

export function resolveConversationActionInput(
  text: string,
  actions: readonly ConversationAction[] | undefined
): string | undefined {
  if (!actions?.length) {
    return undefined;
  }

  const normalizedText = normalizeActionLabel(text);
  const numberMatch = ACTION_SELECTION_PATTERN.exec(normalizedText);
  if (numberMatch) {
    const actionIndex = Number.parseInt(numberMatch[1] ?? "", 10) - 1;
    const action = actions[actionIndex];
    return action?.inputText ?? action?.label;
  }

  const matchingAction = actions.find(action => {
    const label = normalizeActionLabel(action.label);
    const inputText = action.inputText
      ? normalizeActionLabel(action.inputText)
      : undefined;
    return normalizedText === label || normalizedText === inputText;
  });

  return matchingAction?.inputText ?? matchingAction?.label;
}
