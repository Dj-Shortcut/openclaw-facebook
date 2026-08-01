import { type Lang, t } from "./i18n";
import type { ConversationResponse } from "./botResponse";
import { FACE_MEMORY_CONSENT_NO, FACE_MEMORY_CONSENT_YES } from "./faceMemory";
import { formatFaceMemoryRetentionDays } from "./faceMemoryRetention";

const CONVERSATION_ACTION_NEW_IMAGE = "new_image";
const CONVERSATION_ACTION_EDIT_PHOTO = "edit_photo";
const CONVERSATION_ACTION_CHANGE_BACKGROUND = "change_background";
const CONVERSATION_ACTION_PRIVACY_INFO = "privacy";

export function buildQuickStartResponse(lang: Lang): ConversationResponse {
  return {
    text: t(lang, "flowExplanation"),
    actions: [
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: CONVERSATION_ACTION_NEW_IMAGE,
      },
      {
        id: CONVERSATION_ACTION_EDIT_PHOTO,
        label: t(lang, "editPhoto"),
        inputText: t(lang, "editPhoto"),
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
        inputText: "Privacy",
      },
    ],
  };
}

export function buildGenerationSuccessResponse(
  lang: Lang
): ConversationResponse {
  return {
    text: t(lang, "success"),
    actions: [
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: CONVERSATION_ACTION_NEW_IMAGE,
      },
      {
        id: CONVERSATION_ACTION_EDIT_PHOTO,
        label: t(lang, "editImage"),
        inputText: t(lang, "editImage"),
      },
      {
        id: CONVERSATION_ACTION_CHANGE_BACKGROUND,
        label: t(lang, "changeBackground"),
        inputText: CONVERSATION_ACTION_CHANGE_BACKGROUND,
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
        inputText: "Privacy",
      },
    ],
  };
}

export function buildGenerationFailureResponse(
  lang: Lang,
  text: string
): ConversationResponse {
  return {
    text,
    actions: [
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: CONVERSATION_ACTION_NEW_IMAGE,
      },
    ],
  };
}

function getSafePortalUpgradeUrl(): string | undefined {
  const configured =
    process.env.PORTAL_BASE_URL?.trim() ||
    process.env.LEADERBOT_PUBLIC_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    process.env.BASE_URL?.trim();
  if (!configured) return undefined;

  try {
    const base = new URL(configured);
    const isLocalDevelopment =
      process.env.NODE_ENV !== "production" &&
      base.protocol === "http:" &&
      (base.hostname === "localhost" || base.hostname === "127.0.0.1");
    if (
      base.username ||
      base.password ||
      (base.protocol !== "https:" && !isLocalDevelopment)
    ) {
      return undefined;
    }

    const target = new URL("/", base);
    target.searchParams.set("upgrade", "startpilot");
    target.hash = "pricing";
    return target.toString();
  } catch {
    return undefined;
  }
}

/** Channel-neutral upgrade response; channels decide how to render its URL. */
export function buildStartpilotQuotaReachedResponse(
  lang: Lang
): ConversationResponse {
  return buildStartpilotPortalResponse(lang, t(lang, "startpilotQuotaReached"));
}

/** Free users get the same safe portal handoff when today's allowance ends. */
export function buildFreeQuotaReachedResponse(lang: Lang): ConversationResponse {
  return buildStartpilotPortalResponse(lang, t(lang, "outOfFreeCredits"));
}

function buildStartpilotPortalResponse(
  lang: Lang,
  text: string
): ConversationResponse {
  const url = getSafePortalUpgradeUrl();
  return {
    text,
    actions: url
      ? [
          {
            id: "open_startpilot_upgrade",
            label: t(lang, "openLeaderbot"),
            url,
          },
        ]
      : [],
  };
}

export function buildImageUploadFailureResponse(
  lang: Lang,
  hasEditableImage: boolean
): ConversationResponse {
  return {
    text: t(
      lang,
      hasEditableImage
        ? "messengerMissingInputImageWithEditableImage"
        : "messengerMissingInputImage"
    ),
    actions: [
      ...(hasEditableImage
        ? [
            {
              id: CONVERSATION_ACTION_CHANGE_BACKGROUND,
              label: t(lang, "changeBackground"),
              inputText: CONVERSATION_ACTION_CHANGE_BACKGROUND,
            },
          ]
        : []),
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: CONVERSATION_ACTION_NEW_IMAGE,
      },
    ],
  };
}

export function buildAssistantPhotoHelpResponse(
  lang: Lang
): ConversationResponse {
  return {
    text: t(lang, "assistantQuickActions"),
    actions: [
      {
        id: CONVERSATION_ACTION_EDIT_PHOTO,
        label: t(lang, "editImage"),
        inputText: t(lang, "editImage"),
      },
      {
        id: CONVERSATION_ACTION_CHANGE_BACKGROUND,
        label: t(lang, "changeBackground"),
        inputText: CONVERSATION_ACTION_CHANGE_BACKGROUND,
      },
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: CONVERSATION_ACTION_NEW_IMAGE,
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
        inputText: "Privacy",
      },
    ],
  };
}

export function buildPhotoReceivedResponse(lang: Lang): ConversationResponse {
  return {
    text: t(lang, "photoEditPrompt"),
    actions: [
      {
        id: CONVERSATION_ACTION_EDIT_PHOTO,
        label: t(lang, "editImage"),
        inputText: t(lang, "editImage"),
      },
      {
        id: CONVERSATION_ACTION_CHANGE_BACKGROUND,
        label: t(lang, "changeBackground"),
        inputText: CONVERSATION_ACTION_CHANGE_BACKGROUND,
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
        inputText: "Privacy",
      },
    ],
  };
}

export function buildFaceMemoryConsentResponse(
  lang: Lang
): ConversationResponse {
  const retention = formatFaceMemoryRetentionDays(lang);
  return {
    text:
      lang === "en"
        ? `May I keep your photo for ${retention}? Then you do not have to upload it again every time. You can delete it any time with "delete my data".`
        : `Mag ik je foto ${retention} bewaren? Dan hoef je niet steeds opnieuw te uploaden. Je kan dit altijd wissen met "verwijder mijn data".`,
    actions: [
      {
        id: FACE_MEMORY_CONSENT_YES,
        label: lang === "en" ? `Yes, ${retention}` : `Ja, ${retention}`,
      },
      {
        id: FACE_MEMORY_CONSENT_NO,
        label: lang === "en" ? "No" : "Nee",
      },
    ],
  };
}
