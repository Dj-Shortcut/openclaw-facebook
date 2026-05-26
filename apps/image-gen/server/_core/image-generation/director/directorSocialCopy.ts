import { getDirectorModeConfig } from "./directorModes";
import type { DirectorMode } from "./directorTypes";
import type { Lang } from "../../i18n";
import {
  extractResponseText,
  trimmedText,
} from "../../openai/responseText";
import { postResponsesPayload } from "../../openai/responsesClient";

type ResponsesApiPayload = {
  model: string;
  store: false;
  input: Array<{ role: "system" | "user"; content: string }>;
  temperature: number;
  max_output_tokens: number;
};

type DirectorSocialCopy = {
  caption: string;
  hashtags: string[];
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_CAPTION_LENGTH = 220;
const MAX_HASHTAGS = 6;

function getModel(): string {
  return process.env.OPENAI_DIRECTOR_SOCIAL_COPY_MODEL?.trim() || DEFAULT_MODEL;
}

function getTimeoutMs(): number {
  const configured = Number(process.env.OPENAI_DIRECTOR_SOCIAL_COPY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_TIMEOUT_MS;
}

function sanitizeCaption(value: unknown): string | undefined {
  const caption = trimmedText(value)?.replace(/\s+/g, " ").slice(0, MAX_CAPTION_LENGTH);
  return caption || undefined;
}

function sanitizeHashtag(value: unknown): string | undefined {
  const text = trimmedText(value);
  if (!text) {
    return undefined;
  }

  const normalized = text
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .trim();

  return normalized ? `#${normalized}` : undefined;
}

function parseSocialCopy(rawText: string): DirectorSocialCopy | undefined {
  try {
    const parsed = JSON.parse(rawText) as {
      caption?: unknown;
      hashtags?: unknown;
    };
    const caption = sanitizeCaption(parsed.caption);
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags
          .map(sanitizeHashtag)
          .filter((value): value is string => Boolean(value))
          .slice(0, MAX_HASHTAGS)
      : [];

    if (!caption) {
      return undefined;
    }

    return { caption, hashtags };
  } catch {
    return undefined;
  }
}

function buildPayload(input: {
  lang: Lang;
  directorMode: DirectorMode;
  promptHint?: string;
}): ResponsesApiPayload {
  const mode = getDirectorModeConfig(input.directorMode);
  const language = input.lang === "en" ? "English" : "Dutch";
  const promptHint = input.promptHint?.trim() || "No extra refinement.";

  return {
    model: getModel(),
    store: false,
    input: [
      {
        role: "system",
        content: [
          "You write short social copy for a generated photo.",
          `Write in ${language}.`,
          "Return only JSON with no markdown.",
          'Schema: {"caption":string,"hashtags":string[]}.',
          "Keep the caption under 140 characters, natural, and not salesy.",
          "Use at most 6 hashtags.",
          "Do not mention AI, prompts, or internal director modes.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Director vibe: ${mode.label}.`,
          `Vibe description: ${mode.vibe}.`,
          `User refinement: ${promptHint}.`,
          "Create one caption and hashtags suitable for Facebook, Instagram, or TikTok.",
        ].join(" "),
      },
    ],
    temperature: 0.4,
    max_output_tokens: 180,
  };
}

export async function generateDirectorSocialCopy(input: {
  lang: Lang;
  directorMode?: DirectorMode;
  promptHint?: string;
  reqId: string;
}): Promise<DirectorSocialCopy | undefined> {
  const directorMode = input.directorMode;
  if (!directorMode) {
    return undefined;
  }

  try {
    const response = await postResponsesPayload({
      payload: buildPayload({ ...input, directorMode }),
      timeoutMs: getTimeoutMs(),
    });
    if (!response) return undefined;

    if (!response.ok) {
      console.warn("director_social_copy_failed", {
        reqId: input.reqId,
        status: response.status,
      });
      return undefined;
    }

    const responseText = extractResponseText(await response.json());
    return responseText ? parseSocialCopy(responseText) : undefined;
  } catch (error) {
    console.warn("director_social_copy_failed", {
      reqId: input.reqId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function formatDirectorSocialCopy(copy: DirectorSocialCopy): string {
  return [
    copy.caption,
    copy.hashtags.length ? copy.hashtags.join(" ") : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
