import type { ConversationAction } from "./botResponse";
import { isGdprConsentActionId } from "./consentActionIds";
import type { QuickReply } from "./messengerApi";
import { encodeMessengerActionInput } from "./messengerActionPayload";

const MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH = 20;
const MESSENGER_BUTTON_LIMIT = 3;

export type MessengerWebUrlButton = {
  type: "web_url";
  title: string;
  url: string;
  webview_height_ratio: "full";
};

export type MessengerPostbackButton = {
  type: "postback";
  title: string;
  payload: string;
};

function normalizeActionValue(value: string): string | undefined {
  const trimmed = Array.from(value.trim())
    .slice(0, MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH)
    .join("")
    .trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePayloadValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function renderMessengerQuickReplies(
  actions: readonly ConversationAction[] | undefined
): QuickReply[] {
  if (!actions?.length) {
    return [];
  }

  const orderedActions = actions;

  return orderedActions.flatMap(action => {
    if (action.url && normalizeSafeActionUrl(action.url)) {
      return [];
    }
    const title = normalizeActionValue(action.label);
    const payload = normalizePayloadValue(renderMessengerActionPayload(action));
    if (!title || !payload) {
      return [];
    }

    return [
      {
        content_type: "text" as const,
        title,
        payload,
      },
    ];
  });
}

function isLocalDevelopmentUrl(url: URL): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

function configuredActionOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of [
    process.env.APP_BASE_URL,
    process.env.BASE_URL,
    ...(process.env.MESSENGER_ACTION_ALLOWED_ORIGINS?.split(",") ?? []),
  ]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (
        !parsed.username &&
        !parsed.password &&
        (parsed.protocol === "https:" || isLocalDevelopmentUrl(parsed))
      ) {
        origins.add(parsed.origin);
      }
    } catch {
      // Invalid configuration never expands the Messenger URL allowlist.
    }
  }
  return origins;
}

function normalizeSafeActionUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return undefined;
    if (url.protocol !== "https:" && !isLocalDevelopmentUrl(url)) {
      return undefined;
    }
    if (!configuredActionOrigins().has(url.origin)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function renderMessengerUrlButtons(
  actions: readonly ConversationAction[] | undefined
): MessengerWebUrlButton[] {
  if (!actions?.length) return [];

  return actions
    .flatMap(action => {
      const title = normalizeActionValue(action.label);
      const url = action.url ? normalizeSafeActionUrl(action.url) : undefined;
      if (!title || !url) return [];
      return [
        {
          type: "web_url" as const,
          title,
          url,
          webview_height_ratio: "full" as const,
        },
      ];
    })
    .slice(0, MESSENGER_BUTTON_LIMIT);
}

export function renderMessengerPostbackButtons(
  actions: readonly ConversationAction[] | undefined
): MessengerPostbackButton[] {
  if (!actions?.length) return [];

  return actions
    .flatMap(action => {
      if (action.url || !isPersistentPostbackActionId(action.id)) return [];
      const title = normalizeActionValue(action.label);
      const payload = normalizePayloadValue(action.id);
      if (!title || !payload) return [];
      return [{ type: "postback" as const, title, payload }];
    })
    .slice(0, MESSENGER_BUTTON_LIMIT);
}

function renderMessengerActionPayload(action: ConversationAction): string {
  if (!action.inputText && isPlatformPayloadActionId(action.id)) {
    return action.id;
  }

  return encodeMessengerActionInput(
    action.inputText ?? action.label ?? action.id
  );
}

function isPlatformPayloadActionId(id: string): boolean {
  return /^(?:CONSENT_|GDPR_)/.test(id);
}

function isPersistentPostbackActionId(id: string): boolean {
  return isGdprConsentActionId(id);
}
