import { randomUUID } from "node:crypto";
import type { Style } from "../messengerStyles";
import { storagePut } from "../../storage";
import {
  buildGeneratedImageUrl,
  putGeneratedImage,
} from "../generatedImageStore";
import {
  assertProductionImageStorageConfig,
  getRequiredPublicBaseUrl,
  hasObjectStorageConfig,
} from "./imageServiceConfig";
import { summarizeSensitiveUrl } from "../utils/urlSummarizer";

export async function publishGeneratedImage(
  imageBuffer: Buffer,
  style: Style,
  reqId?: string
): Promise<string> {
  if (hasObjectStorageConfig()) {
    const key = `generated/${style}/${Date.now()}-${randomUUID()}.png`;
    try {
      const { url } = await storagePut(key, imageBuffer, "image/png");
      console.info(
        JSON.stringify({
          level: "info",
          msg: "generated_image_upload_success",
          reqId,
          style,
          storageKey: key,
          publicUrl: summarizeSensitiveUrl(url),
        })
      );
      return url;
    } catch (error) {
      console.error("GENERATED_IMAGE_UPLOAD_FAILED", {
        reqId,
        style,
        storageKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  assertProductionImageStorageConfig();

  const token = putGeneratedImage(imageBuffer, "image/png");
  const publicBaseUrl = getRequiredPublicBaseUrl();
  const localUrl = buildGeneratedImageUrl(publicBaseUrl, token);
  console.warn("GENERATED_IMAGE_LOCAL_FALLBACK", {
    reqId,
    style,
    token,
    publicUrl: summarizeSensitiveUrl(localUrl),
  });
  return localUrl;
}
