import type { ActiveExperience } from "./activeExperience";
import type { BotResponse } from "./botResponse";
import { sendMessengerBotResponse } from "./botResponseAdapters";
import type { EntryIntent } from "./entryIntent";
import { parseGameEntryIntent } from "./entryIntent";
import { routeActiveExperience, routeEntryIntent } from "./experienceRouter";
import type { Lang } from "./i18n";
import type {
  ConversationState,
  MessengerUserState,
} from "./messengerState";
import { toLogUser } from "./privacy";
import type { FacebookWebhookEvent } from "./webhookHelpers";

type RouteResult = {
  handled: boolean;
  response?: BotResponse | null;
  afterSend?: (() => Promise<BotResponse | null>) | undefined;
};

type ResponseSenderDeps = {
  userId: string;
  sendText: (text: string) => Promise<void>;
  sendStateText: (state: ConversationState, text: string) => Promise<void>;
  sendOptionsPrompt: (
    prompt: string,
    options: Array<{ id: string; title: string }>,
    fallbackLogName: string | undefined,
    fallbackText: string | undefined
  ) => Promise<void>;
  sendImage: (imageUrl: string) => Promise<void>;
  safeLog: (event: string, payload: Record<string, unknown>) => void;
};

type RouteDeps = ResponseSenderDeps & {
  psid: string;
  reqId: string;
  setLastEntryIntent: (entryIntent: EntryIntent | null) => Promise<void>;
  setActiveExperience: (
    activeExperience: ActiveExperience | null
  ) => Promise<void>;
};

function createMessengerResponseOptions(
  deps: ResponseSenderDeps,
  optionsFallbackLogName?: string
): Parameters<typeof sendMessengerBotResponse>[1] {
  return {
    sendText: deps.sendText,
    sendStateText: deps.sendStateText,
    sendOptionsPrompt: async (prompt, options, fallbackText) => {
      await deps.sendOptionsPrompt(
        prompt,
        options,
        optionsFallbackLogName,
        fallbackText
      );

      if (fallbackText && optionsFallbackLogName) {
        deps.safeLog(optionsFallbackLogName, {
          user: toLogUser(deps.userId),
          fallbackText,
        });
      }
    },
    sendImage: async (imageUrl, caption) => {
      if (caption) {
        await deps.sendText(caption);
      }

      await deps.sendImage(imageUrl);
    },
  };
}

async function sendRouteResponse(
  route: RouteResult,
  deps: ResponseSenderDeps,
  optionsFallbackLogName?: string
): Promise<void> {
  const options = createMessengerResponseOptions(deps, optionsFallbackLogName);
  await sendMessengerBotResponse(route.response ?? null, options);
  if (route.afterSend) {
    await sendMessengerBotResponse(await route.afterSend(), options);
  }
}

export function parseMessengerEntryIntent(input: {
  event: FacebookWebhookEvent;
  reqId: string;
  userId: string;
  localeLang: Lang;
  safeLog: (event: string, payload: Record<string, unknown>) => void;
}): {
  referralRef: string | undefined;
  entryIntent: EntryIntent | null;
} {
  const referralRef =
    input.event.postback?.referral?.ref ?? input.event.referral?.ref;
  const entryIntent = parseGameEntryIntent({
    channel: "messenger",
    ref: referralRef,
    sourceType: input.event.postback?.payload ? "postback" : "referral",
    localeHint: input.localeLang,
    receivedAt: input.event.timestamp ?? Date.now(),
  });

  input.safeLog("entry_intent_parsed", {
    reqId: input.reqId,
    user: toLogUser(input.userId),
    referralRef: referralRef ?? null,
    entryIntent: entryIntent
      ? {
          targetExperienceType: entryIntent.targetExperienceType,
          targetExperienceId: entryIntent.targetExperienceId,
          sourceType: entryIntent.sourceType,
          entryMode: entryIntent.entryMode ?? null,
        }
      : null,
  });

  return { referralRef, entryIntent };
}

export async function routeMessengerEntryIntent(input: {
  deps: RouteDeps;
  state: MessengerUserState;
  entryIntent: EntryIntent | null;
}): Promise<boolean> {
  const entryIntentRoute = await routeEntryIntent({
    state: input.state,
    entryIntent: input.entryIntent,
    setLastEntryIntent: input.deps.setLastEntryIntent,
    setActiveExperience: input.deps.setActiveExperience,
  });
  if (!entryIntentRoute.handled) {
    return false;
  }

  await sendRouteResponse(
    entryIntentRoute,
    input.deps,
    "entry_intent_options_fallback_available"
  );
  return true;
}

export async function routeMessengerActiveExperience(input: {
  deps: RouteDeps;
  state: MessengerUserState;
  event: FacebookWebhookEvent;
}): Promise<boolean> {
  const action =
    input.event.postback?.payload ??
    input.event.message?.quick_reply?.payload ??
    input.event.message?.text?.trim() ??
    null;
  const activeExperienceRoute = await routeActiveExperience({
    state: input.state,
    action,
    setLastEntryIntent: input.deps.setLastEntryIntent,
    setActiveExperience: input.deps.setActiveExperience,
  });
  if (!activeExperienceRoute.handled) {
    return false;
  }

  await sendRouteResponse(
    activeExperienceRoute,
    input.deps,
    "active_experience_options_fallback_available"
  );
  return true;
}
