import type { Express, Request, Response } from "express";
import net from "node:net";
import { z } from "zod";

const IDENTITY_GAME_CANONICAL_DOMAIN = "leaderbot.live";
const DEFAULT_SHARE_TITLE = "Discover your AI archetype";
const DEFAULT_SHARE_DESCRIPTION =
  "Answer 3 quick questions and reveal your AI identity.";
const DEFAULT_SHARE_IMAGE_URL =
  "https://leaderbot.live/og/identity-games-default.jpg";
const V1_ARCHETYPE_IDS = ["builder", "visionary", "analyst", "operator"] as const;
const structuralOptionIdSchema = z.string().trim().regex(/^[a-z0-9_-]+$/i);

const optionSchema = z.object({
  id: structuralOptionIdSchema,
  title: z.string().trim().min(1),
  archetypeId: z.enum(V1_ARCHETYPE_IDS),
});

const questionSchema = z.object({
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  options: z.tuple([optionSchema, optionSchema, optionSchema, optionSchema]),
});

const archetypeSchema = z.object({
  id: z.enum(V1_ARCHETYPE_IDS),
  title: z.string().trim().min(1),
  identityLine: z.string().trim().min(1),
  explanationLine: z.string().trim().min(1),
});

const copySchema = z.object({
  intro: z.string().trim().min(1),
  invalid: z.string().trim().min(1),
  replay: z.string().trim().min(1),
});

const imagePromptSchema = z.object({
  styleKey: z.string().trim().min(1),
  variantDescriptor: z.string().trim().min(1),
});

const shareSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  imageUrl: z.string().url(),
});

const variantSchema = z.object({
  variantId: z.string().trim().min(1),
  status: z.enum(["draft", "qa", "active"]),
  version: z.string().trim().min(1),
  entryRefs: z.array(z.string().trim().min(1)).min(1),
  questions: z.tuple([questionSchema, questionSchema, questionSchema]),
  archetypes: z.tuple([archetypeSchema, archetypeSchema, archetypeSchema, archetypeSchema]),
  resolutionMap: z.record(z.string().trim().min(1), z.enum(V1_ARCHETYPE_IDS)),
  copy: copySchema,
  imagePrompt: imagePromptSchema,
  share: shareSchema.optional(),
});

export type GameVariantDefinition = z.infer<typeof variantSchema>;

type VariantValidationContext = {
  variant: GameVariantDefinition;
  normalizedId: string;
  mapKeys: string[];
  mapKeySet: Set<string>;
  expectedTriples: Set<string>;
  archetypeIds: Set<(typeof V1_ARCHETYPE_IDS)[number]>;
  missingArchetypes: (typeof V1_ARCHETYPE_IDS)[number][];
};

function resolveFamilies(
  first: (typeof V1_ARCHETYPE_IDS)[number],
  second: (typeof V1_ARCHETYPE_IDS)[number],
  third: (typeof V1_ARCHETYPE_IDS)[number]
): (typeof V1_ARCHETYPE_IDS)[number] {
  if (first === second || first === third) {
    return first;
  }
  if (second === third) {
    return second;
  }
  // In all-different triples, V1 intentionally resolves to the first question's family.
  // This mirrors the documented deterministic fallback used by identity-ai-v1.
  return first;
}

function buildDeterministicResolutionMap(
  questions: readonly [
    z.infer<typeof questionSchema>,
    z.infer<typeof questionSchema>,
    z.infer<typeof questionSchema>
  ]
): Record<string, (typeof V1_ARCHETYPE_IDS)[number]> {
  const map: Record<string, (typeof V1_ARCHETYPE_IDS)[number]> = {};
  for (const triple of enumerateQuestionTriples(questions)) {
    map[triple.key] = resolveFamilies(
      triple.option1.archetypeId,
      triple.option2.archetypeId,
      triple.option3.archetypeId
    );
  }
  return map;
}

