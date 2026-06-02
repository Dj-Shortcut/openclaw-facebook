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

export async function publishGeneratedImage(
  imageBuffer: Buffer,
  reqId?: string
): Promise<string> {
  const contentType = getOpenAiImageOutputContentType();
  const extension = getOpenAiImageOutputExtension();

  if (hasObjectStorageConfig()) {
    const key = `generated/images/${Date.now()}-${randomUUID()}.${extension}`;
    try {
      const { url } = await storagePut(key, imageBuffer, contentType);
      safeLog("generated_image_upload_success", {
        reqId,
        contentType,
        storageKey: key,
        publicUrl: summarizeSensitiveUrl(url),
      });
      return url;
    } catch (error) {
      safeLog("generated_image_upload_failed", {
        level: "error",
        reqId,
        storageKey: key,
        error,
      });
      throw error;
    }
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
