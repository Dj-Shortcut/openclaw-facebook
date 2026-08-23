import {
  MissingAppBaseUrlError,
  MissingObjectStorageConfigError,
} from "./imageServiceErrors";
import { safeLog } from "../logger";

type OpenAiImageModelConfig = {
  imageGenerationModel: string;
};

const DEFAULT_OPENAI_IMAGE_GENERATION_MODEL = "gpt-5";

export function getOpenAiImageModelConfig(
  requestModel?: string
): OpenAiImageModelConfig {
  const imageGenerationModel =
    requestModel?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim();

  return {
    imageGenerationModel:
      imageGenerationModel && imageGenerationModel.length > 0
        ? imageGenerationModel
        : DEFAULT_OPENAI_IMAGE_GENERATION_MODEL,
  };
}

export function getConfiguredBaseUrl(): string | undefined {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim()
    ? process.env.APP_BASE_URL.trim()
    : process.env.BASE_URL?.trim();

  if (!configuredBaseUrl || !/^https?:\/\//.test(configuredBaseUrl)) {
    return undefined;
  }

  if (
    process.env.NODE_ENV === "production" &&
    !configuredBaseUrl.startsWith("https://")
  ) {
    safeLog("configured_base_url_insecure_in_production", {
      level: "error",
      hasConfiguredBaseUrl: true,
      protocol: configuredBaseUrl.split(":")[0],
    });
    return undefined;
  }

  return configuredBaseUrl.replace(/\/$/, "");
}

export function getRequiredPublicBaseUrl(): string {
  const baseUrl = getConfiguredBaseUrl();
  if (!baseUrl) {
    safeLog("app_base_url_required_for_image_generation", { level: "error" });
    throw new MissingAppBaseUrlError("APP_BASE_URL is missing or invalid");
  }

  return baseUrl;
}

export function hasObjectStorageConfig(): boolean {
  return Boolean(
    process.env.BUILT_IN_FORGE_API_URL?.trim() &&
    process.env.BUILT_IN_FORGE_API_KEY?.trim()
  );
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

export function assertProductionImageStorageConfig(): void {
  if (!isProductionRuntime()) {
    return;
  }

  if (!hasObjectStorageConfig()) {
    throw new MissingObjectStorageConfigError(
      "BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY are required in production for durable generated image storage"
    );
  }

  const trustedPublicOrigins = [
    ...(process.env.STORAGE_PUBLIC_BASE_URLS ?? "").split(","),
    process.env.PUBLIC_BASE_URL ?? "",
  ]
    .map(value => value.trim())
    .filter(Boolean);
  const hasValidTrustedOrigin = trustedPublicOrigins.some(value => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  });
  if (!hasValidTrustedOrigin) {
    throw new MissingObjectStorageConfigError(
      "PUBLIC_BASE_URL or STORAGE_PUBLIC_BASE_URLS must contain a trusted HTTPS storage origin in production"
    );
  }
}