const IDENTITY_AI_V1_QUESTIONS: [
  z.infer<typeof questionSchema>,
  z.infer<typeof questionSchema>,
  z.infer<typeof questionSchema>
] = [
  {
    id: "identity-ai-v1-q1",
    prompt: "When a new AI tool drops, what do you do first?",
    options: [
      { id: "q1_build", title: "Open it and start making something", archetypeId: "builder" },
      { id: "q1_vision", title: "Imagine what it could become", archetypeId: "visionary" },
      { id: "q1_analyst", title: "Figure out how it actually works", archetypeId: "analyst" },
      { id: "q1_operate", title: "See where it fits in a system", archetypeId: "operator" },
    ],
  },
  {
    id: "identity-ai-v1-q2",
    prompt: "What kind of result feels most satisfying to you?",
    options: [
      { id: "q2_build", title: "A finished thing I can use now", archetypeId: "builder" },
      { id: "q2_vision", title: "A bold idea no one saw coming", archetypeId: "visionary" },
      { id: "q2_analyst", title: "A clean answer that makes sense", archetypeId: "analyst" },
      { id: "q2_operate", title: "A process that runs smoothly", archetypeId: "operator" },
    ],
  },
  {
    id: "identity-ai-v1-q3",
    prompt: "What role do you naturally take in a smart team?",
    options: [
      { id: "q3_build", title: "The maker", archetypeId: "builder" },
      { id: "q3_vision", title: "The spark", archetypeId: "visionary" },
      { id: "q3_analyst", title: "The decoder", archetypeId: "analyst" },
      { id: "q3_operate", title: "The coordinator", archetypeId: "operator" },
    ],
  },
];

const IDENTITY_AI_V1_ARCHETYPES: [
  z.infer<typeof archetypeSchema>,
  z.infer<typeof archetypeSchema>,
  z.infer<typeof archetypeSchema>,
  z.infer<typeof archetypeSchema>
] = [
  {
    id: "builder",
    title: "Builder",
    identityLine: "Your dominant AI instinct is to turn momentum into something real.",
    explanationLine: "You lean toward making, shipping, and moving fast.",
  },
  {
    id: "visionary",
    title: "Visionary",
    identityLine: "Your dominant AI instinct is to spot the future before it arrives.",
    explanationLine: "You lean toward possibility, originality, and bold leaps.",
  },
  {
    id: "analyst",
    title: "Analyst",
    identityLine: "Your dominant AI instinct is to decode patterns before you commit.",
    explanationLine: "You lean toward clarity, logic, and understanding systems.",
  },
  {
    id: "operator",
    title: "Operator",
    identityLine: "Your dominant AI instinct is to make complex things run smoothly.",
    explanationLine: "You lean toward structure, coordination, and durable systems.",
  },
];

const DJ_V1_QUESTIONS: [
  z.infer<typeof questionSchema>,
  z.infer<typeof questionSchema>,
  z.infer<typeof questionSchema>
] = [
  {
    id: "dj-v1-q1",
    prompt: "Wat is je eerste reflex als de vloer volloopt?",
    options: [
      { id: "dj_q1_a1", title: "Alles strak in de mix houden", archetypeId: "builder" },
      { id: "dj_q1_a2", title: "De vibe van de crowd volgen", archetypeId: "visionary" },
      { id: "dj_q1_a3", title: "Iets onverwachts droppen", archetypeId: "analyst" },
      { id: "dj_q1_a4", title: "Terug naar pure classics", archetypeId: "operator" },
    ],
  },
  {
    id: "dj-v1-q2",
    prompt: "Waar let je het meest op tijdens je set?",
    options: [
      { id: "dj_q2_a1", title: "Timing, levels en controle", archetypeId: "builder" },
      { id: "dj_q2_a2", title: "Reacties op de dansvloer", archetypeId: "visionary" },
      { id: "dj_q2_a3", title: "Verrassing en contrast", archetypeId: "analyst" },
      { id: "dj_q2_a4", title: "Trackselectie en roots", archetypeId: "operator" },
    ],
  },
  {
    id: "dj-v1-q3",
    prompt: "Hoe wil je dat mensen je set onthouden?",
    options: [
      { id: "dj_q3_a1", title: "Messcherp en technisch", archetypeId: "builder" },
      { id: "dj_q3_a2", title: "Energiek en verbindend", archetypeId: "visionary" },
      { id: "dj_q3_a3", title: "Onvoorspelbaar en gedurfd", archetypeId: "analyst" },
      { id: "dj_q3_a4", title: "Smaakvol en tijdloos", archetypeId: "operator" },
    ],
  },
];

