import { randomUUID } from "node:crypto";
import type { IdentityGameSession } from "./activeExperience";
import type { BotResponse } from "./botResponse";
import { createImageGenerator } from "./imageService";
import type { Lang } from "./i18n";
import type { EntryIntent } from "./entryIntent";
import type { MessengerUserState } from "./messengerState";

export const IDENTITY_AI_V1_GAME_ID = "identity-ai-v1";
const IDENTITY_AI_V1_VERSION = "v1";
const IDENTITY_AI_V1_VISUAL_STYLE = "cinematic" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type IdentityAiV1ArchetypeId =
  | "builder"
  | "visionary"
  | "analyst"
  | "operator";

type QuestionId = "identity-ai-v1-q1" | "identity-ai-v1-q2" | "identity-ai-v1-q3";

type QuestionOption = {
  id: string;
  title: Record<Lang, string>;
  family: IdentityAiV1ArchetypeId;
};

type QuestionDefinition = {
  id: QuestionId;
  prompt: Record<Lang, string>;
  options: [QuestionOption, QuestionOption, QuestionOption, QuestionOption];
};

type ArchetypeDefinition = {
  id: IdentityAiV1ArchetypeId;
  label: Record<Lang, string>;
  identityLine: Record<Lang, string>;
  explanationLine: Record<Lang, string>;
  visualDescriptor: string;
};

type IdentityAiV1Result = {
  archetype: ArchetypeDefinition;
  title: string;
  identityLine: string;
  explanationLine: string;
  replayCta: string;
  imagePromptHint: string;
};

const QUESTIONS: [QuestionDefinition, QuestionDefinition, QuestionDefinition] = [
  {
    id: "identity-ai-v1-q1",
    prompt: {
      en: "When a new AI tool drops, what do you do first?",
      nl: "Wanneer er een nieuwe AI-tool verschijnt, wat doe je als eerste?",
    },
    options: [
      {
        id: "q1_build",
        title: {
          en: "Open it and start making something",
          nl: "Openen en meteen iets maken",
        },
        family: "builder",
      },
      {
        id: "q1_vision",
        title: {
          en: "Imagine what it could become",
          nl: "Inbeelden wat het kan worden",
        },
        family: "visionary",
      },
      {
        id: "q1_analyst",
        title: {
          en: "Figure out how it actually works",
          nl: "Uitzoeken hoe het echt werkt",
        },
        family: "analyst",
      },
      {
        id: "q1_operate",
        title: {
          en: "See where it fits in a system",
          nl: "Bekijken waar het in een systeem past",
        },
        family: "operator",
      },
    ],
  },
  {
    id: "identity-ai-v1-q2",
    prompt: {
      en: "What kind of result feels most satisfying to you?",
      nl: "Welk soort resultaat voelt voor jou het meest voldoeninggevend?",
    },
    options: [
      {
        id: "q2_build",
        title: {
          en: "A finished thing I can use now",
          nl: "Iets af dat ik nu kan gebruiken",
        },
        family: "builder",
      },
      {
        id: "q2_vision",
        title: {
          en: "A bold idea no one saw coming",
          nl: "Een sterk idee dat niemand zag aankomen",
        },
        family: "visionary",
      },
      {
        id: "q2_analyst",
        title: {
          en: "A clean answer that makes sense",
          nl: "Een helder antwoord dat klopt",
        },
        family: "analyst",
      },
      {
        id: "q2_operate",
        title: {
          en: "A process that runs smoothly",
          nl: "Een proces dat soepel draait",
        },
        family: "operator",
      },
    ],
  },
  {
    id: "identity-ai-v1-q3",
    prompt: {
      en: "What role do you naturally take in a smart team?",
      nl: "Welke rol neem jij van nature op in een slim team?",
    },
    options: [
      {
        id: "q3_build",
        title: {
          en: "The maker",
          nl: "De maker",
        },
        family: "builder",
      },
      {
        id: "q3_vision",
        title: {
          en: "The spark",
          nl: "De vonk",
        },
        family: "visionary",
      },
      {
        id: "q3_analyst",
        title: {
          en: "The decoder",
          nl: "De decoder",
        },
        family: "analyst",
      },
      {
        id: "q3_operate",
        title: {
          en: "The coordinator",
          nl: "De coördinator",
        },
        family: "operator",
      },
    ],
  },
];

