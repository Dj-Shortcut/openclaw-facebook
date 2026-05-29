import type { IdentityGameSession } from "./activeExperience";
import type { BotResponse } from "./botResponse";
import type { EntryIntent } from "./entryIntent";
import { t, type Lang } from "./i18n";
import type { MessengerUserState } from "./messengerState";
import {
  applyIdentityAiV1Answer,
  buildIdentityAiV1QuestionResponse,
  createIdentityAiV1Session,
  generateIdentityAiV1ImageResponse,
  IDENTITY_AI_V1_GAME_ID,
  isIdentityAiV1SessionResumable,
} from "./identityAiV1";

export type GameControlAction = "START_GAME" | "LATER";

export type StartGameInput = {
  state: MessengerUserState;
  entryIntent: EntryIntent;
  resumableSession: IdentityGameSession | null;
  lang: Lang;
  isAutoStart: boolean;
};

export type StartGameResult = {
  session: IdentityGameSession;
  response: BotResponse;
};

export type HandleGameActionInput = {
  session: IdentityGameSession;
  action: string | null;
  controlAction: GameControlAction | null;
  lang: Lang;
};

export type HandleGameActionResult = {
  session: IdentityGameSession | null;
  clearActiveExperience?: boolean;
  response: BotResponse;
  afterSend?: (() => Promise<BotResponse | null>) | undefined;
};

export type IdentityGameHandler = {
  gameId: string;
  isResumable: (session: IdentityGameSession | null) => session is IdentityGameSession;
  startSession: (input: StartGameInput) => Promise<StartGameResult>;
  handleAction: (input: HandleGameActionInput) => Promise<HandleGameActionResult>;
};

function buildConfirmFirstResponse(lang: Lang): BotResponse {
  const prompt = t(lang, "identityGameConfirmFirstPrompt");
  const startTitle = t(lang, "identityGameConfirmStart");
  const laterTitle = t(lang, "identityGameConfirmLater");
  return {
    kind: "options_prompt",
    prompt,
    options: [
      { id: "START_GAME", title: startTitle },
      { id: "LATER", title: laterTitle },
    ],
    selectionMode: "single",
    fallbackText: [prompt, `${startTitle} / ${laterTitle}`].join("\n"),
  };
}

const identityAiV1Handler: IdentityGameHandler = {
  gameId: IDENTITY_AI_V1_GAME_ID,
  isResumable: isIdentityAiV1SessionResumable,
  async startSession(input) {
    const baseSession =
      input.resumableSession
        ? {
            ...input.resumableSession,
            entryIntent: input.entryIntent,
            updatedAt: input.entryIntent.receivedAt,
          }
        : createIdentityAiV1Session(input.state, input.entryIntent);

    const session =
      input.isAutoStart && baseSession.status === "started"
        ? {
            ...baseSession,
            status: "in_progress" as const,
            updatedAt: input.entryIntent.receivedAt,
          }
        : baseSession;

    if (!input.isAutoStart && session.status === "started") {
      return {
        session,
        response: buildConfirmFirstResponse(input.lang),
      };
    }

    return {
      session,
      response: buildIdentityAiV1QuestionResponse(session, input.lang),
    };
  },
  async handleAction(input) {
    if (input.controlAction === "LATER" && input.session.status === "started") {
      const abandonedSession: IdentityGameSession = {
        ...input.session,
        status: "abandoned",
        updatedAt: Date.now(),
      };
      return {
        session: abandonedSession,
        clearActiveExperience: true,
        response: {
          kind: "text",
          text: t(input.lang, "identityGameDeferred"),
        },
      };
    }

    if (input.session.status === "resolving" || input.session.status === "completed") {
      return {
        session: input.session,
        response: {
          kind: "error",
          text: t(input.lang, "identityGameSessionPending"),
        },
      };
    }

    if (input.controlAction === "START_GAME" && input.session.status === "started") {
      const inProgressSession: IdentityGameSession = {
        ...input.session,
        status: "in_progress",
        updatedAt: Date.now(),
      };
      return {
        session: inProgressSession,
        response: buildIdentityAiV1QuestionResponse(inProgressSession, input.lang),
      };
    }

    if (input.controlAction === "START_GAME" && input.session.status === "in_progress") {
      return {
        session: input.session,
        response: buildIdentityAiV1QuestionResponse(input.session, input.lang),
      };
    }

    if (input.session.status === "started") {
      return {
        session: input.session,
        response: {
          kind: "error",
          text: t(input.lang, "identityGameSessionPending"),
        },
      };
    }

    if (!input.action) {
      return {
        session: input.session,
        response: buildIdentityAiV1QuestionResponse(input.session, input.lang, true),
      };
    }

    const answerResult = applyIdentityAiV1Answer(
      input.session,
      input.action,
      Date.now(),
      input.lang
    );

    if (answerResult.kind === "invalid") {
      return {
        session: input.session,
        response: answerResult.response,
      };
    }

    if (answerResult.kind === "question") {
      return {
        session: answerResult.session,
        response: answerResult.response,
      };
    }

    const resolvingSession = answerResult.session;
    return {
      session: resolvingSession,
      response: answerResult.response,
      afterSend: async () => {
        const imageResponse = await generateIdentityAiV1ImageResponse({
          session: resolvingSession,
          result: answerResult.result,
        });
        return imageResponse;
      },
    };
  },
};

const handlers = new Map<string, IdentityGameHandler>([
  [identityAiV1Handler.gameId, identityAiV1Handler],
]);

export function getIdentityGameHandler(
  gameId: string | null | undefined
): IdentityGameHandler | null {
  if (!gameId) {
    return null;
  }

  return handlers.get(gameId) ?? null;
}