const DJ_V1_ARCHETYPES: [
  z.infer<typeof archetypeSchema>,
  z.infer<typeof archetypeSchema>,
  z.infer<typeof archetypeSchema>,
  z.infer<typeof archetypeSchema>
] = [
  {
    id: "builder",
    title: "Control Freak",
    identityLine: "Jij houdt elke overgang onder volledige controle.",
    explanationLine: "Strak, precies en altijd met een plan achter de decks.",
  },
  {
    id: "visionary",
    title: "Crowd Pleaser",
    identityLine: "Jij leest de zaal en bouwt energie op maat.",
    explanationLine: "Je set leeft van connectie, timing en publieksgevoel.",
  },
  {
    id: "analyst",
    title: "Wildcard",
    identityLine: "Jij kiest risico boven voorspelbaarheid.",
    explanationLine: "Onverwachte keuzes maken jouw sets memorabel.",
  },
  {
    id: "operator",
    title: "Purist",
    identityLine: "Jij bewaakt smaak, selectie en muzikale kern.",
    explanationLine: "Je draait met respect voor sound, roots en kwaliteit.",
  },
];

export const GAME_VARIANTS: readonly GameVariantDefinition[] = [
  {
    variantId: "identity-ai-v1",
    status: "active",
    version: "v1",
    entryRefs: ["identity-ai-v1", "game:identity-ai-v1"],
    questions: IDENTITY_AI_V1_QUESTIONS,
    archetypes: IDENTITY_AI_V1_ARCHETYPES,
    resolutionMap: buildDeterministicResolutionMap(IDENTITY_AI_V1_QUESTIONS),
    copy: {
      intro: "Answer 3 quick questions to reveal your AI archetype.",
      invalid: "That answer does not match one of the 4 choices.",
      replay: "Want another round? Open the game link again.",
    },
    imagePrompt: {
      styleKey: "identity-ai-v1-cinematic",
      variantDescriptor: "cinematic AI portrait reveal, high contrast, premium social style",
    },
    share: {
      title: "Which AI are you?",
      description: "Play a 3-question reveal and meet your AI archetype.",
      imageUrl: "https://leaderbot.live/og/identity-ai-v1-invite-v1.png",
    },
  },
  {
    variantId: "dj",
    status: "active",
    version: "v1",
    entryRefs: ["dj", "game:dj"],
    questions: DJ_V1_QUESTIONS,
    archetypes: DJ_V1_ARCHETYPES,
    resolutionMap: buildDeterministicResolutionMap(DJ_V1_QUESTIONS),
    copy: {
      intro: "Beantwoord 3 vragen en ontdek wat voor DJ je echt bent.",
      invalid: "Die keuze hoort niet bij de 4 geldige opties.",
      replay: "Nog een ronde? Open de game-link opnieuw.",
    },
    imagePrompt: {
      styleKey: "dj-v1-club-portrait",
      variantDescriptor:
        "high-energy DJ portrait reveal, club lighting, social-first composition",
    },
    share: {
      title: "Wat voor DJ ben jij écht?",
      description: "Dit ga je niet leuk vinden 😄",
      imageUrl: "https://leaderbot.live/og/dj-v1-invite-v1.png",
    },
  },
];

function normalizeVariantId(value: string): string {
  return value.trim().toLowerCase();
}

