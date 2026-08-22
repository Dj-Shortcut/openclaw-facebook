import { getOpenAiImageModelConfig } from "./imageServiceConfig";
import { safeLog } from "../logger";
import { canRetryAttempt, getExponentialRetryDelayMs } from "./retryPolicy";

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
  createRequestInit?: () => RequestInit;
  model: string;
  imageCostOptions: {
    size: string;
    quality: string;
    inputFidelity?: string;
  };
};

type OpenAiRequestInput = {
  prompt: string;
  sourceImage: OpenAiSourceImage;
  sourceImages?: OpenAiSourceImage[];
  hasSourceImage: boolean;
  previousResponseId?: string;
  model?: string;
  quality?: OpenAiImageQuality;
};

type OpenAiResponseContext = {
  reqId: string;
  startedAt: number;
  partialMetrics: Omit<GenerationMetrics, "totalMs">;
  onProviderAttempt?: () => Promise<void>;
};

const OPENAI_RETRY_LIMIT_DEFAULT = 1;
const OPENAI_RETRY_BASE_MS_DEFAULT = 500;
const OPENAI_TIMEOUT_MS_DEFAULT = 180_000;
const OPENAI_IMAGE_MAX_OUTPUT_BYTES_DEFAULT = 25 * 1024 * 1024;
const OPENAI_RESPONSES_IMAGE_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_IMAGE_GENERATIONS_ENDPOINT =
  "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_EDITS_ENDPOINT = "https://api.openai.com/v1/images/edits";
const OPENAI_IMAGE_ALLOWED_SIZES = new Set([
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "auto",
]);
const OPENAI_IMAGE_ALLOWED_QUALITIES = new Set([
  "low",
  "medium",
  "high",
  "auto",
]);
const OPENAI_IMAGE_ALLOWED_FORMATS = new Set(["png", "jpeg", "webp"]);
const OPENAI_IMAGE_ALLOWED_BACKGROUNDS = new Set([
  "opaque",
  "transparent",
  "auto",
]);
const OPENAI_IMAGE_ALLOWED_ACTIONS = new Set(["auto", "generate", "edit"]);
const OPENAI_IMAGE_ALLOWED_INPUT_FIDELITIES = new Set(["low", "high"]);

type OpenAiImageOutputFormat = "png" | "jpeg" | "webp";
export type OpenAiImageQuality = "low" | "medium" | "high" | "auto";

type ResolvedOpenAiImageOptions = {
  size: string;
  quality?: OpenAiImageQuality;
  outputFormat: OpenAiImageOutputFormat;
  background?: string;
  action?: string;
  inputFidelity?: string;
  outputCompression?: number;
};

function getOpenAiImageOutputFormat(): OpenAiImageOutputFormat {
  return readEnumEnv(
    "OPENAI_IMAGE_OUTPUT_FORMAT",
    OPENAI_IMAGE_ALLOWED_FORMATS,
    "png"
  ) as OpenAiImageOutputFormat;
}

export function getOpenAiImageOutputContentType(): string {
  const outputFormat = getOpenAiImageOutputFormat();
  return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

export function getOpenAiImageOutputExtension(): string {
  const outputFormat = getOpenAiImageOutputFormat();
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

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
  const raw = Number.parseInt(
    process.env.OPENAI_IMAGE_MAX_OUTPUT_BYTES ?? "",
    10
  );
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return OPENAI_IMAGE_MAX_OUTPUT_BYTES_DEFAULT;
}

function readEnumEnv(
  name: string,
  allowedValues: Set<string>,
  fallback?: string
): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  if (allowedValues.has(raw)) {
    return raw;
  }

  safeLog("openai_image_config_ignored", {
    level: "warn",
    name,
    value: raw,
    reason: "unsupported_value",
    allowedValues: Array.from(allowedValues),
  });
  return fallback;
}

function readCompressionEnv(): number | undefined {
  const raw = Number.parseInt(
    process.env.OPENAI_IMAGE_OUTPUT_COMPRESSION ?? "",
    10
  );
  if (Number.isFinite(raw) && raw >= 0 && raw <= 100) {
    return raw;
  }

  if (process.env.OPENAI_IMAGE_OUTPUT_COMPRESSION?.trim()) {
    safeLog("openai_image_config_ignored", {
      level: "warn",
      name: "OPENAI_IMAGE_OUTPUT_COMPRESSION",
      value: process.env.OPENAI_IMAGE_OUTPUT_COMPRESSION,
      reason: "expected_integer_0_to_100",
    });
  }

  return undefined;
}

