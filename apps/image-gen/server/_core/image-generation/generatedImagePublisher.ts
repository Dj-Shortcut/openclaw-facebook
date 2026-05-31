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
      console.info(
        JSON.stringify({
          level: "info",
          msg: "generated_image_upload_success",
          reqId,
          contentType,
          storageKey: key,
          publicUrl: summarizeSensitiveUrl(url),
        })
      );
      return url;
    } catch (error) {
      console.error("GENERATED_IMAGE_UPLOAD_FAILED", {
        reqId,
        storageKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  assertProductionImageStorageConfig();

  const token = putGeneratedImage(imageBuffer, contentType);
  const publicBaseUrl = getRequiredPublicBaseUrl();
  const localUrl = buildGeneratedImageUrl(publicBaseUrl, token, extension);
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "generated_image_local_fallback",
      reqId,
      contentType,
      tokenHash: hashGeneratedImageToken(token),
      publicUrl: summarizeSensitiveUrl(localUrl),
    })
  );
  return localUrl;
}