function isPrivateOrReservedIpLiteral(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const v4MappedMatch = normalizedHostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isPrivateOrReservedIpLiteral(v4MappedMatch[1]);
  }

  const mappedHexMatch = normalizedHostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexMatch) {
    const high = Number.parseInt(mappedHexMatch[1], 16);
    const low = Number.parseInt(mappedHexMatch[2], 16);
    const ipv4 = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join(".");
    return isPrivateOrReservedIpLiteral(ipv4);
  }

  const ipVersion = net.isIP(normalizedHostname);
  if (ipVersion === 4) {
    const [a, b] = normalizedHostname.split(".").map(part => Number(part));
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    return (
      normalizedHostname === "::1" ||
      normalizedHostname.startsWith("fc") ||
      normalizedHostname.startsWith("fd") ||
      normalizedHostname.startsWith("fe8") ||
      normalizedHostname.startsWith("fe9") ||
      normalizedHostname.startsWith("fea") ||
      normalizedHostname.startsWith("feb")
    );
  }

  return false;
}

function isLikelyPublicImageUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  if (!parsed.hostname || parsed.hostname === "localhost") {
    return false;
  }

  if (isPrivateOrReservedIpLiteral(parsed.hostname)) {
    return false;
  }

  if (parsed.searchParams.size === 0) {
    return true;
  }

  const blockedParamHints = ["signature", "sig", "token", "expires", "x-amz-"];
  for (const key of parsed.searchParams.keys()) {
    const lower = key.toLowerCase();
    if (blockedParamHints.some(hint => lower.includes(hint))) {
      return false;
    }
  }

  return true;
}

function validateVariantShape(
  rawVariant: GameVariantDefinition,
  errors: string[]
): GameVariantDefinition | null {
  const parsed = variantSchema.safeParse(rawVariant);
  if (!parsed.success) {
    errors.push(
      `Invalid variant definition: ${parsed.error.issues
        .map(issue => issue.path.join("."))
        .join(", ")}`
    );
    return null;
  }

  return parsed.data;
}

function enumerateQuestionTriples(
  questions: readonly [
    z.infer<typeof questionSchema>,
    z.infer<typeof questionSchema>,
    z.infer<typeof questionSchema>
  ]
): Array<{
  key: string;
  option1: GameVariantDefinition["questions"][0]["options"][number];
  option2: GameVariantDefinition["questions"][1]["options"][number];
  option3: GameVariantDefinition["questions"][2]["options"][number];
}> {
  const triples = [];
  for (const option1 of questions[0].options) {
    for (const option2 of questions[1].options) {
      for (const option3 of questions[2].options) {
        triples.push({
          key: `${option1.id}|${option2.id}|${option3.id}`,
          option1,
          option2,
          option3,
        });
      }
    }
  }
  return triples;
}

function buildExpectedTriples(variant: GameVariantDefinition): Set<string> {
  const expectedTriples = new Set<string>();
  for (const triple of enumerateQuestionTriples(variant.questions)) {
    expectedTriples.add(triple.key);
  }
  return expectedTriples;
}

function buildVariantValidationContext(
  variant: GameVariantDefinition
): VariantValidationContext {
  const mapKeys = Object.keys(variant.resolutionMap);
  const archetypeIds = new Set(variant.archetypes.map(archetype => archetype.id));

  return {
    variant,
    normalizedId: normalizeVariantId(variant.variantId),
    mapKeys,
    mapKeySet: new Set(mapKeys),
    expectedTriples: buildExpectedTriples(variant),
    archetypeIds,
    missingArchetypes: V1_ARCHETYPE_IDS.filter(id => !archetypeIds.has(id)),
  };
}

function validateVariantIdentity(
  context: VariantValidationContext,
  seenIds: Set<string>,
  errors: string[]
): void {
  if (seenIds.has(context.normalizedId)) {
    errors.push(`Duplicate variantId: ${context.variant.variantId}`);
  }
  seenIds.add(context.normalizedId);
}

