import { type Lang, t } from "./i18n";
import type { ConversationResponse, ImageQuotaBalance } from "./botResponse";
import { FACE_MEMORY_CONSENT_NO, FACE_MEMORY_CONSENT_YES } from "./faceMemory";
import { formatFaceMemoryRetentionDays } from "./faceMemoryRetention";

const CONVERSATION_ACTION_NEW_IMAGE = "new_image";
const CONVERSATION_ACTION_EDIT_PHOTO = "edit_photo";
const CONVERSATION_ACTION_CHANGE_BACKGROUND = "change_background";
const CONVERSATION_ACTION_COMBINE_PHOTOS = "combine_photos";
const CONVERSATION_ACTION_PRIVACY_INFO = "privacy";
const CONVERSATION_ACTION_PORTAL = "portal";

function buildPortalQuickReply(lang: Lang) {
  return {
    id: CONVERSATION_ACTION_PORTAL,
    label: t(lang, "portalAction"),
    inputText: CONVERSATION_ACTION_PORTAL,
  };
}

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
      buildPortalQuickReply(lang),
    ],
  };
}

export function buildGenerationSuccessResponse(
  lang: Lang,
  quotaStatus?: ImageQuotaBalance
): ConversationResponse {
  return {
    text: quotaStatus
      ? `${t(lang, "success")}\n${formatImageQuotaBalance(lang, quotaStatus)}`
      : t(lang, "success"),
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
      buildPortalQuickReply(lang),
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

function getSafePortalBaseUrl(): URL | undefined {
  const configured =
    process.env.PORTAL_BASE_URL?.trim() ||
    process.env.LEADERBOT_PUBLIC_URL?.trim();
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

    return base;
  } catch {
    return undefined;
  }
}

function getSafePortalUpgradeUrl(): string | undefined {
  const base = getSafePortalBaseUrl();
  if (!base) return undefined;
  const target = new URL("/", base);
  target.searchParams.set("upgrade", "startpilot");
  target.hash = "pricing";
  return target.toString();
}

function getSafePortalAccessUrl(): string | undefined {
  const base = getSafePortalBaseUrl();
  if (!base) return undefined;
  const target = new URL("/api/oauth/start", base);
  target.searchParams.set("returnTo", "/portal");
  return target.toString();
}

/** New Messenger users can self-enroll without receiving access to another tenant. */
export function buildPortalEnrollmentResponse(
  lang: Lang
): ConversationResponse {
  const url = getSafePortalAccessUrl();
  return {
    text: t(lang, "portalJoinPrompt"),
    actions: url
      ? [
          {
            id: "open_customer_portal",
            label: t(lang, "openPortal"),
            url,
          },
        ]
      : [],
  };
}

/** Channel-neutral upgrade response; channels decide how to render its URL. */
export function buildStartpilotQuotaReachedResponse(
  lang: Lang,
  reason: "total_exhausted" | "daily_exhausted" = "total_exhausted"
): ConversationResponse {
  return buildStartpilotPortalResponse(
    lang,
    t(
      lang,
      reason === "daily_exhausted"
        ? "startpilotDailyQuotaReached"
        : "startpilotQuotaReached"
    )
  );
}

/** Free users get the same safe portal handoff when today's allowance ends. */
export function buildFreeQuotaReachedResponse(
  lang: Lang,
  quotaStatus?: ImageQuotaBalance,
  premiumCheckoutUrl?: string
): ConversationResponse {
  const exhaustedText =
    quotaStatus?.monthly.remaining === 0
      ? t(lang, "outOfMonthlyImageCredits")
      : quotaStatus
        ? t(lang, "outOfDailyImageCredits")
        : t(lang, "outOfFreeCredits");
  const text = quotaStatus
    ? `${exhaustedText}\n${formatImageQuotaBalance(lang, quotaStatus)}`
    : exhaustedText;
  return {
    text: premiumCheckoutUrl
      ? lang === "nl"
        ? `${text}\nWil je nu verdergaan met betere kwaliteit? Kies optioneel 5 premium credits voor €3, eenmalig en zonder abonnement.`
        : `${text}\nWant to continue now with better quality? Optionally buy 5 premium credits for €3, once, with no subscription.`
      : text,
    actions: premiumCheckoutUrl
      ? [
          {
            id: "buy_premium_image_credits",
            label: t(lang, "buyPremiumCredits"),
            url: premiumCheckoutUrl,
          },
        ]
      : [],
  };
}

export function formatPremiumCreditBalance(
  lang: Lang,
  remaining: number
): string {
  return t(lang, "premiumCreditsRemaining", { link: String(remaining) });
}

export function formatImageQuotaBalance(
  lang: Lang,
  status: ImageQuotaBalance
): string {
  if (lang === "nl") {
    return `Vandaag nog ${status.daily.remaining} van ${status.daily.limit} foto's. Deze maand nog ${status.monthly.remaining} van ${status.monthly.limit}.`;
  }
  return `Today you have ${status.daily.remaining} of ${status.daily.limit} photos left. This month you have ${status.monthly.remaining} of ${status.monthly.limit} left.`;
}

/** Neutral balance-only response for an image whose Meta outcome is unknown. */
export function buildImageQuotaBalanceResponse(
  lang: Lang,
  status: ImageQuotaBalance
): ConversationResponse {
  return { text: formatImageQuotaBalance(lang, status), actions: [] };
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

export function buildMultiPhotoReceivedResponse(
  lang: Lang
): ConversationResponse {
  return {
    text: t(lang, "multiPhotoPrompt"),
    actions: [
      {
        id: CONVERSATION_ACTION_COMBINE_PHOTOS,
        label: t(lang, "combinePhotos"),
        inputText: CONVERSATION_ACTION_COMBINE_PHOTOS,
      },
      {
        id: CONVERSATION_ACTION_EDIT_PHOTO,
        label: t(lang, "editImage"),
        inputText: t(lang, "editImage"),
      },
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: CONVERSATION_ACTION_NEW_IMAGE,
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
