import { getOpenAiImageModelConfig } from "./imageServiceConfig";

class OpenAiGenerationError extends Error {}
export class OpenAiBudgetExceededError extends Error {}

export type GenerationMetrics = {
  fbImageFetchMs?: number;
  promptBuildMs?: number;
  openAiPayloadBuildMs?: number;
  openAiMs?: number;
  openAiParseMs?: number;
  uploadOrServeMs?: number;
  totalMs: number;
};

type ErrorWithGenerationMetrics = Error & {
  generationMetrics?: GenerationMetrics;
};

type OpenAiSourceImage = {
  buffer: Buffer;
  contentType: string;
};

type OpenAiRequestContext = {
  endpoint: URL;
  requestInit: RequestInit;
};

type OpenAiRequestInput = {
  prompt: string;
  sourceImage: OpenAiSourceImage;
  hasSourceImage: boolean;
  previousResponseId?: string;
};

type OpenAiResponseContext = {
  reqId: string;
  startedAt: number;
  partialMetrics: Omit<GenerationMetrics, "totalMs">;
};

const OPENAI_RETRY_LIMIT_DEFAULT = 1;
const OPENAI_RETRY_BASE_MS_DEFAULT = 500;
const OPENAI_TIMEOUT_MS_DEFAULT = 45_000;
const OPENAI_IMAGE_MAX_OUTPUT_BYTES_DEFAULT = 25 * 1024 * 1024;
const OPENAI_RESPONSES_IMAGE_ENDPOINT = "https://api.openai.com/v1/responses";

function getOpenAiTimeoutMs(): number {
  const raw = Number.parseInt(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return OPENAI_TIMEOUT_MS_DEFAULT;
}

function getOpenAiRetryLimit(): number {
  const raw = Number.parseInt(process.env.OPENAI_IMAGE_MAX_RETRIES ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) {
    return raw;
  }

  return OPENAI_RETRY_LIMIT_DEFAULT;
}

function getOpenAiRetryBaseMs(): number {
  const raw = Number.parseInt(process.env.OPENAI_IMAGE_RETRY_BASE_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return OPENAI_RETRY_BASE_MS_DEFAULT;
}

function getOpenAiMaxOutputBytes(): number {
  const raw = Number.parseInt(process.env.OPENAI_IMAGE_MAX_OUTPUT_BYTES ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return OPENAI_IMAGE_MAX_OUTPUT_BYTES_DEFAULT;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function finalizeGenerationMetrics(
  startedAt: number,
  partial: Omit<GenerationMetrics, "totalMs"> = {}
): GenerationMetrics {
  return {
    ...partial,
    totalMs: Date.now() - startedAt,
  };
}

export function attachGenerationMetrics(
  error: unknown,
  metrics: GenerationMetrics
): unknown {
  if (error instanceof Error) {
    (error as ErrorWithGenerationMetrics).generationMetrics = metrics;
  }

  return error;
}

export function getGenerationMetrics(
  error: unknown
): GenerationMetrics | undefined {
  if (error instanceof Error) {
    return (error as ErrorWithGenerationMetrics).generationMetrics;
  }

  return undefined;
}

function isRetryableResponseStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isBudgetExceededErrorResponse(
  status: number,
  errorBody: string
): boolean {
  if (status !== 429 && status !== 400 && status !== 403) {
    return false;
  }

  const normalized = errorBody.toLowerCase();
  return (
    normalized.includes("insufficient_quota") ||
    normalized.includes("billing_hard_limit_reached") ||
    normalized.includes("budget") ||
    normalized.includes("quota")
  );
}

async function readErrorBody(response: Response): Promise<string> {
  if (typeof response.text === "function") {
    return response.text();
  }

  try {
    if (typeof response.json === "function") {
      return JSON.stringify(await response.json());
    }
  } catch {
    return "";
  }

  return "";
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error instanceof TypeError;
}

async function fetchWithTimeout(
  input: URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      redirect: init?.redirect ?? "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function buildOpenAiRequest(
  input: OpenAiRequestInput
): OpenAiRequestContext {
  const { imageGenerationModel } = getOpenAiImageModelConfig();
  const payload = buildOpenAiImageGenerationPayload({
    model: imageGenerationModel,
    prompt: input.prompt,
    sourceImage: input.hasSourceImage ? input.sourceImage : undefined,
    previousResponseId: input.previousResponseId,
  });

  return {
    endpoint: new URL(OPENAI_RESPONSES_IMAGE_ENDPOINT),
    requestInit: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  };
}

export function buildOpenAiImageGenerationPayload(input: {
  model: string;
  prompt: string;
  sourceImage?: OpenAiSourceImage;
  previousResponseId?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: input.model,
    input: input.sourceImage
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: input.prompt },
              {
                type: "input_image",
                image_url: `data:${input.sourceImage.contentType};base64,${input.sourceImage.buffer.toString("base64")}`,
              },
            ],
          },
        ]
      : input.prompt,
    tools: [
      {
        type: "image_generation",
        size: "1024x1024",
        output_format: "png",
      },
    ],
  };

  if (input.previousResponseId?.trim()) {
    payload.previous_response_id = input.previousResponseId.trim();
  }

  return payload;
}

