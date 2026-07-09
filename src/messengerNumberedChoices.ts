import {
  MESSENGER_QUICK_REPLY_MAX_COUNT,
  type ConversationAction,
} from "./messengerPresentationTypes.js";
import {
  hasText,
  stripMessengerMarkdown,
} from "./messengerPresentationText.js";

const MESSENGER_INFERRED_CHOICE_MIN_COUNT = 2;

export function extractNumberedChoicesFromText(text: string | undefined): ConversationAction[] {
  if (!hasText(text) || text.includes("```")) {
    return [];
  }

  const choices: string[] = [];
  let currentChoice: string | null = null;
  let expectedNumber = 1;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(\d{1,2})[\.)]\s+(.+)$/u.exec(line);
    if (match) {
      const number = Number(match[1]);
      if (!Number.isInteger(number) || number !== expectedNumber) {
        currentChoice = null;
        continue;
      }
      currentChoice = match[2]?.trim() ?? "";
      if (currentChoice) {
        choices.push(currentChoice);
        expectedNumber += 1;
      }
      continue;
    }

    if (!line) {
      currentChoice = null;
      continue;
    }

    if (currentChoice && choices.length > 0 && !/[.!?]$/u.test(currentChoice)) {
      const continued = `${currentChoice} ${line}`.trim();
      choices[choices.length - 1] = continued;
      currentChoice = continued;
    }
  }

  if (
    choices.length < MESSENGER_INFERRED_CHOICE_MIN_COUNT ||
    choices.length > MESSENGER_QUICK_REPLY_MAX_COUNT
  ) {
    return [];
  }

  return choices.map((choice) => {
    const label = normalizeInferredChoiceLabel(choice);
    return {
      label,
      inputText: normalizeInferredChoiceInput(label),
    };
  });
}

function normalizeInferredChoiceLabel(choice: string): string {
  const cleaned = stripMessengerMarkdown(choice)
    .replace(/[,:;?!.]+$/u, "")
    .replace(/^(?:of\s+)?(?:een|a|an)\s+/iu, "")
    .replace(/\s+(?:schrijf|schrijven|write)(?:\s+(?:waarmee|which|that)\b.*)?$/iu, "")
    .replace(/\s+(?:maak|maken|schrijf|schrijven)$/iu, "")
    .trim();

  const label = /\b(?:tekstprompt|image prompt|prompt)\b/iu.test(cleaned)
    ? cleaned.match(/\b(?:tekstprompt|image prompt|prompt)\b/iu)?.[0] ?? cleaned
    : cleaned;

  return label || choice.trim();
}

function normalizeInferredChoiceInput(label: string): string {
  const normalizedLabel = label.trim().replace(/[,:;?!.]+$/u, "");
  if (/^(?:tekstprompt|prompt|image prompt)$/iu.test(normalizedLabel)) {
    return normalizedLabel === "image prompt"
      ? "Write an image prompt"
      : "Schrijf een tekstprompt";
  }
  if (/^(?:maak|genereer|create|generate|schrijf|write)\b/iu.test(normalizedLabel)) {
    return normalizedLabel;
  }
  return `Maak deze afbeelding: ${normalizedLabel}`;
}

export function stripNumberedChoicesFromText(text: string): string {
  const keptLines: string[] = [];
  let currentChoice: string | null = null;
  let expectedNumber = 1;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(\d{1,2})[\.)]\s+(.+)$/u.exec(line);
    if (match) {
      const number = Number(match[1]);
      if (Number.isInteger(number) && number === expectedNumber) {
        currentChoice = match[2]?.trim() ?? "";
        expectedNumber += 1;
        continue;
      }
    }

    if (currentChoice && line && !/[.!?]$/u.test(currentChoice)) {
      currentChoice = `${currentChoice} ${line}`.trim();
      continue;
    }

    currentChoice = null;
    keptLines.push(rawLine);
  }

  const compacted = keptLines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return stripMessengerMarkdown(compacted || text.trim());
}
