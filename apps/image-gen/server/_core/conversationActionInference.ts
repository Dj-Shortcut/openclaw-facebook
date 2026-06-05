import type { ConversationAction } from "./botResponse";

const INFERRED_CHOICE_MIN_COUNT = 2;
const INFERRED_CHOICE_MAX_COUNT = 13;
const MAX_PROMPT_ACTION_INPUT_LENGTH = 1_800;

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

function buildGeneratePromptActionInput(prompt: string, sourceText: string): string {
  return inferChoiceLanguage(sourceText) === "nl"
    ? `Gebruik deze prompt en maak een afbeelding: ${prompt}`
    : `Use this prompt to generate an image: ${prompt}`;
}

function normalizePromptBlock(block: string): string {
  return block
    .replace(/^prompt\s*[:\uFF1A-]\s*/iu, "")
    .replace(/^tekstprompt\s*[:\uFF1A-]\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isLikelyImagePromptBlock(
  sourceText: string,
  language: string,
  block: string
): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  if (/^(?:ts|tsx|js|jsx|json|html|css|sql|bash|sh|powershell|pwsh)$/u.test(normalizedLanguage)) {
    return false;
  }

  if (
    /\b(?:function|const|let|class|import|export|SELECT|INSERT|UPDATE|DELETE)\b/u.test(block) ||
    /(?:=>|<\/?[a-z][\s>])/iu.test(block)
  ) {
    return false;
  }

  return (
    /^(?:text|prompt|tekstprompt)?$/u.test(normalizedLanguage) &&
    /\b(?:prompt|tekstprompt|image|afbeelding|foto|picture|poster|portrait|portret|logo|scene|illustratie)\b/iu.test(
      sourceText
    )
  );
}

function inferPromptGenerationActions(
  text: string | undefined
): ConversationAction[] {
  if (!text?.trim()) {
    return [];
  }

  const blockPattern = /```([a-zA-Z-]*)\s*\n?([\s\S]*?)```/gu;
  const promptBlocks = [...text.matchAll(blockPattern)]
    .map(match => ({
      language: match[1] ?? "",
      prompt: normalizePromptBlock(match[2] ?? ""),
    }))
    .filter(({ language, prompt }) =>
      prompt.length >= 12 && isLikelyImagePromptBlock(text, language, prompt)
    );

  const prompt = promptBlocks.at(-1)?.prompt;
  if (!prompt) {
    return [];
  }

  const lang = inferChoiceLanguage(text);
  return [
    {
      id: "generate_prompt",
      label: lang === "nl" ? "Maak deze afbeelding" : "Generate this image",
      inputText: buildGeneratePromptActionInput(
        prompt.slice(0, MAX_PROMPT_ACTION_INPUT_LENGTH),
        text
      ),
    },
  ];
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

export function inferConversationActions(text: string | undefined): ConversationAction[] {
  return [
    ...inferPromptGenerationActions(text),
    ...inferNumberedConversationActions(text),
  ];
}

export function stripNumberedConversationChoices(text: string): string {
  if (text.includes("```")) {
    return text.trim();
  }

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