function readRequestedQuality(
  requestedQuality?: OpenAiImageQuality
): OpenAiImageQuality | undefined {
  if (
    requestedQuality &&
    OPENAI_IMAGE_ALLOWED_QUALITIES.has(requestedQuality)
  ) {
    return requestedQuality;
  }

  if (requestedQuality) {
    safeLog("openai_image_config_ignored", {
      level: "warn",
      name: "quality",
      value: requestedQuality,
      reason: "unsupported_value",
      allowedValues: Array.from(OPENAI_IMAGE_ALLOWED_QUALITIES),
    });
  }

  return readEnumEnv("OPENAI_IMAGE_QUALITY", OPENAI_IMAGE_ALLOWED_QUALITIES) as
    OpenAiImageQuality | undefined;
}

function isGptImage2(model: string): boolean {
  return model.trim().toLowerCase() === "gpt-image-2";
}

function resolveOpenAiImageOptions(input: {
  model: string;
  quality?: OpenAiImageQuality;
}): ResolvedOpenAiImageOptions {
  const outputFormat = getOpenAiImageOutputFormat();
  const configuredBackground = readEnumEnv(
    "OPENAI_IMAGE_BACKGROUND",
    OPENAI_IMAGE_ALLOWED_BACKGROUNDS
  );
  const gptImage2 = isGptImage2(input.model);

  if (gptImage2 && configuredBackground === "transparent") {
    safeLog("openai_image_config_ignored", {
      level: "warn",
      name: "OPENAI_IMAGE_BACKGROUND",
      value: configuredBackground,
      reason: "unsupported_for_gpt_image_2",
    });
  }

  const outputCompression = readCompressionEnv();
  return {
    size: readEnumEnv(
      "OPENAI_IMAGE_SIZE",
      OPENAI_IMAGE_ALLOWED_SIZES,
      "1024x1024"
    ) as string,
    quality: readRequestedQuality(input.quality),
    outputFormat,
    ...(configuredBackground &&
    !(gptImage2 && configuredBackground === "transparent")
      ? { background: configuredBackground }
      : {}),
    ...(!gptImage2
      ? {
          action: readEnumEnv(
            "OPENAI_IMAGE_ACTION",
            OPENAI_IMAGE_ALLOWED_ACTIONS
          ),
          inputFidelity: readEnumEnv(
            "OPENAI_IMAGE_INPUT_FIDELITY",
            OPENAI_IMAGE_ALLOWED_INPUT_FIDELITIES
          ),
        }
      : {}),
    ...(outputCompression !== undefined &&
    (outputFormat === "jpeg" || outputFormat === "webp")
      ? { outputCompression }
      : {}),
  };
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

function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error instanceof TypeError;
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
  const { imageGenerationModel } = getOpenAiImageModelConfig(input.model);
  const imageOptions = resolveOpenAiImageOptions({
    model: imageGenerationModel,
    quality: input.quality,
  });

  if (isGptImage2(imageGenerationModel)) {
    return buildGptImage2Request({
      ...input,
      model: imageGenerationModel,
      imageOptions,
    });
  }

  const payload = buildOpenAiImageGenerationPayload({
    model: imageGenerationModel,
    prompt: input.prompt,
    sourceImage: input.hasSourceImage ? input.sourceImage : undefined,
    sourceImages: input.hasSourceImage ? input.sourceImages : undefined,
    previousResponseId: input.previousResponseId,
    quality: input.quality,
    resolvedOptions: imageOptions,
  });

  return {
    endpoint: new URL(OPENAI_RESPONSES_IMAGE_ENDPOINT),
    model: imageGenerationModel,
    imageCostOptions: {
      size: imageOptions.size,
      quality: imageOptions.quality ?? "auto",
      ...(imageOptions.inputFidelity
        ? { inputFidelity: imageOptions.inputFidelity }
        : {}),
    },
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

function appendImageApiOptions(
  target: FormData,
  options: ResolvedOpenAiImageOptions
): void {
  target.append("size", options.size);
  target.append("output_format", options.outputFormat);
  if (options.quality) target.append("quality", options.quality);
  if (options.background) target.append("background", options.background);
  if (options.outputCompression !== undefined) {
    target.append("output_compression", String(options.outputCompression));
  }
}

function getSourceImageFilename(contentType: string): string {
  if (contentType === "image/jpeg") return "source-image.jpg";
  if (contentType === "image/webp") return "source-image.webp";
  return "source-image.png";
}

function buildGptImage2EditFormData(input: {
  model: string;
  prompt: string;
  sourceImages: OpenAiSourceImage[];
  imageOptions: ResolvedOpenAiImageOptions;
}): FormData {
  const formData = new FormData();
  formData.append("model", input.model);
  formData.append("prompt", input.prompt);
  input.sourceImages.forEach((sourceImage, index) => {
    formData.append(
      "image[]",
      new Blob([new Uint8Array(sourceImage.buffer)], {
        type: sourceImage.contentType,
      }),
      `${index + 1}-${getSourceImageFilename(sourceImage.contentType)}`
    );
  });
  appendImageApiOptions(formData, input.imageOptions);
  return formData;
}

function buildGptImage2Request(
  input: OpenAiRequestInput & {
    model: string;
    imageOptions: ResolvedOpenAiImageOptions;
  }
): OpenAiRequestContext {
  const imageCostOptions = {
    size: input.imageOptions.size,
    quality: input.imageOptions.quality ?? "auto",
  };

  if (!input.hasSourceImage) {
    const payload: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      size: input.imageOptions.size,
      output_format: input.imageOptions.outputFormat,
    };
    if (input.imageOptions.quality) {
      payload.quality = input.imageOptions.quality;
    }
    if (input.imageOptions.background) {
      payload.background = input.imageOptions.background;
    }
    if (input.imageOptions.outputCompression !== undefined) {
      payload.output_compression = input.imageOptions.outputCompression;
    }

    return {
      endpoint: new URL(OPENAI_IMAGE_GENERATIONS_ENDPOINT),
      model: input.model,
      imageCostOptions,
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

  const createRequestInit = (): RequestInit => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: buildGptImage2EditFormData({
      model: input.model,
      prompt: input.prompt,
      sourceImages: input.sourceImages?.length
        ? input.sourceImages
        : [input.sourceImage],
      imageOptions: input.imageOptions,
    }),
  });

  return {
    endpoint: new URL(OPENAI_IMAGE_EDITS_ENDPOINT),
    model: input.model,
    imageCostOptions,
    requestInit: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    },
    // Each retry gets a fresh multipart body rather than reusing a consumed body.
    createRequestInit,
  };
}