const ARCHETYPES: Record<IdentityAiV1ArchetypeId, ArchetypeDefinition> = {
  builder: {
    id: "builder",
    label: {
      en: "Builder",
      nl: "Builder",
    },
    identityLine: {
      en: "Your dominant AI instinct is to turn momentum into something real.",
      nl: "Jouw dominante AI-instinct is om vaart om te zetten in iets echts.",
    },
    explanationLine: {
      en: "Your answers kept leaning toward making, shipping, and moving fast.",
      nl: "Jouw antwoorden trokken telkens richting maken, afleveren en vooruitgaan.",
    },
    visualDescriptor:
      "focused AI builder in a kinetic workshop, rapid prototypes, bright task lights, hands-on energy",
  },
  visionary: {
    id: "visionary",
    label: {
      en: "Visionary",
      nl: "Visionary",
    },
    identityLine: {
      en: "Your dominant AI instinct is to spot the future before it arrives.",
      nl: "Jouw dominante AI-instinct is de toekomst zien voordat ze er is.",
    },
    explanationLine: {
      en: "Your answers kept pulling toward possibility, originality, and big leaps.",
      nl: "Jouw antwoorden trokken telkens richting mogelijkheid, originaliteit en grote sprongen.",
    },
    visualDescriptor:
      "futurist AI visionary in a luminous concept studio, holographic sketches, expansive horizon, idea-first energy",
  },
  analyst: {
    id: "analyst",
    label: {
      en: "Analyst",
      nl: "Analyst",
    },
    identityLine: {
      en: "Your dominant AI instinct is to decode patterns before you commit.",
      nl: "Jouw dominante AI-instinct is patronen ontleden voor je beslist.",
    },
    explanationLine: {
      en: "Your answers kept favoring clarity, logic, and understanding the system.",
      nl: "Jouw antwoorden kozen telkens voor helderheid, logica en het systeem begrijpen.",
    },
    visualDescriptor:
      "precise AI analyst in a pattern observatory, layered data light, calm scrutiny, sharp detail",
  },
  operator: {
    id: "operator",
    label: {
      en: "Operator",
      nl: "Operator",
    },
    identityLine: {
      en: "Your dominant AI instinct is to make complex things run smoothly.",
      nl: "Jouw dominante AI-instinct is complexe dingen soepel laten draaien.",
    },
    explanationLine: {
      en: "Your answers kept favoring structure, coordination, and durable systems.",
      nl: "Jouw antwoorden kozen telkens voor structuur, coördinatie en duurzame systemen.",
    },
    visualDescriptor:
      "calm AI operator in a command center, elegant systems dashboards, structured flow, composed authority",
  },
};

const DISTINCT_FAMILY_LOOKUP: Record<string, IdentityAiV1ArchetypeId> = {
  "builder|visionary|analyst": "builder",
  "builder|analyst|visionary": "builder",
  "visionary|builder|analyst": "visionary",
  "visionary|analyst|builder": "visionary",
  "analyst|builder|visionary": "analyst",
  "analyst|visionary|builder": "analyst",
  "builder|visionary|operator": "builder",
  "builder|operator|visionary": "builder",
  "visionary|builder|operator": "visionary",
  "visionary|operator|builder": "visionary",
  "operator|builder|visionary": "operator",
  "operator|visionary|builder": "operator",
  "builder|analyst|operator": "builder",
  "builder|operator|analyst": "builder",
  "analyst|builder|operator": "analyst",
  "analyst|operator|builder": "analyst",
  "operator|builder|analyst": "operator",
  "operator|analyst|builder": "operator",
  "visionary|analyst|operator": "visionary",
  "visionary|operator|analyst": "visionary",
  "analyst|visionary|operator": "analyst",
  "analyst|operator|visionary": "analyst",
  "operator|visionary|analyst": "operator",
  "operator|analyst|visionary": "operator",
};

const QUESTION_BY_ID = new Map(QUESTIONS.map(question => [question.id, question]));
const ANSWER_LOOKUP = new Map(
  QUESTIONS.flatMap(question =>
    question.options.map(option => [
      option.id,
      { questionId: question.id, family: option.family, titles: option.title },
    ])
  )
);

function normalizeAnswerInput(value: string): string {
  return value.trim().toLowerCase();
}

function getQuestionIndex(questionId: QuestionId | undefined): number {
  if (!questionId) {
    return 0;
  }

  const index = QUESTIONS.findIndex(question => question.id === questionId);
  return index >= 0 ? index : 0;
}

