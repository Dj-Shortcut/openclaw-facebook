import { getOpenAiImageModelConfig } from "./imageServiceConfig";

class OpenAiGenerationError extends Error {}
export class OpenAiBudgetExceededError extends Error {}

export type GenerationMetrics = {
  fbImageFetchMs?: number;
  openAiMs?: number;
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
};

type OpenAiResponseContext = {
  reqId: string;
  startedAt: number;
  partialMetrics: Omit<GenerationMetrics, "totalMs">;
};

const OPENAI_RETRY_LIMIT_DEFAULT = 1;
const OPENAI_RETRY_BASE_MS_DEFAULT = 500;
const OPENAI_TIMEOUT_MS_DEFAULT = 45_000;

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

  if (input.hasSourceImage) {
    const formData = new FormData();
    formData.set("model", imageGenerationModel);
    formData.set("prompt", input.prompt);
    formData.set("size", "1024x1024");
    formData.set("output_format", "jpeg");
    formData.set(
      "image",
      new Blob([new Uint8Array(input.sourceImage.buffer)], {
        type: input.sourceImage.contentType,
      }),
      "source-image"
    );

    return {
      endpoint: new URL("https://api.openai.com/v1/images/edits"),
      requestInit: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      },
    };
  }

  return {
    endpoint: new URL("https://api.openai.com/v1/images/generations"),
    requestInit: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: imageGenerationModel,
        prompt: input.prompt,
        size: "1024x1024",
        output_format: "jpeg",
      }),
    },
  };
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
      const response = await fetchWithTimeout(
        requestContext.endpoint,
        requestContext.requestInit,
        openAiTimeoutMs
      );

      context.partialMetrics.openAiMs =
        (context.partialMetrics.openAiMs ?? 0) +
        (Date.now() - openAiStartedAt);

      if (response.ok) {
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

export async function parseOpenAiImageResponse(response: Response): Promise<Buffer> {
  const result = (await response.json()) as {
    data?: Array<{ b64_json?: string }>;
  };
  const base64Image = result.data?.[0]?.b64_json;

  if (!base64Image) {
    throw new OpenAiGenerationError(
      "OpenAI response did not include base64 image data"
    );
  }

  const imageBufferResult = Buffer.from(base64Image, "base64");
  if (imageBufferResult.length <= 0) {
    throw new OpenAiGenerationError(
      "OpenAI response image data was empty after base64 decode"
    );
  }

  return imageBufferResult;
}
