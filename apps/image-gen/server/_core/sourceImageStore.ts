import { randomUUID } from "node:crypto";
import {
  buildGeneratedImageUrl,
  putGeneratedImage,
} from "./generatedImageStore";
import {
  assertProductionImageStorageConfig,
  getRequiredPublicBaseUrl,
  hasObjectStorageConfig,
} from "./image-generation/imageServiceConfig";
import { fetchExternalSourceImageForIngress } from "./image-generation/sourceImageFetcher";
import { storagePut } from "../storage";
import {
  buildMessengerStorageObjectKey,
  type MessengerStorageScope,
} from "./messengerStorageObject";

export type StoredSourceImage = {
  url: string;
  origin: "stored";
};

function buildExtension(contentType: string): string {
  if (contentType.includes("png")) {
    return "png";
  }

  if (contentType.includes("webp")) {
    return "webp";
  }

  return "jpg";
}

export function createInboundSourceImageObjectKey(
  contentType: string,
  scope?: MessengerStorageScope
): string {
  const fileName = `${Date.now()}-${randomUUID()}.${buildExtension(contentType)}`;
  if (scope) {
    return buildMessengerStorageObjectKey({
      kind: "inbound_source",
      scope,
      fileName,
    });
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.STORAGE_ALLOW_LEGACY_KEYS !== "true"
  ) {
    throw new Error("Tenant-scoped inbound source storage is required");
  }
  return `inbound-source/${fileName}`;
}

export async function storeInboundSourceImage(
  buffer: Buffer,
  contentType: string,
  _reqId: string,
  objectKey?: string
): Promise<string> {
  if (hasObjectStorageConfig()) {
    const key = objectKey ?? createInboundSourceImageObjectKey(contentType);
    const { url } = await storagePut(key, buffer, contentType);
    return url;
  }

  assertProductionImageStorageConfig();

  const publicBaseUrl = getRequiredPublicBaseUrl();
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
