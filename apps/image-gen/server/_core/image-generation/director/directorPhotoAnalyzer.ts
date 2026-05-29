import type { DownloadedSourceImage } from "../sourceImageFetcher";
import { extractResponseText } from "../../openai/responseText";
import { postResponsesPayload } from "../../openai/responsesClient";

type ResponsesApiPayload = {
  model: string;
  input: Array<{
    role: "system" | "user";
    content:
      | string
      | Array<
          | { type: "input_text"; text: string }
          | { type: "input_image"; image_url: string; detail: "low" | "high" | "auto" }
        >;
  }>;
  temperature: number;
  max_output_tokens: number;
};

const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ANALYSIS_LENGTH = 700;

function getModel(): string {
  return process.env.OPENAI_DIRECTOR_ANALYSIS_MODEL?.trim() || DEFAULT_MODEL;
}

function getTimeoutMs(): number {
  const configured = Number(process.env.OPENAI_DIRECTOR_ANALYSIS_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_TIMEOUT_MS;
}

function sanitizeAnalysis(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ANALYSIS_LENGTH);
}

function toDataUrl(sourceImage: DownloadedSourceImage): string {
  return `data:${sourceImage.contentType};base64,${sourceImage.buffer.toString("base64")}`;
}

function buildAnalysisPayload(sourceImage: DownloadedSourceImage): ResponsesApiPayload {
  return {
    model: getModel(),
    input: [
      {
        role: "system",
        content: [
          "You are a photo analysis assistant for an AI creative director.",
          "Describe only visual facts and useful transformation guidance.",
          "Do not identify the person, infer sensitive traits, or make demographic guesses beyond visible styling and apparent pose.",
          "Return concise plain text with notes about subject, pose, lighting, background, framing, image quality, and improvement opportunities.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Analyze this uploaded photo for a social-ready creative restyle. Keep it concise and practical.",
          },
          {
            type: "input_image",
            image_url: toDataUrl(sourceImage),
            detail: "low",
          },
        ],
      },
    ],
    temperature: 0,
    max_output_tokens: 180,
  };
}

export async function analyzeDirectorPhoto(
  sourceImage: DownloadedSourceImage,
  reqId: string
): Promise<string | undefined> {
  try {
    const response = await postResponsesPayload({
      payload: buildAnalysisPayload(sourceImage),
      timeoutMs: getTimeoutMs(),
    });
    if (!response) return undefined;

    if (!response.ok) {
      console.warn("director_photo_analysis_failed", {
        reqId,
        status: response.status,
      });
      return undefined;
    }

    const responseText = extractResponseText(await response.json());
    return responseText ? sanitizeAnalysis(responseText) : undefined;
  } catch (error) {
    console.warn("director_photo_analysis_failed", {
      reqId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
