import { t, type Lang } from "../i18n";
import {
  DIRECTOR_MODE_CONFIGS,
  DIRECTOR_GENERATION_STYLE,
  directorPayloadToMode,
} from "../image-generation/director/directorModes";
import type { DirectorMode } from "../image-generation/director/directorTypes";
import { getStylesForCategory, type Style, type StyleCategory } from "../messengerStyles";
import {
  getOrCreateState,
  setFlowState,
  setPreselectedStyle,
  setSelectedStyleCategory,
} from "../messengerState";
import {
  normalizeStyle,
  parseStyle,
  styleCategoryPayloadToCategory,
  stylePayloadToStyle,
  STYLE_CATEGORY_LABELS,
  STYLE_LABELS,
} from "../webhookHelpers";
import {
  sendWhatsAppListReply,
  sendWhatsAppTextReply,
} from "../whatsappResponseService";
import { runWhatsAppStyleGeneration } from "./styleGenerationFlow";

type WhatsAppStyleGroup = StyleCategory | "director";

const WHATSAPP_CATEGORY_CHOICES = [
  { key: "1", category: "illustrated" as const, label: STYLE_CATEGORY_LABELS.illustrated },
  { key: "2", category: "atmosphere" as const, label: STYLE_CATEGORY_LABELS.atmosphere },
  { key: "3", category: "bold" as const, label: STYLE_CATEGORY_LABELS.bold },
  { key: "4", category: "director" as const, label: "Director" },
];

export function parseWhatsAppCategorySelection(
  text: string
): WhatsAppStyleGroup | undefined {
  const normalizedText = text.trim().toLowerCase();
  if (normalizedText === "wa_illustrated") return "illustrated";
  if (normalizedText === "wa_atmosphere") return "atmosphere";
  if (normalizedText === "wa_bold") return "bold";
  if (normalizedText === "wa_director") return "director";

  const numbered = WHATSAPP_CATEGORY_CHOICES.find(
    choice => choice.key === normalizedText
  );
  if (numbered) return numbered.category;
  if (normalizedText.includes("illustr")) return "illustrated";
  if (normalizedText.includes("atmos")) return "atmosphere";
  if (normalizedText.includes("bold")) return "bold";
  if (normalizedText.includes("director") || normalizedText.includes("vibe")) {
    return "director";
  }
  return styleCategoryPayloadToCategory(normalizedText.toUpperCase());
}

export function parseWhatsAppStyleSelection(
  text: string,
  category: StyleCategory | null | undefined
): Style | undefined {
  const normalizedText = text.trim().toLowerCase();
  if (category) {
    const numericIndex = Number.parseInt(normalizedText, 10);
    if (Number.isFinite(numericIndex) && numericIndex > 0) {
      return getStylesForCategory(category)[numericIndex - 1]?.style;
    }
  }

  return stylePayloadToStyle(text) ?? parseStyle(text) ?? normalizeStyle(text);
}