function validateVariantShareMeta(
  context: VariantValidationContext,
  errors: string[]
): void {
  const { variant } = context;
  if (variant.status !== "active") {
    return;
  }

  if (!variant.share) {
    errors.push(`Active variant ${variant.variantId} must define share metadata`);
    return;
  }

  if (!isLikelyPublicImageUrl(variant.share.imageUrl)) {
    errors.push(
      `Active variant ${variant.variantId} has non-public or non-cache-safe share.imageUrl`
    );
  }
}

function validateVariantQuestionOptions(
  context: VariantValidationContext,
  errors: string[]
): void {
  for (const question of context.variant.questions) {
    const seenOptionIds = new Set<string>();
    for (const option of question.options) {
      if (seenOptionIds.has(option.id)) {
        errors.push(
          `Variant ${context.variant.variantId} question ${question.id} has duplicate option id: ${option.id}`
        );
      }
      seenOptionIds.add(option.id);
    }
  }
}

function validateVariantArchetypes(
  context: VariantValidationContext,
  errors: string[]
): void {
  if (context.missingArchetypes.length > 0) {
    errors.push(
      `Variant ${context.variant.variantId} is missing archetypes: ${context.missingArchetypes.join(", ")}`
    );
  }

  if (context.archetypeIds.size < context.variant.archetypes.length) {
    errors.push(`Variant ${context.variant.variantId} has duplicate archetype ids`);
  }
}

function validateVariantResolutionMap(
  context: VariantValidationContext,
  errors: string[]
): void {
  for (const tripleKey of context.expectedTriples) {
    if (!context.mapKeySet.has(tripleKey)) {
      errors.push(
        `Variant ${context.variant.variantId} is missing resolutionMap key: ${tripleKey}`
      );
    }
  }

  for (const tripleKey of context.mapKeys) {
    if (!context.expectedTriples.has(tripleKey)) {
      errors.push(
        `Variant ${context.variant.variantId} has unknown resolutionMap key: ${tripleKey}`
      );
    }

    const mappedArchetypeId = context.variant.resolutionMap[tripleKey];
    if (!context.archetypeIds.has(mappedArchetypeId)) {
      errors.push(
        `Variant ${context.variant.variantId} maps ${tripleKey} to unknown archetype: ${mappedArchetypeId}`
      );
    }
  }
}

export function assertIdentityGameVariantCatalog(
  variants: readonly GameVariantDefinition[] = GAME_VARIANTS
): void {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const rawVariant of variants) {
    const variant = validateVariantShape(rawVariant, errors);
    if (!variant) {
      continue;
    }

    const context = buildVariantValidationContext(variant);
    validateVariantIdentity(context, seenIds, errors);
    validateVariantShareMeta(context, errors);
    validateVariantQuestionOptions(context, errors);
    validateVariantArchetypes(context, errors);
    validateVariantResolutionMap(context, errors);
  }

  if (errors.length > 0) {
    throw new Error(`Identity game variant catalog validation failed: ${errors.join("; ")}`);
  }
}

function getVariantById(
  variantId: string,
  variants: readonly GameVariantDefinition[] = GAME_VARIANTS
): GameVariantDefinition | null {
  const normalized = normalizeVariantId(variantId);
  return (
    variants.find(variant => normalizeVariantId(variant.variantId) === normalized) ??
    null
  );
}

function buildMessengerEntryUrl(pageId: string, variantId: string): string {
  const normalizedVariantId = normalizeVariantId(variantId);
  const refValue = normalizedVariantId.startsWith("identity-")
    ? normalizedVariantId
    : `game:${normalizedVariantId}`;
  const ref = encodeURIComponent(refValue);
  return `https://m.me/${encodeURIComponent(pageId)}?ref=${ref}`;
}

