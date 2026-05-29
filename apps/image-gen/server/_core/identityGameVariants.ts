import { z } from "zod";

export const V1_ARCHETYPE_IDS = ["builder", "visionary", "analyst", "operator"] as const;
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

export const variantSchema = z.object({
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

function enumerateQuestionTriples(
  questions: readonly [
    z.infer<typeof questionSchema>,
    z.infer<typeof questionSchema>,
    z.infer<typeof questionSchema>
  ]
): Array<{
  key: string;
  option1: z.infer<typeof questionSchema>["options"][number];
  option2: z.infer<typeof questionSchema>["options"][number];
  option3: z.infer<typeof questionSchema>["options"][number];
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