function getCurrentQuestion(session: IdentityGameSession): QuestionDefinition {
  const currentQuestionId = session.currentQuestionId as QuestionId | undefined;
  return QUESTION_BY_ID.get(currentQuestionId ?? QUESTIONS[0].id) ?? QUESTIONS[0];
}

function buildQuestionFallbackText(
  lang: Lang,
  question: QuestionDefinition,
  invalid: boolean
): string {
  const intro = invalid
    ? lang === "en"
      ? "That answer does not match one of the 4 choices."
      : "Dat antwoord hoort niet bij een van de 4 keuzes."
    : question.prompt[lang];
  const replyHint =
    lang === "en"
      ? "Reply with one of these exact options:"
      : "Antwoord met een van deze exacte opties:";

  return [
    intro,
    invalid ? question.prompt[lang] : null,
    ...question.options.map((option, index) => `${index + 1}. ${option.title[lang]}`),
    replyHint,
  ]
    .filter(Boolean)
    .join("\n");
}

function getReplayCta(lang: Lang): string {
  return lang === "en" ? "Want another round? Open the game link again." : "Nog een ronde? Open de game-link opnieuw.";
}

function getVisualStylePrompt(): string {
  return "shared Identity AI V1 visual style, premium cinematic AI portrait, centered hero framing, sharp detail, luminous atmosphere";
}

function buildImagePromptHint(archetype: ArchetypeDefinition): string {
  return [
    `Archetype id: ${archetype.id}`,
    `Archetype visual descriptor: ${archetype.visualDescriptor}`,
    `Visual style: ${getVisualStylePrompt()}`,
  ].join(". ");
}

function isIdentityAiV1GameId(gameId: string | null | undefined): boolean {
  return gameId === IDENTITY_AI_V1_GAME_ID;
}

export function isIdentityAiV1SessionResumable(
  session: IdentityGameSession | null | undefined
): session is IdentityGameSession {
  if (!session || session.gameId !== IDENTITY_AI_V1_GAME_ID) {
    return false;
  }

  if (session.expiresAt <= Date.now()) {
    return false;
  }

  return session.status === "started" || session.status === "in_progress";
}

export function createIdentityAiV1Session(
  state: MessengerUserState,
  entryIntent: EntryIntent
): IdentityGameSession {
  const startedAt = entryIntent.receivedAt;
  const status = entryIntent.entryMode === "confirm_first" ? "started" : "in_progress";

  return {
    sessionId: randomUUID(),
    userId: state.userKey,
    gameId: IDENTITY_AI_V1_GAME_ID,
    gameVersion: IDENTITY_AI_V1_VERSION,
    entryIntent,
    status,
    currentQuestionId: QUESTIONS[0].id,
    answers: [],
    derivedTraits: {},
    startedAt,
    updatedAt: startedAt,
    expiresAt: startedAt + DAY_MS,
  };
}

export function buildIdentityAiV1QuestionResponse(
  session: IdentityGameSession,
  lang: Lang,
  invalid = false
): BotResponse {
  const question = getCurrentQuestion(session);
  const prompt = invalid
    ? lang === "en"
      ? `That answer does not match one of the 4 choices.\n\n${question.prompt[lang]}`
      : `Dat antwoord hoort niet bij een van de 4 keuzes.\n\n${question.prompt[lang]}`
    : question.prompt[lang];

  return {
    kind: "options_prompt",
    prompt,
    options: question.options.map(option => ({
      id: option.id,
      title: option.title[lang],
    })),
    selectionMode: "single",
    fallbackText: buildQuestionFallbackText(lang, question, invalid),
  };
}

