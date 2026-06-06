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

function readUsdEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
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
  const payload = typeof body === "string" ? JSON.parse(body) : body;
  const imageTool = findImageGenerationTool(payload);

  return {
    size: readString(imageTool?.size) ?? DEFAULT_OPENAI_IMAGE_SIZE,
    quality: readString(imageTool?.quality) ?? DEFAULT_OPENAI_IMAGE_QUALITY,
    inputFidelity: readString(imageTool?.input_fidelity),
  };
}

function estimateOutputImageCost(input: {
  pricingModel: string;
  size: string;
  quality: string;
  override?: number;
}): number | undefined {
  if (input.override !== undefined) {
    return input.override;
  }

  return input.pricingModel.toLowerCase() === "gpt-image-1"
    ? GPT_IMAGE_1_PER_IMAGE_USD[input.quality]?.[input.size]
    : undefined;
}

export function estimateOpenAiImageRequestCost(input: {
  model: string;
  pricingModel?: string;
  size: string;
  quality: string;
  inputFidelity?: string;
  hasSourceImage?: boolean;
}): ImageCostEstimate {
  const pricingModel =
    input.pricingModel?.trim() || DEFAULT_OPENAI_IMAGE_PRICING_MODEL;
  const override = readUsdEnv("OPENAI_IMAGE_ESTIMATED_COST_USD");
  const outputEstimate = estimateOutputImageCost({
    pricingModel,
    size: input.size,
    quality: input.quality,
    override,
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
      outputEstimate === undefined ? "unpriced" : "gpt_image_1_table",
  };
}
