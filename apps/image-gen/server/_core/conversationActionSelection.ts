import type { ConversationAction } from "./botResponse";

const ACTION_SELECTION_PREFIXES = new Set([
  "nr",
  "nummer",
  "optie",
  "keuze",
  "choice",
  "option",
]);

function normalizeActionLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
}

function readActionSelectionIndex(value: string): number | undefined {
  const [first = "", second = ""] = value.split(" ");
  const candidate = ACTION_SELECTION_PREFIXES.has(first) ? second : first;
  if (!/^\d{1,2}$/u.test(candidate)) {
    return undefined;
  }

  return Number.parseInt(candidate, 10) - 1;
}

export function resolveConversationActionInput(
  text: string,
  actions: readonly ConversationAction[] | undefined
): string | undefined {
  if (!actions?.length) {
    return undefined;
  }

  const normalizedText = normalizeActionLabel(text);
  const actionIndex = readActionSelectionIndex(normalizedText);
  if (actionIndex !== undefined) {
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