export async function fetchOpenAiImageResponse(
  requestContext: OpenAiRequestContext,
  context: OpenAiResponseContext
): Promise<Response> {
  const openAiRetryLimit = getOpenAiRetryLimit();
  const openAiRetryBaseMs = getOpenAiRetryBaseMs();
  const openAiTimeoutMs = getOpenAiTimeoutMs();

  // TODO: unify this retry loop with sourceImageFetcher download retries once both flows can share a typed retry helper.
  for (let attempt = 0; attempt <= openAiRetryLimit; attempt += 1) {
    const openAiStartedAt = Date.now();

    try {
      console.info(
        JSON.stringify({
          level: "info",
          msg: "openai_image_request_started",
          reqId: context.reqId,
          attempt: attempt + 1,
        })
      );
      const response = await fetchWithTimeout(
        requestContext.endpoint,
        requestContext.requestInit,
        openAiTimeoutMs
      );

      context.partialMetrics.openAiMs =
        (context.partialMetrics.openAiMs ?? 0) +
        (Date.now() - openAiStartedAt);

      if (response.ok) {
        console.info(
          JSON.stringify({
            level: "info",
            msg: "openai_image_response_received",
            reqId: context.reqId,
            attempt: attempt + 1,
            status: response.status,
          })
        );
        return response;
      }

      const errorBody = await readErrorBody(response);
      if (isBudgetExceededErrorResponse(response.status, errorBody)) {
        console.error("OPENAI_BUDGET_EXCEEDED", {
          reqId: context.reqId,
          status: response.status,
          statusText: response.statusText,
          body: errorBody.slice(0, 1000),
        });
        throw attachGenerationMetrics(
          new OpenAiBudgetExceededError(
            `OpenAI budget exceeded (${response.status} ${response.statusText})`
          ),
          finalizeGenerationMetrics(context.startedAt, context.partialMetrics)
        );
      }

      if (
        attempt < openAiRetryLimit &&
        isRetryableResponseStatus(response.status)
      ) {
        const waitMs = openAiRetryBaseMs * 2 ** attempt;
        console.warn("OPENAI_GENERATION_RETRY", {
          reqId: context.reqId,
          attempt: attempt + 1,
          waitMs,
          status: response.status,
        });
        await wait(waitMs);
        continue;
      }

      console.error("OPENAI_ERROR_RESPONSE", {
        reqId: context.reqId,
        status: response.status,
        statusText: response.statusText,
        body: errorBody.slice(0, 1000),
      });
      throw attachGenerationMetrics(
        new OpenAiGenerationError(
          `OpenAI request failed (${response.status} ${response.statusText})`
        ),
        finalizeGenerationMetrics(context.startedAt, context.partialMetrics)
      );
    } catch (error) {
      context.partialMetrics.openAiMs =
        (context.partialMetrics.openAiMs ?? 0) +
        (Date.now() - openAiStartedAt);

      if (attempt < openAiRetryLimit && isTransientNetworkError(error)) {
        const waitMs = openAiRetryBaseMs * 2 ** attempt;
        console.warn("OPENAI_GENERATION_RETRY", {
          reqId: context.reqId,
          attempt: attempt + 1,
          waitMs,
          reason: (error as Error).name,
        });
        await wait(waitMs);
        continue;
      }

      throw error;
    }
  }

  throw new OpenAiGenerationError(
    "OpenAI request failed before receiving a response"
  );
}

export async function parseOpenAiImageResponse(
  response: Response,
  reqId?: string
): Promise<Buffer> {
  const startedAt = Date.now();
  const result = (await response.json()) as {
    output?: Array<{ type?: string; result?: string }>;
  };

  if (!Array.isArray(result.output) || result.output.length === 0) {
    throw new OpenAiGenerationError("OpenAI response output was empty");
  }

  const imageGenerationCall = result.output.find(
    output => output?.type === "image_generation_call"
  );
  if (!imageGenerationCall) {
    throw new OpenAiGenerationError(
      "OpenAI response did not include an image_generation_call"
    );
  }

  const base64Image = imageGenerationCall.result;
  if (!base64Image) {
    throw new OpenAiGenerationError(
      "OpenAI image_generation_call did not include base64 image data"
    );
  }

  if (!isValidBase64ImageData(base64Image)) {
    throw new OpenAiGenerationError(
      "OpenAI image_generation_call returned invalid base64 image data"
    );
  }

  const estimatedOutputBytes = estimateBase64DecodedBytes(base64Image);
  const maxOutputBytes = getOpenAiMaxOutputBytes();
  if (estimatedOutputBytes > maxOutputBytes) {
    console.warn("OPENAI_IMAGE_OUTPUT_TOO_LARGE", {
      reqId,
      estimatedOutputBytes,
      maxOutputBytes,
    });
    throw new OpenAiGenerationError(
      "OpenAI image_generation_call returned image data above the configured byte limit"
    );
  }

  const imageBufferResult = Buffer.from(base64Image, "base64");
  if (imageBufferResult.length <= 0) {
    throw new OpenAiGenerationError(
      "OpenAI response image data was empty after base64 decode"
    );
  }

  console.info(
    JSON.stringify({
      level: "info",
      msg: "openai_image_response_parsed",
      reqId,
      outputBytes: imageBufferResult.length,
      parseMs: Date.now() - startedAt,
    })
  );
  return imageBufferResult;
}

function isValidBase64ImageData(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    normalized.length % 4 !== 1 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
  );
}

function estimateBase64DecodedBytes(value: string): number {
  const normalized = value.trim();
  const padding =
    normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}
