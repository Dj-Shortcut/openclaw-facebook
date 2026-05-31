import type { ConversationAction } from "./botResponse";

const INFERRED_CHOICE_MIN_COUNT = 2;
const INFERRED_CHOICE_MAX_COUNT = 13;

function normalizeInferredChoiceLabel(choice: string): string {
  const cleaned = choice
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

function inferChoiceLanguage(sourceText: string): "nl" | "en" {
  return /\b(?:wil|wilt|dat|ik|een|maak|schrijf|waarmee|kunt|genereren)\b/iu.test(
    sourceText
  )
    ? "nl"
    : "en";
}

function normalizeInferredChoiceInput(label: string, sourceText: string): string {
  const normalizedLabel = label.trim().replace(/[,:;?!.]+$/u, "");
  if (/^(?:tekstprompt|prompt|image prompt)$/iu.test(normalizedLabel)) {
    return normalizedLabel === "image prompt"
      ? "Write an image prompt"
      : "Schrijf een tekstprompt";
  }
  if (/^(?:maak|genereer|create|generate|schrijf|write)\b/iu.test(normalizedLabel)) {
    return normalizedLabel;
  }
  return inferChoiceLanguage(sourceText) === "nl"
    ? `Maak me een ${normalizedLabel}`
    : `Make me a ${normalizedLabel}`;
}

export function inferNumberedConversationActions(
  text: string | undefined
): ConversationAction[] {
  if (!text?.trim() || text.includes("```")) {
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
    choices.length < INFERRED_CHOICE_MIN_COUNT ||
    choices.length > INFERRED_CHOICE_MAX_COUNT
  ) {
    return [];
  }

  return choices.map((choice, index) => {
    const label = normalizeInferredChoiceLabel(choice);
    return {
      id: `choice_${index + 1}`,
      label,
      inputText: normalizeInferredChoiceInput(label, text),
    };
  });
}

export function stripNumberedConversationChoices(text: string): string {
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

    if (
      currentChoice &&
      line &&
      !/[.!?]$/u.test(currentChoice)
    ) {
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

  return compacted || text.trim();
}
