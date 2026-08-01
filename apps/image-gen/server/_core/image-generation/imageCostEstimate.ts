type ImageCostEstimate = {
  model: string;
  pricingModel: string;
  size: string;
  quality: string;
  inputFidelity?: string;
  estimatedCostUsd?: number;
  estimatedOutputCostUsd?: number;
  costEstimateComplete: boolean;
  unpricedCostComponents?: Array<"output_image" | "source_image_input">;
  estimateSource:
    | "env_override"
    | "gpt_image_2_table"
    | "gpt_image_1_table"
    | "partial_source_image_input_unpriced"
    | "unpriced";
};

const DEFAULT_OPENAI_IMAGE_SIZE = "1024x1024";
const DEFAULT_OPENAI_IMAGE_QUALITY = "auto";
const DEFAULT_OPENAI_IMAGE_PRICING_MODEL = "gpt-image-1";

const GPT_IMAGE_1_PER_IMAGE_USD: Record<string, Record<string, number>> = {
  low: {
    "1024x1024": 0.011,
    "1024x1536": 0.016,
    "1536x1024": 0.016,
  },
  medium: {
    "1024x1024": 0.042,
    "1024x1536": 0.063,
    "1536x1024": 0.063,
  },
  high: {
    "1024x1024": 0.167,
    "1024x1536": 0.25,
    "1536x1024": 0.25,
  },
};

// Output-only estimates from OpenAI's GPT Image 2 calculator for the three
// resolutions supported by this service. Prompt and source-image input tokens
// remain separate cost components.
const GPT_IMAGE_2_PER_IMAGE_USD: Record<string, Record<string, number>> = {
  low: {
    "1024x1024": 0.006,
    "1024x1536": 0.005,
    "1536x1024": 0.005,
  },
  medium: {
    "1024x1024": 0.053,
    "1024x1536": 0.041,
    "1536x1024": 0.041,
  },
  high: {
    "1024x1024": 0.211,
    "1024x1536": 0.165,
    "1536x1024": 0.165,
  },
};

function readUsdEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findImageGenerationTool(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const tools = (payload as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return null;
  }

  return (
    tools.find(
      tool =>
        Boolean(tool && typeof tool === "object") &&
        (tool as { type?: unknown }).type === "image_generation"
    ) as Record<string, unknown> | undefined
  ) ?? null;
}

export function readOpenAiImageCostOptionsFromRequestBody(body: unknown): {
  size: string;
  quality: string;
  inputFidelity?: string;
} {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const inputFidelity = readString(body.get("input_fidelity"));
    return {
      size: readString(body.get("size")) ?? DEFAULT_OPENAI_IMAGE_SIZE,
      quality:
        readString(body.get("quality")) ?? DEFAULT_OPENAI_IMAGE_QUALITY,
      ...(inputFidelity ? { inputFidelity } : {}),
    };
  }

  const payload: unknown =
    typeof body === "string" ? (JSON.parse(body) as unknown) : body;
  const imageTool = findImageGenerationTool(payload);
  const directImagePayload =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;

  return {
    size:
      readString(imageTool?.size) ??
      readString(directImagePayload?.size) ??
      DEFAULT_OPENAI_IMAGE_SIZE,
    quality:
      readString(imageTool?.quality) ??
      readString(directImagePayload?.quality) ??
      DEFAULT_OPENAI_IMAGE_QUALITY,
    inputFidelity:
      readString(imageTool?.input_fidelity) ??
      readString(directImagePayload?.input_fidelity),
  };
}

function estimateOutputImageCost(input: {
  pricingModel: string;
  size: string;
  quality: string;
}): number | undefined {
  const pricingTable =
    input.pricingModel.toLowerCase() === "gpt-image-2"
      ? GPT_IMAGE_2_PER_IMAGE_USD
      : input.pricingModel.toLowerCase() === "gpt-image-1"
        ? GPT_IMAGE_1_PER_IMAGE_USD
        : undefined;
  return pricingTable?.[input.quality]?.[input.size];
}

function resolvePricingModel(input: {
  model: string;
  pricingModel?: string;
}): string {
  const explicitPricingModel = input.pricingModel?.trim();
  if (explicitPricingModel) return explicitPricingModel;

  const normalizedModel = input.model.trim().toLowerCase();
  return normalizedModel === "gpt-image-2" || normalizedModel === "gpt-image-1"
    ? normalizedModel
    : DEFAULT_OPENAI_IMAGE_PRICING_MODEL;
}

export function estimateOpenAiImageRequestCost(input: {
  model: string;
  pricingModel?: string;
  size: string;
  quality: string;
  inputFidelity?: string;
  hasSourceImage?: boolean;
}): ImageCostEstimate {
  const pricingModel = resolvePricingModel(input);
  const override = readUsdEnv("OPENAI_IMAGE_ESTIMATED_COST_USD");

  // This operator-supplied value is the conservative total for one provider
  // attempt. It must cover prompt, source-image input and image output costs,
  // regardless of whether the request is a generation or an edit.
  if (override !== undefined) {
    return {
      model: input.model,
      pricingModel,
      size: input.size,
      quality: input.quality,
      ...(input.inputFidelity ? { inputFidelity: input.inputFidelity } : {}),
      estimatedCostUsd: override,
      costEstimateComplete: true,
      estimateSource: "env_override",
    };
  }

  const outputEstimate = estimateOutputImageCost({
    pricingModel,
    size: input.size,
    quality: input.quality,
  });

  if (input.hasSourceImage) {
    return {
      model: input.model,
      pricingModel,
      size: input.size,
      quality: input.quality,
      ...(input.inputFidelity ? { inputFidelity: input.inputFidelity } : {}),
      estimatedCostUsd: undefined,
      ...(outputEstimate !== undefined
        ? { estimatedOutputCostUsd: outputEstimate }
        : {}),
      costEstimateComplete: false,
      unpricedCostComponents: ["source_image_input"],
      estimateSource: "partial_source_image_input_unpriced",
    };
  }

  return {
    model: input.model,
    pricingModel,
    size: input.size,
    quality: input.quality,
    ...(input.inputFidelity ? { inputFidelity: input.inputFidelity } : {}),
    estimatedCostUsd: outputEstimate,
    costEstimateComplete: outputEstimate !== undefined,
    ...(outputEstimate === undefined
      ? { unpricedCostComponents: ["output_image" as const] }
      : {}),
    estimateSource:
      outputEstimate === undefined
        ? "unpriced"
        : pricingModel.toLowerCase() === "gpt-image-2"
          ? "gpt_image_2_table"
          : "gpt_image_1_table",
  };
}