function normalizeDirectorToken(text: string): string {
  return text.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function parseWhatsAppDirectorSelection(
  text: string,
  category: WhatsAppStyleGroup | null | undefined
): DirectorMode | undefined {
  const normalizedText = text.trim().toLowerCase();
  if (category === "director") {
    const numericIndex = Number.parseInt(normalizedText, 10);
    if (Number.isFinite(numericIndex) && numericIndex > 0) {
      return DIRECTOR_MODE_CONFIGS[numericIndex - 1]?.mode;
    }
  }

  const payloadMode = directorPayloadToMode(text);
  if (payloadMode) {
    return payloadMode;
  }

  const normalizedToken = normalizeDirectorToken(text);
  return DIRECTOR_MODE_CONFIGS.find(
    mode =>
      normalizeDirectorToken(mode.mode) === normalizedToken ||
      normalizeDirectorToken(mode.label) === normalizedToken
  )?.mode;
}

export async function sendWhatsAppStyleCategoryPrompt(
  senderId: string,
  lang: Lang
): Promise<void> {
  await sendWhatsAppListReply(
    senderId,
    lang === "en"
      ? "Choose a style group or director vibe to continue."
      : "Kies een stijlgroep of director-vibe om verder te gaan.",
    lang === "en" ? "Choose vibe" : "Kies vibe",
    WHATSAPP_CATEGORY_CHOICES.map(choice => ({
      id: `WA_${choice.category.toUpperCase()}`,
      title: choice.label,
      description:
        choice.category === "director"
          ? "Creative direction modes"
          : `${choice.label} styles`,
    })),
    lang === "en" ? "Style groups" : "Stijlgroepen"
  );
}

export async function sendWhatsAppStyleOptions(
  senderId: string,
  category: WhatsAppStyleGroup,
  lang: Lang
): Promise<void> {
  await setSelectedStyleCategory(senderId, category);
  await setFlowState(senderId, "AWAITING_STYLE");

  if (category === "director") {
    await sendWhatsAppListReply(
      senderId,
      lang === "en"
        ? "Pick a director vibe."
        : "Kies een director-vibe.",
      lang === "en" ? "Choose vibe" : "Kies vibe",
      DIRECTOR_MODE_CONFIGS.map(mode => ({
        id: mode.payload,
        title: mode.label,
        description: mode.description,
      })),
      "Director"
    );
    return;
  }

  await sendWhatsAppListReply(
    senderId,
    lang === "en"
      ? `Pick a ${STYLE_CATEGORY_LABELS[category].toLowerCase()} style.`
      : `Kies een ${STYLE_CATEGORY_LABELS[category].toLowerCase()}-stijl.`,
    lang === "en" ? "Choose style" : "Kies stijl",
    getStylesForCategory(category).map(style => ({
      id: style.payload,
      title: STYLE_LABELS[style.style],
      description:
        lang === "en"
          ? `${STYLE_CATEGORY_LABELS[category]} style`
          : `${STYLE_CATEGORY_LABELS[category]}-stijl`,
    })),
    STYLE_CATEGORY_LABELS[category]
  );
}

export async function handleWhatsAppPayloadSelection(input: {
  payload: string;
  senderId: string;
  userId: string;
  reqId: string;
  lang: Lang;
}): Promise<boolean> {
  const { payload, senderId, userId, reqId, lang } = input;
  if (payload === "WHAT_IS_THIS") {
    await sendWhatsAppTextReply(senderId, t(lang, "flowExplanation"));
    return true;
  }
  if (payload === "PRIVACY_INFO") {
    const appBaseUrl = process.env.APP_BASE_URL?.trim() ?? process.env.BASE_URL?.trim();
    const privacyUrl =
      process.env.PRIVACY_POLICY_URL?.trim() ||
      (appBaseUrl && /^https?:\/\//i.test(appBaseUrl)
        ? `${appBaseUrl.replace(/\/$/, "")}/privacy`
        : undefined);
    await sendWhatsAppTextReply(senderId, t(lang, "privacy", { link: privacyUrl }));
    return true;
  }
  if (payload === "CHOOSE_STYLE") {
    await setPreselectedStyle(senderId, null);
    await setSelectedStyleCategory(senderId, null);
    await setFlowState(senderId, "AWAITING_STYLE");
    await sendWhatsAppStyleCategoryPrompt(senderId, lang);
    return true;
  }
  if (payload !== "RETRY_STYLE") {
    return false;
  }

  const currentState = await Promise.resolve(getOrCreateState(senderId));
  const retryStyle = currentState.selectedStyle
    ? parseStyle(currentState.selectedStyle)
    : undefined;
  if (retryStyle) {
    await runWhatsAppStyleGeneration({ senderId, userId, style: retryStyle, reqId, lang });
    return true;
  }

  await setFlowState(senderId, "AWAITING_STYLE");
  await sendWhatsAppStyleCategoryPrompt(senderId, lang);
  return true;
}
