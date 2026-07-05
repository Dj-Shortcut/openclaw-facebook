const PROMPT_WRITING_PATTERNS = [
  /\b(?:schrijf|write|maak|create)\s+(?:een\s+)?prompt\b/iu,
  /\bprompt\s+(?:voor|for)\b/iu,
];

const VIDEO_ANIMATION_PATTERNS = [
  /\b(?:laat|laat\s+hem|laat\s+haar|laat\s+hen|maak|maak\s+een|maak\s+mij|maak\s+me)\b.*\b(?:video|animatie|beweeg|bewegen|dansen|zingen)\b/iu,
  /\b(?:bewegen|bewegend)\s+(?:zoals|als)\s+\w+/iu,
  /\b(?:laat|maak)\s+(?:hem|haar|hen|me)\s+(?:bewegen|dansen|zingen)\b/iu,
  /\blet\b.*\b(?:him|her|them|it)\s+(?:dance|sing|move)\b/iu,
  /\b(?:dance|sing|move)\s+(?:as|like)\s+\w+/iu,
];

const EXPLICIT_SOURCE_EDIT_PATTERNS = [
  /\b(?:restyle|restylen|restijlen|restijl|bewerk|edit|pas\s+aan|retoucheer)\b/iu,
  /\b(?:bewerk\s+foto|bewerk\s+deze\s+foto|foto\s+bewerken|edit\s+image|edit\s+this\s+image|edit\s+photo|this\s+photo|deze\s+foto)\b/iu,
  /\b(?:deze|this)\s+(?:foto|afbeelding|image|photo)\b.*\b(?:aanpassen|bewerken|edit|restyle)\b/iu,
];

const SOURCE_REFERENCE_PATTERNS = [
  /\b(?:van|met|op basis van|using|from|based on)\s+(?:deze|dit|this)\s+(?:foto|afbeelding|image|photo|resultaat|result)\b/iu,
  /\b(?:deze|dit|this)\s+(?:foto|afbeelding|image|photo|resultaat|result)\b/iu,
];

const NON_IMAGE_ARTIFACT_PATTERNS = [
  /\b(?:maak|create)\s+(?:een\s+)?(?:plan|lijst|samenvatting|tekst|email|e-mail|brief|gedicht|verhaal|script|code|functie|schema|planning)\b/iu,
  /\b(?:kan|kun|could|can)\s+(?:je|jij|you)\b.*\b(?:plan|lijst|samenvatting|tekst|email|e-mail|brief|gedicht|verhaal|script|code|functie|schema|planning|afspraak|reservering|boeking)\b.*\b(?:maken|make|create|write)\b/iu,
  /\b(?:write|make|create)\s+(?:a\s+)?(?:plan|list|summary|text|email|letter|poem|story|script|code|function|schedule)\b/iu,
  /\b(?:could|can)\s+you\b.*\b(?:plan|list|summary|text|email|letter|poem|story|script|code|function|schedule|appointment|reservation|booking)\b.*\b(?:make|create|write)\b/iu,
];

const IMAGE_GENERATION_PATTERNS = [
  /\b(?:maak|genereer|creeer|create|generate)\b.*\b(?:afbeelding|foto|plaatje|image|picture)\b/iu,
  /\b(?:afbeelding|foto|plaatje|image|picture)\b.*\b(?:maak|maken|genereer|genereren|create|generate)\b/iu,
  /\b(?:ik\s+wil(?:\s+graag)?|graag)\b.*\b(?:afbeelding|foto|plaatje|image|picture)\b/iu,
  /\b(?:zou|wil|wilt|would)\s+(?:je|jij|you)\b.*\b(?:afbeelding|foto|plaatje|image|picture)\b.*\b(?:maken|genereren|kunnen\s+maken|kunnen\s+genereren|make|create|generate)\b/iu,
  /\b(?:maak|genereer|creeer|create|generate)\b.*\b(?:landschap|stad|poster|logo|portret|avatar|sticker|illustratie|productfoto|scene|cover)\b/iu,
  /\b(?:kan|kun|could|can)\s+(?:je|jij|you)\b.*\b(?:landschap|stad|poster|logo|portret|avatar|sticker|illustratie|productfoto|scene|cover)\b.*\b(?:maken|genereren|make|create|generate)\b/iu,
];

const ARBITRARY_VISUAL_CREATE_PATTERNS = [
  /\b(?:maak|genereer|creeer|create|generate)\s+(?:eens\s+)?(?:voor\s+mij\s+|voor\s+me\s+|me\s+|mij\s+)?(?:een|a|an)\s+(.{3,})/iu,
  /\b(?:kan|kun|zou|could|can|would)\s+(?:je|jij|you)\b.*\b(?:een|a|an)\s+(.{3,}?)\s+\b(?:(?:kunnen\s+)?(?:maken|genereren)|make|create|generate)\b/iu,
];

const VAGUE_OBJECT_PATTERNS = [
  /^(?:dit|deze|dat|this|that|it)\b/iu,
  /^(?:beter|better|anders|different|mooier|nicer)\b/iu,
];

