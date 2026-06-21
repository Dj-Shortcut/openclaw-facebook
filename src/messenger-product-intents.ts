export type MessengerFastLaneIntent =
  | "greeting"
  | "help"
  | "status"
  | "image"
  | "delete_data";

export function normalizeFastLaneText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[!?.,;:()[\]{}"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyMessengerFastLaneIntent(text: string): MessengerFastLaneIntent | null {
  const normalized = normalizeFastLaneText(text);
  if (
    /^(?:delete|remove|erase)\s+(?:my\s+)?data(?:\s+(?:aub|please|pls))?$/.test(normalized) ||
    /^(?:verwijder|wis)\s+(?:mijn\s+)?data(?:\s+(?:aub|alsjeblieft))?$/.test(normalized)
  ) {
    return "delete_data";
  }

  const intent = resolveMessengerConversationIntent({ text });
  if (intent.kind === "generate_image" || intent.kind === "edit_source_image") {
    return "image";
  }
  if (intent.kind === "greeting" || intent.kind === "help" || intent.kind === "status") {
    return intent.kind;
  }
  return null;
}

export function hasMessengerImageGenerationIntent(text: string): boolean {
  const intent = resolveMessengerConversationIntent({ text });
  return intent.kind === "generate_image" || intent.kind === "edit_source_image";
}

export function shouldForwardMessengerTextToImageGen(text: string): boolean {
  return hasMessengerImageGenerationIntent(text);
}

type MessengerConversationIntentKind =
  | "greeting"
  | "help"
  | "status"
  | "generate_image"
  | "edit_source_image"
  | "analyze_image"
  | "write_prompt"
  | "unknown";

export type MessengerConversationIntent = {
  kind: MessengerConversationIntentKind;
  confidence: number;
  prompt?: string;
};

function hasExplicitImageGenerationIntent(normalized: string): boolean {
  return /\b(restyle|restylen|restijlen|restijl|generate image|create image|maak afbeelding|maak een afbeelding|afbeelding maken|een afbeelding maken|genereer afbeelding|genereer een afbeelding|afbeelding genereren|een afbeelding genereren|maak plaatje|maak een plaatje|plaatje maken|een plaatje maken|bewerk foto|bewerk deze foto|foto bewerken|edit image|edit this image)\b/.test(
    normalized,
  );
}

function isLikelyVisualCreationRequest(normalizedText: string): boolean {
  if (
    /\b(planning|plan|lijst|tekst|bericht|mail|email|e mail|copy|caption|script|samenvatting|antwoord|reply|document|tabel|schema|code|functie|afspraak|reservering|boeking|schedule|appointment|reservation|booking|story|verhaal|gedicht|poem|letter)\b/.test(
      normalizedText,
    )
  ) {
    return false;
  }

  const visualSubject =
    "(?:foto|afbeelding|plaatje|beeld|illustratie|tekening|logo|poster|banner|cover|landschap|stad|scene|wereld|portret|character|personage|robot|soldaat|krijger|samurai|samoerai|ninja|superheld|stripheld|avatar|sticker|futuristische)";
  const createBeforeSubject = new RegExp(
    `\\b(?:maak|genereer|create|generate)\\s+(?:(?:me|mij)\\s+)?(?:een|de|het|an?|the)?\\s*(?:\\S+\\s+){0,4}?${visualSubject}\\b`,
  );
  const subjectBeforeCreate = new RegExp(
    `\\b(?:kan je|kun je|kan jij|kun jij|could you|can you)\\s+(?:(?:me|mij|voor mij)\\s+)?(?:een|de|het|an?|the)?\\s*(?:\\S+\\s+){0,4}?${visualSubject}\\s+(?:maken|genereren|make|create|generate)\\b`,
  );
  const subjectThenCreate = new RegExp(
    `\\b(?:\\S+\\s+){0,4}?${visualSubject}(?:\\S+\\s+){0,4}\\s+(?:maak|maken|genereer|genereren|make|create|generate)\\b`,
  );
  const broadCreateRequest =
    /\b(?:maak|genereer|create|generate)\s+(?:(?:voor mij|voor me|me|mij)\s+)?(?:een|de|het|an?|the)\s+\S+(?:\s+\S+){0,12}\b/.test(
      normalizedText,
    );
  const broadCanYouCreateRequest =
    /\b(?:kan je|kun je|kan jij|kun jij|could you|can you)\s+(?:(?:voor mij|voor me|me|mij)\s+)?(?:een|de|het|an?|the)\s+\S+(?:\s+\S+){0,12}\s+(?:maken|genereren|make|create|generate)\b/.test(
      normalizedText,
    );
  return (
    createBeforeSubject.test(normalizedText) ||
    subjectBeforeCreate.test(normalizedText) ||
    subjectThenCreate.test(normalizedText) ||
    broadCreateRequest ||
    broadCanYouCreateRequest
  );
}

