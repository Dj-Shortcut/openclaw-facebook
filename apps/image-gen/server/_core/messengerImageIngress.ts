import { safeLog } from "./messengerApi";
import type { MessengerGenerationCompletionFence } from "./messengerGenerationCompletion";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import { toUserKey } from "./privacy";
import {
  createInboundSourceImageObjectKey,
  storeInboundSourceImage,
} from "./sourceImageStore";
import { hasObjectStorageConfig } from "./image-generation/imageServiceConfig";
import { fetchExternalSourceImageForIngress } from "./image-generation/sourceImageFetcher";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import { uploadMessengerStorageObject } from "./messengerStorageUpload";

type NormalizeMessengerInboundImageInput = {
  inboundImageUrl: string;
  psid: string;
  psidHash: string;
  reqId: string;
};

type MessengerSourceUploadScope = {
  completionFence: MessengerGenerationCompletionFence;
};

function getMessengerSourceUploadScope(
  input: NormalizeMessengerInboundImageInput
): MessengerSourceUploadScope | null {
  const ownership = getMessengerRequestOwnership();
  const subject = getMessengerRequestPrivacySubject();
  const pageId = getMessengerRequestPageId();
  if (!ownership || !subject || !pageId) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger source upload privacy scope is unavailable");
    }
    return null;
  }
  if (subject.userKey !== toUserKey(input.psid)) {
    throw new Error("Messenger source upload privacy subject changed");
  }
  const completionFence = {
    ...ownership,
    ...subject,
    pageId,
  } satisfies MessengerGenerationCompletionFence;
  return { completionFence };
}

async function ingestMessengerSourceImage(
  input: NormalizeMessengerInboundImageInput
): Promise<string> {
  const usesObjectStorage = hasObjectStorageConfig();
  const scope = usesObjectStorage ? getMessengerSourceUploadScope(input) : null;
  const downloadedImage = await fetchExternalSourceImageForIngress({
    sourceImageUrl: input.inboundImageUrl,
    reqId: input.reqId,
  });
  if (!usesObjectStorage) {
    return await storeInboundSourceImage(
      downloadedImage.buffer,
      downloadedImage.contentType,
      input.reqId
    );
  }

  if (!scope) {
    return await storeInboundSourceImage(
      downloadedImage.buffer,
      downloadedImage.contentType,
      input.reqId
    );
  }

  const objectKey = createInboundSourceImageObjectKey(
    downloadedImage.contentType,
    scope.completionFence
  );
  return await uploadMessengerStorageObject({
    objectKey,
    scope: scope.completionFence,
    reqId: input.reqId,
    providerOperation: "source_image_storage_upload",
    upload: async () =>
      await storeInboundSourceImage(
        downloadedImage.buffer,
        downloadedImage.contentType,
        input.reqId,
        objectKey
      ),
  });
}

export async function normalizeMessengerInboundImage(
  input: NormalizeMessengerInboundImageInput
): Promise<string | null> {
  try {
    return await ingestMessengerSourceImage(input);
  } catch (error) {
    safeLog("messenger_inbound_image_ingest_failed", {
      psidHash: input.psidHash,
      reqId: input.reqId,
      inboundImageUrl: summarizeSensitiveUrl(input.inboundImageUrl),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

/** Removes newly uploaded source objects when their fenced state write loses an erasure race. */
export async function cleanupNormalizedMessengerInboundImages(
  imageUrls: readonly string[]
): Promise<void> {
  const storageKeys = Array.from(
    new Set(
      imageUrls
        .map(storageKeyFromPublicUrl)
        .filter((key): key is string => Boolean(key))
    )
  );
  const results = await Promise.allSettled(
    storageKeys.map(key => storageDelete(key))
  );
  const failedCount = results.filter(
    result => result.status === "rejected"
  ).length;
  if (failedCount > 0) {
    safeLog("messenger_inbound_image_cleanup_failed", {
      failedCount,
      objectCount: storageKeys.length,
    });
    throw new Error("Messenger inbound image cleanup failed");
  }
}

type StoredMessengerImageDecisionInput = {
  lastPhotoUrl: string | null;
  storedSourceImageUrl: string;
};

export type StoredMessengerImageDecision = {
  action: "request_edit_prompt";
  hadPreviousPhoto: boolean;
  incomingImageUrl: string;
};

export function getStoredMessengerImageDecision(
  input: StoredMessengerImageDecisionInput
): StoredMessengerImageDecision {
  const hadPreviousPhoto = Boolean(input.lastPhotoUrl);

  return {
    action: "request_edit_prompt",
    hadPreviousPhoto,
    incomingImageUrl: input.storedSourceImageUrl,
  };
}
