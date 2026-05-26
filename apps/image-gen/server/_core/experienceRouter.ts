import type { ActiveExperience, IdentityGameSession } from "./activeExperience";
import type { BotResponse } from "./botResponse";
import type { EntryIntent } from "./entryIntent";
import { normalizeLang, t } from "./i18n";
import { getIdentityGameHandler, type GameControlAction } from "./gameRegistry";
import {
  getIdentityGameSessionByActiveExperience,
  getIdentityGameSessionByUserId,
  upsertIdentityGameSession,
} from "./identityGameSessionState";
import type { MessengerUserState } from "./messengerState";

type ExperienceRouteResult = {
  handled: boolean;
  response?: BotResponse | null;
  afterSend?: (() => Promise<BotResponse | null>) | undefined;
};

type ExperienceRouterInput = {
  state: MessengerUserState;
  entryIntent?: EntryIntent | null;
  action?: string | null;
  setLastEntryIntent: (entryIntent: EntryIntent | null) => Promise<void>;
  setActiveExperience: (activeExperience: ActiveExperience | null) => Promise<void>;
};

/**
 * Normalizes inbound user input while preserving semantic content for answer parsing.
 * Returns `null` for empty/whitespace-only input.
 *
 * @param action Raw action input from payload, quick reply, or free text.
 * @returns Trimmed action text, or `null` when no actionable text is present.
 */
function normalizeAction(action: string | null | undefined): string | null {
  const normalized = action?.trim();
  return normalized ? normalized : null;
}

const START_GAME_TEXT_VARIANTS = new Set([
  "START GAME",
  "START",
  "START SPEL",
  "SPEL STARTEN",
]);

/**
 * Free-text variants that should defer the game and clear active experience.
 * Values are stored uppercase because matching happens on normalized uppercase input.
 */
const LATER_TEXT_VARIANTS = new Set(["LATER", "LATER AAN", "NU NIET"]);

/**
 * Maps human-entered control text to canonical game commands.
 * This keeps confirm-first flows resilient across typed labels and quick-reply payloads.
 *
 * @param action Raw action text coming from the active-experience event.
 * @returns `"START_GAME"` / `"LATER"` when recognized, otherwise `null`.
 */
function normalizeControlAction(
  action: string | null | undefined
): GameControlAction | null {
  const normalized = normalizeAction(action);
  if (!normalized) {
    return null;
  }

  const uppercase = normalized.toUpperCase();
  if (uppercase === "START_GAME") {
    return "START_GAME";
  }
  if (uppercase === "LATER") {
    return "LATER";
  }

  const compact = uppercase.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (START_GAME_TEXT_VARIANTS.has(compact)) {
    return "START_GAME";
  }
  if (LATER_TEXT_VARIANTS.has(compact)) {
    return "LATER";
  }

  return null;
}

function resolveRouterLang(input: ExperienceRouterInput): "nl" | "en" {
  return normalizeLang(
    input.entryIntent?.localeHint ??
      input.state.preferredLang ??
      input.state.lastEntryIntent?.localeHint
  );
}

function isIdentityGameSessionActive(session: IdentityGameSession): boolean {
  if (session.expiresAt <= Date.now()) {
    return false;
  }

  return session.status === "started" || session.status === "in_progress";
}

async function findExistingSessionForGame(
  state: MessengerUserState,
  entryIntent: EntryIntent
): Promise<IdentityGameSession | null> {
  const activeSession = await Promise.resolve(
    getIdentityGameSessionByActiveExperience(state.activeExperience)
  );

  if (
    activeSession &&
    activeSession.gameId === entryIntent.targetExperienceId &&
    isIdentityGameSessionActive(activeSession)
  ) {
    return activeSession;
  }

  const existingSession = await Promise.resolve(
    getIdentityGameSessionByUserId(state.userKey)
  );

  if (
    existingSession &&
    existingSession.gameId === entryIntent.targetExperienceId &&
    isIdentityGameSessionActive(existingSession)
  ) {
    return existingSession;
  }

  return null;
}

function toActiveExperience(session: IdentityGameSession): ActiveExperience {
  return {
    type: "identity_game",
    id: session.gameId,
    sessionId: session.sessionId,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
  };
}

function isRouteableIdentityGameSession(session: IdentityGameSession): boolean {
  return (
    session.status === "started" ||
    session.status === "in_progress" ||
    session.status === "resolving"
  );
}

async function resolveActiveIdentityGameSession(
  input: Omit<ExperienceRouterInput, "entryIntent">
): Promise<IdentityGameSession | null> {
  return await Promise.resolve(
    input.state.activeExperience?.type === "identity_game"
      ? getIdentityGameSessionByActiveExperience(input.state.activeExperience)
      : getIdentityGameSessionByUserId(input.state.userKey)
  );
}

async function clearStaleActiveExperience(
  input: Omit<ExperienceRouterInput, "entryIntent">
): Promise<void> {
  if (input.state.activeExperience?.type === "identity_game") {
    await input.setActiveExperience(null);
  }
}