const FRESH_IMAGE_PATTERNS = [
  /\b(?:nieuwe|nieuw|new|fresh|brand-new|gloednieuwe|gloednieuw)\s+(?:afbeelding|foto|image|picture|avatar|poster|logo|sticker|illustratie|productfoto|scene|cover|portret|portrait)\b/iu,
  /\b(?:zonder|without)\s+(?:mijn|my|deze|this)\s+(?:foto|afbeelding|image|photo)\b/iu,
  /\b(?:from scratch|van nul|helemaal nieuw)\b/iu,
];

const SOURCE_IMAGE_TRANSFORM_PATTERNS = [
  /\bmake\s+(?:me|him|her|us|this)\s+(?:look\s+like|into)\b/iu,
  /\bcan\s+you\s+(?:make|turn|transform)\s+(?:me|him|her|us|this)\s+(?:look\s+like|into)\b/iu,
  /\bcould\s+you\s+(?:make|turn|transform)\s+(?:me|him|her|us|this)\s+(?:look\s+like|into)\b/iu,
  /\bturn\s+(?:me|him|her|us|this)\s+into\b/iu,
  /\btransform\s+(?:me|him|her|us|this)\s+into\b/iu,
  /\bmaak\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:als|tot)\b/iu,
  /\b(?:kan|kun)\s+(?:je|jij)\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:als|tot).*\b(?:maken|veranderen|omtoveren)\b/iu,
  /\bverander\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:in|naar|tot)\b/iu,
  /\btover\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:om\s+)?(?:in|tot)\b/iu,
  /\bzet\s+(?:me|mij|hem|haar|ons)\s+(?:neer\s+)?als\b/iu,
];

const VISUAL_CORRECTION_SUBJECT_WORDS = new Set([
  "samurai",
  "samoerai",
  "persoon",
  "mens",
  "man",
  "vrouw",
  "gezicht",
  "paard",
  "robot",
  "soldaat",
  "krijger",
  "gladiator",
  "ninja",
  "stad",
  "landschap",
  "logo",
  "poster",
  "tekst",
  "titel",
  "zwaard",
  "katana",
  "helm",
  "subject",
  "person",
  "face",
  "horse",
  "warrior",
  "city",
  "landscape",
  "text",
  "title",
  "sword",
]);

const SCREEN_REFERENCE_PATTERNS = [/\b(?:screenshot|screen)\b/iu];

export function normalizeImageIntentText(text: string): string {
  return text.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function isPromptWritingRequest(text: string): boolean {
  return PROMPT_WRITING_PATTERNS.some(pattern => pattern.test(text));
}

export function isExplicitSourceImageEditRequest(text: string): boolean {
  return EXPLICIT_SOURCE_EDIT_PATTERNS.some(pattern => pattern.test(text));
}

export function referencesExistingImage(text: string): boolean {
  return SOURCE_REFERENCE_PATTERNS.some(pattern => pattern.test(text));
}

export function isLikelyNonImageArtifactRequest(text: string): boolean {
  return NON_IMAGE_ARTIFACT_PATTERNS.some(pattern => pattern.test(text));
}

export function isFreshImageRequest(text: string): boolean {
  return FRESH_IMAGE_PATTERNS.some(pattern => pattern.test(text));
}

export function isSourceImageTransformRequest(text: string): boolean {
  return SOURCE_IMAGE_TRANSFORM_PATTERNS.some(pattern => pattern.test(text));
}

function tokenizeIntentText(text: string): string[] {
  return text.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

function hasVisualCorrectionSubject(tokens: readonly string[]): boolean {
  return tokens.some(token => VISUAL_CORRECTION_SUBJECT_WORDS.has(token));
}

export function isVisualCorrectionRequest(text: string): boolean {
  const normalized = normalizeImageIntentText(text);
  const tokens = tokenizeIntentText(normalized);
  if (!hasVisualCorrectionSubject(tokens)) {
    return false;
  }

  return (
    normalized.includes("ik zie geen") ||
    normalized.includes("zie geen") ||
    normalized.includes("ik zie niet de") ||
    normalized.includes("zie niet de") ||
    normalized.includes("maar geen") ||
    normalized.includes("wel mooi maar geen") ||
    normalized.includes("mooi maar geen") ||
    normalized.includes("maar niet de") ||
    normalized.includes("er mist") ||
    tokens.includes("mist") ||
    tokens.includes("ontbreekt") ||
    normalized.includes("i do not see") ||
    normalized.includes("i don't see") ||
    tokens.includes("no") ||
    tokens.includes("missing") ||
    normalized.includes("not visible")
  );
}

export function isVideoAnimationIntent(text: string): boolean {
  return VIDEO_ANIMATION_PATTERNS.some(pattern => pattern.test(text));
}

function hasArbitraryVisualSubject(text: string): boolean {
  for (const pattern of ARBITRARY_VISUAL_CREATE_PATTERNS) {
    const match = pattern.exec(text);
    const subject = match?.[1]?.trim().replace(/[?.!,]+$/u, "");
    if (subject && !VAGUE_OBJECT_PATTERNS.some(vague => vague.test(subject))) {
      return true;
    }
  }

  return false;
}

export function isImageGenerationRequest(text: string): boolean {
  return (
    IMAGE_GENERATION_PATTERNS.some(pattern => pattern.test(text)) ||
    hasArbitraryVisualSubject(text)
  );
}

export function isScreenshotUploadCaption(text: string): boolean {
  const normalized = normalizeImageIntentText(text);
  return SCREEN_REFERENCE_PATTERNS.some(pattern => pattern.test(normalized));
}
