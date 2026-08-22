import { randomUUID } from "node:crypto";
import { storagePut } from "../../storage";
import {
  buildGeneratedImageUrl,
  hashGeneratedImageToken,
  putGeneratedImage,
} from "../generatedImageStore";
import {
  assertProductionImageStorageConfig,
  getRequiredPublicBaseUrl,
  hasObjectStorageConfig,
} from "./imageServiceConfig";
import {
  getOpenAiImageOutputContentType,
  getOpenAiImageOutputExtension,
} from "./openAiImageClient";
import { summarizeSensitiveUrl } from "../utils/urlSummarizer";
import { safeLog } from "../logger";

export type GeneratedImagePublishHooks = Readonly<{
  beforeStore: (objectKey: string) => Promise<void>;
  afterStoreSuccess?: (objectKey: string, imageUrl: string) => Promise<void>;
  afterStoreFailure: (objectKey: string) => Promise<void>;
}>;

export async function publishGeneratedImage(
  imageBuffer: Buffer,
  reqId?: string,
  hooks?: GeneratedImagePublishHooks
): Promise<string> {
  const contentType = getOpenAiImageOutputContentType();
  const extension = getOpenAiImageOutputExtension();

  if (hasObjectStorageConfig()) {
    const key = `generated/images/${Date.now()}-${randomUUID()}.${extension}`;
    await hooks?.beforeStore(key);
    let stored: { url: string };
    try {
      stored = await storagePut(key, imageBuffer, contentType);
    } catch (error) {
      try {
        await hooks?.afterStoreFailure(key);
      } catch (inventoryError) {
        throw new AggregateError(
          [error, inventoryError],
          "Generated image upload and inventory release failed",
          { cause: error }
        );
      }
      safeLog("generated_image_upload_failed", {
        level: "error",
        reqId,
        storageKey: key,
        error,
      });
      throw error;
    }
    await hooks?.afterStoreSuccess?.(key, stored.url);
    safeLog("generated_image_upload_success", {
      reqId,
      contentType,
      storageKey: key,
      publicUrl: summarizeSensitiveUrl(stored.url),
    });
    return stored.url;
  }

  assertProductionImageStorageConfig();

  const token = putGeneratedImage(imageBuffer, contentType);
  const publicBaseUrl = getRequiredPublicBaseUrl();
  const localUrl = buildGeneratedImageUrl(publicBaseUrl, token, extension);
  safeLog("generated_image_local_fallback", {
    level: "warn",
    reqId,
    contentType,
    tokenHash: hashGeneratedImageToken(token),
    publicUrl: summarizeSensitiveUrl(localUrl),
  });
  return localUrl;
}