export function hasMessengerSourceImageEditIntent(text: string): boolean {
  const normalized = normalizeFastLaneText(text);
  return /\b(restyle|restylen|restijlen|restijl|bewerk|bewerken|foto bewerken|edit image|edit this image|edit photo)\b/.test(
    normalized,
  );
}

function hasMessengerPersonalSourceTransformIntent(normalizedText: string): boolean {
  return (
    /\b(?:maak|verander|tover)\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:een|als|tot|in)\b/.test(
      normalizedText,
    ) ||
    /\b(?:maak|verander|tover)\s+(?:me|mij|hem|haar|ons|dit|deze)\s+\S+/.test(
      normalizedText,
    ) ||
    /\b(?:kan je|kun je|kan jij|kun jij)\s+(?:me|mij|hem|haar|ons|dit|deze)\s+\S+.*\b(?:maken|veranderen|omtoveren)\b/.test(
      normalizedText,
    ) ||
    /\b(?:make|turn|transform)\s+(?:me|him|her|us|this)\s+(?:a|an|into)\b/.test(
      normalizedText,
    ) ||
    /\b(?:can|could)\s+you\s+(?:make|turn|transform)\s+(?:me|him|her|us|this)\s+(?:a|an|into)\b/.test(
      normalizedText,
    )
  );
}

function hasMessengerImageAnalysisIntent(normalizedText: string): boolean {
  return /\b(wat zie je|wat staat er|beschrijf (?:deze )?foto|analyseer (?:deze )?foto|what do you see|describe (?:this )?(?:photo|image)|analy[sz]e (?:this )?(?:photo|image))\b/.test(
    normalizedText,
  );
}

function hasMessengerVisualCorrectionIntent(normalizedText: string): boolean {
  const visualSubject =
    "(?:samurai|samoerai|persoon|mens|man|vrouw|gezicht|paard|robot|soldaat|krijger|gladiator|ninja|stad|landschap|logo|poster|tekst|titel|zwaard|katana|helm|subject|person|face|horse|warrior|city|landscape|text|title|sword)";
  return (
    new RegExp(`\\b(?:ik\\s+zie|zie)\\s+(?:geen|niet\\s+de)\\s+${visualSubject}\\b`).test(
      normalizedText,
    ) ||
    new RegExp(`\\b(?:maar|wel\\s+mooi\\s+maar|mooi\\s+maar)\\s+(?:geen|niet\\s+de)\\s+${visualSubject}\\b`).test(
      normalizedText,
    ) ||
    new RegExp(`\\b(?:er\\s+mist|mist|ontbreekt)\\s+(?:een\\s+|de\\s+)?${visualSubject}\\b`).test(
      normalizedText,
    ) ||
    new RegExp(`\\b(?:i\\s+do\\s+not\\s+see|i\\s+don't\\s+see|no|missing)\\s+(?:a\\s+|the\\s+)?${visualSubject}\\b`).test(
      normalizedText,
    )
  );
}