async function syncActiveExperience(
  input: Omit<ExperienceRouterInput, "entryIntent">,
  activeSession: IdentityGameSession
): Promise<void> {
  const activeExperience = input.state.activeExperience;
  const needsSync =
    !activeExperience ||
    activeExperience.type !== "identity_game" ||
    activeExperience.sessionId !== activeSession.sessionId ||
    activeExperience.status !== activeSession.status ||
    activeExperience.updatedAt !== activeSession.updatedAt;

  if (needsSync) {
    await input.setActiveExperience(toActiveExperience(activeSession));
  }
}

function shouldPersistSession(
  nextSession: IdentityGameSession,
  activeSession: IdentityGameSession
): boolean {
  return (
    nextSession.sessionId !== activeSession.sessionId ||
    nextSession.status !== activeSession.status ||
    nextSession.updatedAt !== activeSession.updatedAt
  );
}

function finalizeResolvingSession(
  session: IdentityGameSession | null | undefined,
  hasAfterSend: boolean
): IdentityGameSession | null | undefined {
  if (session?.status !== "resolving" || !hasAfterSend) {
    return session;
  }

  return {
    ...session,
    status: "completed",
    updatedAt: Date.now(),
  };
}

async function persistHandlerSession(input: {
  routerInput: Omit<ExperienceRouterInput, "entryIntent">;
  activeSession: IdentityGameSession;
  session?: IdentityGameSession | null;
  shouldClearActiveExperience: boolean;
}): Promise<void> {
  if (!input.session || !shouldPersistSession(input.session, input.activeSession)) {
    return;
  }

  await Promise.resolve(upsertIdentityGameSession(input.session));
  if (
    input.session.status !== "resolving" &&
    !input.shouldClearActiveExperience
  ) {
    await input.routerInput.setActiveExperience(toActiveExperience(input.session));
  }
}

export async function routeEntryIntent(
  input: ExperienceRouterInput
): Promise<ExperienceRouteResult> {
  if (!input.entryIntent || input.entryIntent.targetExperienceType !== "identity_game") {
    return { handled: false };
  }

  await input.setLastEntryIntent(input.entryIntent);
  const lang = resolveRouterLang(input);
  const gameHandler = getIdentityGameHandler(input.entryIntent.targetExperienceId);
  if (!gameHandler) {
    await input.setActiveExperience(null);
    return {
      handled: true,
      response: {
        kind: "error",
        text: t(lang, "identityGameUnavailable"),
      },
    };
  }

  const latestSession = await findExistingSessionForGame(input.state, input.entryIntent);
  const resumableSession =
    latestSession && isIdentityGameSessionActive(latestSession) ? latestSession : null;
  const isAutoStart = input.entryIntent.entryMode !== "confirm_first";
  const { session, response } = await gameHandler.startSession({
    state: input.state,
    entryIntent: input.entryIntent,
    resumableSession:
      resumableSession && gameHandler.isResumable(resumableSession)
        ? resumableSession
        : null,
    lang,
    isAutoStart,
  });
  await Promise.resolve(upsertIdentityGameSession(session));
  await input.setActiveExperience(toActiveExperience(session));
  return { handled: true, response };
}

export async function routeActiveExperience(
  input: Omit<ExperienceRouterInput, "entryIntent">
): Promise<ExperienceRouteResult> {
  const activeSession = await resolveActiveIdentityGameSession(input);

  if (!activeSession || !isRouteableIdentityGameSession(activeSession)) {
    await clearStaleActiveExperience(input);
    return { handled: false };
  }

  await syncActiveExperience(input, activeSession);

  const action = normalizeAction(input.action);
  const controlAction = normalizeControlAction(action);
  const lang = resolveRouterLang({
    ...input,
    entryIntent: input.state.lastEntryIntent,
  });
  const gameHandler = getIdentityGameHandler(activeSession.gameId);
  if (!gameHandler) {
    await input.setActiveExperience(null);
    return {
      handled: true,
      response: {
        kind: "error",
        text: t(lang, "identityGameUnavailable"),
      },
    };
  }

  const handlerResult = await gameHandler.handleAction({
    session: activeSession,
    action,
    controlAction,
    lang,
  });

  const shouldFinalizeBeforeAfterSend =
    handlerResult.session?.status === "resolving" &&
    typeof handlerResult.afterSend === "function";
  const sessionToPersist = finalizeResolvingSession(
    handlerResult.session,
    shouldFinalizeBeforeAfterSend
  );
  const shouldClearActiveExperience =
    handlerResult.clearActiveExperience || shouldFinalizeBeforeAfterSend;

  await persistHandlerSession({
    routerInput: input,
    activeSession,
    session: sessionToPersist,
    shouldClearActiveExperience,
  });

  if (shouldClearActiveExperience) {
    await input.setActiveExperience(null);
  }

  return {
    handled: true,
    response: handlerResult.response,
    afterSend: handlerResult.afterSend
      ? async () => handlerResult.afterSend!()
      : undefined,
  };
}