export function resolveIdentityAiV1Archetype(
  answerIds: [string, string, string]
): IdentityAiV1ArchetypeId {
  const families = answerIds.map(answerId => {
    const resolved = ANSWER_LOOKUP.get(answerId);
    if (!resolved) {
      throw new Error(`Unknown Identity AI V1 answer id: ${answerId}`);
    }

    return resolved.family;
  });

  const counts = new Map<IdentityAiV1ArchetypeId, number>();
  for (const family of families) {
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  for (const [family, count] of counts.entries()) {
    if (count >= 2) {
      return family;
    }
  }

  const key = families.join("|");
  const resolved = DISTINCT_FAMILY_LOOKUP[key];
  if (!resolved) {
    throw new Error(`Unmapped Identity AI V1 answer combination: ${key}`);
  }

  return resolved;
}

function buildIdentityAiV1Result(
  answerIds: [string, string, string],
  lang: Lang
): IdentityAiV1Result {
  const archetype = ARCHETYPES[resolveIdentityAiV1Archetype(answerIds)];

  return {
    archetype,
    title: `${lang === "en" ? "You are" : "Jij bent"}: ${archetype.label[lang]}`,
    identityLine: archetype.identityLine[lang],
    explanationLine: archetype.explanationLine[lang],
    replayCta: getReplayCta(lang),
    imagePromptHint: buildImagePromptHint(archetype),
  };
}

function formatIdentityAiV1ResultText(result: IdentityAiV1Result): string {
  return [
    result.title,
    result.identityLine,
    result.explanationLine,
    result.replayCta,
  ].join("\n\n");
}

export function applyIdentityAiV1Answer(
  session: IdentityGameSession,
  action: string,
  recordedAt: number,
  lang: Lang
):
  | {
      kind: "invalid";
      response: BotResponse;
    }
  | {
      kind: "question";
      session: IdentityGameSession;
      response: BotResponse;
    }
  | {
      kind: "completed";
      session: IdentityGameSession;
      result: IdentityAiV1Result;
      response: BotResponse;
    } {
  const currentQuestion = getCurrentQuestion(session);
  const normalizedAction = normalizeAnswerInput(action);
  const selectedOption = currentQuestion.options.find(option => {
    return (
      option.id === normalizedAction ||
      normalizeAnswerInput(option.title.en) === normalizedAction ||
      normalizeAnswerInput(option.title.nl) === normalizedAction
    );
  });

  if (!selectedOption) {
    return {
      kind: "invalid",
      response: buildIdentityAiV1QuestionResponse(session, lang, true),
    };
  }

  const nextAnswers = [
    ...session.answers.filter(answer => answer.questionId !== currentQuestion.id),
    {
      questionId: currentQuestion.id,
      answerId: selectedOption.id,
      recordedAt,
    },
  ];
  const currentQuestionIndex = getQuestionIndex(currentQuestion.id);
  const nextQuestion = QUESTIONS[currentQuestionIndex + 1];

  if (nextQuestion) {
    return {
      kind: "question",
      session: {
        ...session,
        status: "in_progress",
        currentQuestionId: nextQuestion.id,
        answers: nextAnswers,
        updatedAt: recordedAt,
      },
      response: {
        kind: "options_prompt",
        prompt: nextQuestion.prompt[lang],
        options: nextQuestion.options.map(option => ({
          id: option.id,
          title: option.title[lang],
        })),
        selectionMode: "single",
        fallbackText: buildQuestionFallbackText(lang, nextQuestion, false),
      },
    };
  }

  const orderedAnswerIds = QUESTIONS.map(question => {
    const match = nextAnswers.find(answer => answer.questionId === question.id);
    if (!match) {
      throw new Error(`Missing answer for question ${question.id}`);
    }

    return match.answerId;
  }) as [string, string, string];
  const result = buildIdentityAiV1Result(orderedAnswerIds, lang);

  return {
    kind: "completed",
    session: {
      ...session,
      status: "resolving",
      answers: nextAnswers,
      updatedAt: recordedAt,
      resultRef: result.archetype.id,
    },
    result,
    response: {
      kind: "text",
      text: formatIdentityAiV1ResultText(result),
    },
  };
}

export async function generateIdentityAiV1ImageResponse(
  input: {
    session: IdentityGameSession;
    result: IdentityAiV1Result;
  }
): Promise<BotResponse | null> {
  try {
    const { generator } = createImageGenerator();
    const { imageUrl } = await generator.generate({
      style: IDENTITY_AI_V1_VISUAL_STYLE,
      promptHint: input.result.imagePromptHint,
      userKey: input.session.userId,
      reqId: `identity-ai-v1-${input.session.sessionId}`,
    });

    return {
      kind: "image",
      imageUrl,
      caption: input.result.title,
    };
  } catch (error) {
    console.warn("identity_ai_v1_image_generation_failed", {
      sessionId: input.session.sessionId,
      archetypeId: input.result.archetype.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function getIdentityAiV1QuestionIds(): readonly string[] {
  return QUESTIONS.map(question => question.id);
}

export function getIdentityAiV1AnswerIdsByQuestion(): readonly string[][] {
  return QUESTIONS.map(question => question.options.map(option => option.id));
}
