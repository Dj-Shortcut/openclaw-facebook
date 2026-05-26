import { randomUUID } from "node:crypto";
import {
  buildGeneratedImageUrl,
  putGeneratedImage,
} from "./generatedImageStore";
import { fetchExternalSourceImageForIngress } from "./image-generation/sourceImageFetcher";
import { storagePut } from "../storage";

export type StoredSourceImage = {
  url: string;
  origin: "stored";
};

function getConfiguredBaseUrl(): string | undefined {
  const configuredBaseUrl =
    process.env.APP_BASE_URL?.trim() ?? process.env.BASE_URL?.trim();

  if (!configuredBaseUrl || !/^https?:\/\//.test(configuredBaseUrl)) {
    return undefined;
  }

  if (
    process.env.NODE_ENV === "production" &&
    !configuredBaseUrl.startsWith("https://")
  ) {
    return undefined;
  }

  return configuredBaseUrl.replace(/\/$/, "");
}

function hasObjectStorageConfig(): boolean {
  return Boolean(
    process.env.BUILT_IN_FORGE_API_URL?.trim() &&
      process.env.BUILT_IN_FORGE_API_KEY?.trim()
  );
}

function buildExtension(contentType: string): string {
  if (contentType.includes("png")) {
    return "png";
  }

  if (contentType.includes("webp")) {
    return "webp";
  }

  return "jpg";
}

export async function storeInboundSourceImage(
  buffer: Buffer,
  contentType: string,
  _reqId: string
): Promise<string> {
  if (hasObjectStorageConfig()) {
    const key = `inbound-source/${Date.now()}-${randomUUID()}.${buildExtension(
      contentType
    )}`;
    const { url } = await storagePut(key, buffer, contentType);
    return url;
  }

  const publicBaseUrl = getConfiguredBaseUrl();
  if (!publicBaseUrl) {
    throw new Error("APP_BASE_URL is missing or invalid");
  }

  const token = putGeneratedImage(buffer, contentType);
  return buildGeneratedImageUrl(publicBaseUrl, token);
}

export async function ingestExternalSourceImage(
  sourceImageUrl: string,
  reqId: string
): Promise<StoredSourceImage> {
  const downloadedImage = await fetchExternalSourceImageForIngress({
    sourceImageUrl,
    reqId,
  });
  const storedImageUrl = await storeInboundSourceImage(
    downloadedImage.buffer,
    downloadedImage.contentType,
    reqId
  );

  return {
    url: storedImageUrl,
    origin: "stored",
  };
}
