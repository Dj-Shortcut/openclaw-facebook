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
import {
  buildMessengerStorageObjectKey,
  getMessengerStorageRequestScope,
  hashStorageObjectKeyForLog,
} from "../messengerStorageObject";
import { uploadMessengerStorageObject } from "../messengerStorageUpload";

export async function publishGeneratedImage(
  imageBuffer: Buffer,
  reqId?: string
): Promise<string> {
  const contentType = getOpenAiImageOutputContentType();
  const extension = getOpenAiImageOutputExtension();

  if (hasObjectStorageConfig()) {
    const requestScope = getMessengerStorageRequestScope();
    const fileName = `${Date.now()}-${randomUUID()}.${extension}`;
    if (
      !requestScope &&
      process.env.NODE_ENV === "production" &&
      process.env.STORAGE_ALLOW_LEGACY_KEYS !== "true"
    ) {
      throw new Error("Tenant-scoped generated image storage is required");
    }
    const key = requestScope
      ? buildMessengerStorageObjectKey({
          kind: "generated_image",
          scope: requestScope,
          fileName,
        })
      : `generated/images/${fileName}`;
    try {
      const upload = async () =>
        await storagePut(key, imageBuffer, contentType);
      const { url } = requestScope
        ? await uploadMessengerStorageObject({
            objectKey: key,
            scope: requestScope,
            reqId: reqId?.trim() || randomUUID(),
            providerOperation: "generated_image_storage_upload",
            upload,
          })
        : await upload();
      safeLog("generated_image_upload_success", {
        reqId,
        contentType,
        objectKeyHash: hashStorageObjectKeyForLog(key),
        publicUrl: summarizeSensitiveUrl(url),
      });
      return url;
    } catch (error) {
      safeLog("generated_image_upload_failed", {
        level: "error",
        reqId,
        objectKeyHash: hashStorageObjectKeyForLog(key),
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