function isMessengerPromptWritingRequest(normalizedText: string): boolean {
  return (
    /\b(maak|schrijf|bedenk|genereer|verbeter|formuleer)\s+(?:een|de|mijn)?\s*prompt\b/.test(
      normalizedText,
    ) ||
    /\b(create|write|draft|improve)\s+(?:an?|the|my)?\s*(?:image\s+)?prompt\b/.test(
      normalizedText,
    )
  );
}

export function resolveMessengerConversationIntent(params: {
  text: string;
  hasSourceImage?: boolean;
}): MessengerConversationIntent {
  const prompt = params.text.trim();
  const normalized = normalizeFastLaneText(prompt);
  if (!normalized) {
    return { kind: "unknown", confidence: 0 };
  }
  if (/^(hey|hi|hallo|hello|hoi|yo|goedemorgen|goedemiddag|goedenavond)$/.test(normalized)) {
    return { kind: "greeting", confidence: 0.95 };
  }
  if (
    /^(help|\/help|wat kan je|wat kun je|wat doe je|commands|commando's|mogelijkheden)$/.test(
      normalized,
    )
  ) {
    return { kind: "help", confidence: 0.95 };
  }
  if (/^(status|ping|ben je online|werkt dit|online)$/.test(normalized)) {
    return { kind: "status", confidence: 0.95 };
  }
  if (isMessengerPromptWritingRequest(normalized)) {
    return { kind: "write_prompt", confidence: 0.92, prompt };
  }
  if (hasMessengerImageAnalysisIntent(normalized)) {
    return { kind: "analyze_image", confidence: 0.86, prompt };
  }
  if (params.hasSourceImage && hasMessengerPersonalSourceTransformIntent(normalized)) {
    return { kind: "edit_source_image", confidence: 0.9, prompt };
  }
  if (hasMessengerVisualCorrectionIntent(normalized)) {
    return { kind: "edit_source_image", confidence: 0.86, prompt };
  }
  if (hasMessengerSourceImageEditIntent(normalized)) {
    return { kind: "edit_source_image", confidence: 0.92, prompt };
  }
  if (hasExplicitImageGenerationIntent(normalized) || isLikelyVisualCreationRequest(normalized)) {
    return { kind: "generate_image", confidence: 0.88, prompt };
  }
  return { kind: "unknown", confidence: 0.2 };
}

export function resolveMessengerSourceImageGenerationPrompt(params: {
  hasSourceImage: boolean;
  text: string;
}): string | null {
  const intent = resolveMessengerConversationIntent(params);
  if (!params.hasSourceImage || intent.kind !== "edit_source_image" || !intent.prompt) {
    return null;
  }
  return intent.prompt;
}

export function shouldForwardMessengerImageOnlyEventToImageGen(params: {
  hasSourceImage: boolean;
  text: string;
}): boolean {
  return params.hasSourceImage && !params.text.trim();
}

export function resolveMessengerFastLaneReply(
  text: string,
): { intent: MessengerFastLaneIntent; reply: string } | null {
  const intent = classifyMessengerFastLaneIntent(text);
  switch (intent) {
    case "greeting":
      return {
        intent,
        reply: "Hey! Ik ben er. Stuur je vraag gerust door.",
      };
    case "help":
      return {
        intent,
        reply:
          "Ik kan korte vragen beantwoorden, meedenken met taken en herkennen wanneer je een afbeelding wilt maken. Stuur gewoon wat je nodig hebt.",
      };
    case "status":
      return {
        intent,
        reply: "Online. Messenger is verbonden en ik kan je berichten ontvangen.",
      };
    case "delete_data":
      return {
        intent,
        reply:
          "Ik kan je data niet vanuit deze Messenger-gateway verwijderen. Gebruik de privacy- of data-verwijdering link van Leaderbot, of mail privacy@leaderbot.live met je verzoek. Berichten die al in Messenger staan, blijven door Meta beheerd.",
      };
    default:
      return null;
  }
}
