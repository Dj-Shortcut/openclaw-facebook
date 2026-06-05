import type { MessengerGenerationJob } from "./messengerGenerationJob";
import { normalizeSupportedUiLang } from "./i18n";

const MESSENGER_GENERATION_KINDS = new Set([
  "text_to_image",
  "source_image_edit",
]);
const LEGACY_MESSENGER_GENERATION_KINDS = new Set(["style_restyle"]);

export type ReservedGenerationJob = {
  raw: string;
  job: MessengerGenerationJob;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalGenerationKind(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      (MESSENGER_GENERATION_KINDS.has(value) ||
        LEGACY_MESSENGER_GENERATION_KINDS.has(value)))
  );
}

function isOptionalAttempts(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function parseMessengerGenerationJob(
  value: unknown
): MessengerGenerationJob | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const lang = normalizeSupportedUiLang(value.lang);
  if (
    typeof value.psid !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.reqId !== "string" ||
    !lang ||
    !isOptionalGenerationKind(value.generationKind) ||
    !isOptionalString(value.sourceImageUrl) ||
    !isOptionalString(value.promptHint) ||
    !isOptionalAttempts(value.attempts)
  ) {
    return null;
  }

  return {
    psid: value.psid,
    userId: value.userId,
    reqId: value.reqId,
    lang,
    sourceImageUrl: value.sourceImageUrl,
    promptHint: value.promptHint,
    attempts: value.attempts,
    generationKind:
      value.generationKind === "style_restyle"
        ? "source_image_edit"
        : value.generationKind,
  } as MessengerGenerationJob;
}

export function parseReservedGenerationJob(
  raw: string
): ReservedGenerationJob | null {
  try {
    const job = parseMessengerGenerationJob(JSON.parse(raw));
    if (!job) {
      return null;
    }

    return {
      raw,
      job,
    };
  } catch {
    return null;
  }
}