function resolveShareMeta(variant: GameVariantDefinition): {
  title: string;
  description: string;
  imageUrl: string;
} {
  return {
    title: variant.share?.title ?? DEFAULT_SHARE_TITLE,
    description: variant.share?.description ?? DEFAULT_SHARE_DESCRIPTION,
    imageUrl: variant.share?.imageUrl ?? DEFAULT_SHARE_IMAGE_URL,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function toSafeInlineScriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function renderSharePageHtml(input: {
  canonicalUrl: string;
  messengerUrl: string;
  title: string;
  description: string;
  imageUrl: string;
}): string {
  const safeCanonicalUrl = escapeHtml(input.canonicalUrl);
  const safeMessengerUrl = escapeHtml(input.messengerUrl);
  const safeTitle = escapeHtml(input.title);
  const safeDescription = escapeHtml(input.description);
  const safeImageUrl = escapeHtml(input.imageUrl);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="canonical" href="${safeCanonicalUrl}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${safeCanonicalUrl}" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:image" content="${safeImageUrl}" />
    <meta http-equiv="refresh" content="0;url=${safeMessengerUrl}" />
    <script>window.location.replace(${toSafeInlineScriptString(input.messengerUrl)});</script>
  </head>
  <body>
    <p>Redirecting to Messenger...</p>
    <p><a href="${safeMessengerUrl}">Continue</a></p>
  </body>
</html>`;
}

function getRequestHost(req: Request): string {
  return req.hostname.trim().toLowerCase();
}

function isProductionEnv(inputNodeEnv?: string): boolean {
  return (inputNodeEnv ?? process.env.NODE_ENV) === "production";
}

function resolvePageId(overridePageId?: string): string {
  const pageId = (overridePageId ?? process.env.MESSENGER_PAGE_ID ?? "").trim();
  if (!pageId) {
    throw new Error("MESSENGER_PAGE_ID is required for identity game share routes");
  }
  if (!/^\d+$/.test(pageId)) {
    throw new Error("MESSENGER_PAGE_ID must be a numeric Facebook page id");
  }
  return pageId;
}

type RegisterShareRoutesOptions = {
  variants?: readonly GameVariantDefinition[];
  canonicalDomain?: string;
  pageId?: string;
  nodeEnv?: string;
};

export function registerIdentityGameShareRoutes(
  app: Express,
  options: RegisterShareRoutesOptions = {}
): void {
  const variants = options.variants ?? GAME_VARIANTS;
  const canonicalDomain =
    (options.canonicalDomain ?? IDENTITY_GAME_CANONICAL_DOMAIN).toLowerCase();
  const pageId = resolvePageId(options.pageId);
  assertIdentityGameVariantCatalog(variants);

  app.get("/play/:variantId", (req: Request, res: Response) => {
    const variantId = normalizeVariantId(req.params.variantId ?? "");
    const variant = getVariantById(variantId, variants);
    if (!variant) {
      res.status(404).type("text/plain").send("Variant not found");
      return;
    }

    const canonicalVariantId = normalizeVariantId(variant.variantId);
    const canonicalUrl = `https://${canonicalDomain}/play/${canonicalVariantId}`;
    const currentHost = getRequestHost(req);
    if (
      isProductionEnv(options.nodeEnv) &&
      variant.status === "active" &&
      currentHost !== canonicalDomain
    ) {
      // Keep canonical-host redirects temporary because variant status/domain policy can evolve.
      res.redirect(307, canonicalUrl);
      return;
    }

    const messengerUrl = buildMessengerEntryUrl(pageId, canonicalVariantId);
    const shareMeta = resolveShareMeta(variant);

    res
      .status(200)
      .setHeader(
        "Cache-Control",
        variant.status === "active" ? "public, max-age=300" : "no-store"
      )
      .type("text/html; charset=utf-8")
      .send(
        renderSharePageHtml({
          canonicalUrl,
          messengerUrl,
          title: shareMeta.title,
          description: shareMeta.description,
          imageUrl: shareMeta.imageUrl,
        })
      );
  });
}