export function buildOpenAiImageGenerationPayload(input: {
  model: string;
  prompt: string;
  sourceImage?: OpenAiSourceImage;
  sourceImages?: OpenAiSourceImage[];
  previousResponseId?: string;
  quality?: OpenAiImageQuality;
  resolvedOptions?: ResolvedOpenAiImageOptions;
}): Record<string, unknown> {
  const imageOptions =
    input.resolvedOptions ??
    resolveOpenAiImageOptions({ model: input.model, quality: input.quality });
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    size: imageOptions.size,
    output_format: imageOptions.outputFormat,
  };

  if (imageOptions.quality) {
    imageTool.quality = imageOptions.quality;
  }

  if (imageOptions.background) {
    imageTool.background = imageOptions.background;
  }

  if (imageOptions.action) {
    imageTool.action = imageOptions.action;
  }

  if (imageOptions.inputFidelity) {
    imageTool.input_fidelity = imageOptions.inputFidelity;
  }

  if (imageOptions.outputCompression !== undefined) {
    imageTool.output_compression = imageOptions.outputCompression;
  }

  const sourceImages = input.sourceImages?.length
    ? input.sourceImages
    : input.sourceImage
      ? [input.sourceImage]
      : [];
  const payload: Record<string, unknown> = {
    model: input.model,
    input: sourceImages.length
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: input.prompt },
              ...sourceImages.map(sourceImage => ({
                type: "input_image",
                image_url: `data:${sourceImage.contentType};base64,${sourceImage.buffer.toString("base64")}`,
              })),
            ],
          },
        ]
      : input.prompt,
    tools: [imageTool],
    tool_choice: { type: "image_generation" },
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

  for (let attempt = 0; attempt <= openAiRetryLimit; attempt += 1) {
    const openAiStartedAt = Date.now();

    try {
      safeLog("openai_image_request_started", {
        reqId: context.reqId,
        attempt: attempt + 1,
      });
      await context.onProviderAttempt?.();
      const response = await fetchWithTimeout(
        requestContext.endpoint,
        requestContext.createRequestInit?.() ?? requestContext.requestInit,
        openAiTimeoutMs
      );

      context.partialMetrics.openAiMs =
        (context.partialMetrics.openAiMs ?? 0) + (Date.now() - openAiStartedAt);

      if (response.ok) {
        safeLog("openai_image_response_received", {
          reqId: context.reqId,
          attempt: attempt + 1,
          status: response.status,
        });
        return response;
      }

      const errorBody = await readErrorBody(response);
      if (isBudgetExceededErrorResponse(response.status, errorBody)) {
        safeLog("openai_budget_exceeded", {
          level: "error",
          reqId: context.reqId,
          status: response.status,
          statusText: response.statusText,
        });
        throw attachGenerationMetrics(
          new OpenAiBudgetExceededError(
            `OpenAI budget exceeded (${response.status} ${response.statusText})`
          ),
          finalizeGenerationMetrics(context.startedAt, context.partialMetrics)
        );
      }

      if (
        canRetryAttempt({
          attempt,
          maxRetries: openAiRetryLimit,
          retryable: isRetryableResponseStatus(response.status),
        })
      ) {
        const waitMs = getExponentialRetryDelayMs(openAiRetryBaseMs, attempt);
        safeLog("openai_generation_retry", {
          level: "warn",
          reqId: context.reqId,
          attempt: attempt + 1,
          waitMs,
          status: response.status,
        });
        await wait(waitMs);
        continue;
      }

      safeLog("openai_error_response", {
        level: "error",
        reqId: context.reqId,
        status: response.status,
        statusText: response.statusText,
      });
      throw attachGenerationMetrics(
        new OpenAiGenerationError(
          `OpenAI request failed (${response.status} ${response.statusText})`
        ),
        finalizeGenerationMetrics(context.startedAt, context.partialMetrics)
      );
    } catch (error) {
      context.partialMetrics.openAiMs =
        (context.partialMetrics.openAiMs ?? 0) + (Date.now() - openAiStartedAt);

      if (
        canRetryAttempt({
          attempt,
          maxRetries: openAiRetryLimit,
          retryable: isRetryableNetworkError(error),
        })
      ) {
        const waitMs = getExponentialRetryDelayMs(openAiRetryBaseMs, attempt);
        safeLog("openai_generation_retry", {
          level: "warn",
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
    data?: Array<{
      b64_json?: string;
    }>;
    output?: Array<{
      type?: string;
      result?: string;
      content?: Array<{ type?: string }>;
    }>;
  };

  let base64Image: string | undefined;
  let responseKind: "image_api" | "responses_api";
  if (Array.isArray(result.data)) {
    if (result.data.length === 0) {
      throw new OpenAiGenerationError(
        "OpenAI Image API response data was empty"
      );
    }
    base64Image = result.data.find(image => image?.b64_json)?.b64_json;
    responseKind = "image_api";
    if (!base64Image) {
      throw new OpenAiGenerationError(
        "OpenAI Image API response did not include base64 image data"
      );
    }
  } else {
    if (!Array.isArray(result.output) || result.output.length === 0) {
      throw new OpenAiGenerationError("OpenAI response output was empty");
    }

    const imageGenerationCall = result.output.find(
      output => output?.type === "image_generation_call"
    );
    if (!imageGenerationCall) {
      safeLog("openai_image_response_missing_generation_call", {
        level: "warn",
        reqId,
        outputTypes: result.output.map(output => output?.type ?? "unknown"),
        contentTypes: result.output.flatMap(output =>
          Array.isArray(output?.content)
            ? output.content.map(content => content?.type ?? "unknown")
            : []
        ),
      });
      throw new OpenAiGenerationError(
        "OpenAI response did not include an image_generation_call"
      );
    }

    base64Image = imageGenerationCall.result;
    responseKind = "responses_api";
    if (!base64Image) {
      throw new OpenAiGenerationError(
        "OpenAI image_generation_call did not include base64 image data"
      );
    }
  }

  if (!isValidBase64ImageData(base64Image)) {
    throw new OpenAiGenerationError(
      responseKind === "image_api"
        ? "OpenAI Image API returned invalid base64 image data"
        : "OpenAI image_generation_call returned invalid base64 image data"
    );
  }

  const estimatedOutputBytes = estimateBase64DecodedBytes(base64Image);
  const maxOutputBytes = getOpenAiMaxOutputBytes();
  if (estimatedOutputBytes > maxOutputBytes) {
    safeLog("openai_image_output_too_large", {
      level: "warn",
      reqId,
      estimatedOutputBytes,
      maxOutputBytes,
    });
    throw new OpenAiGenerationError(
      responseKind === "image_api"
        ? "OpenAI Image API returned image data above the configured byte limit"
        : "OpenAI image_generation_call returned image data above the configured byte limit"
    );
  }

  const imageBufferResult = Buffer.from(base64Image, "base64");
  if (imageBufferResult.length <= 0) {
    throw new OpenAiGenerationError(
      "OpenAI response image data was empty after base64 decode"
    );
  }

  safeLog("openai_image_response_parsed", {
    reqId,
    outputBytes: imageBufferResult.length,
    parseMs: Date.now() - startedAt,
  });
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
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}
