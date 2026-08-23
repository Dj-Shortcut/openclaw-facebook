import { storageDelete } from "../storage";
import {
  registerMessengerObjectForPrivacyCleanup,
  unregisterMessengerObjectFromPrivacyCleanup,
  type MessengerGenerationCompletionFence,
} from "./messengerGenerationCompletion";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";
import {
  messengerStorageObjectMatchesScope,
  type MessengerStorageRequestScope,
} from "./messengerStorageObject";

async function finalizeBestEffort(
  fence: MessengerProviderAttemptFence,
  outcome: "known_failed" | "succeeded" | "ambiguous"
): Promise<void> {
  await finalizeMessengerProviderAttemptFence(fence, outcome).catch(
    () => undefined
  );
}

function completionFenceFromScope(
  scope: MessengerStorageRequestScope
): MessengerGenerationCompletionFence {
  return {
    workspaceId: scope.workspaceId,
    channelConnectionId: scope.channelConnectionId,
    bindingEpoch: scope.bindingEpoch,
    privacyEpoch: scope.privacyEpoch,
    userKey: scope.userKey,
    pageId: scope.pageId,
  };
}

function providerJobFromScope(input: {
  scope: MessengerStorageRequestScope;
  reqId: string;
}): MessengerGenerationJob {
  return {
    psid: "",
    userId: input.scope.userKey,
    pageId: input.scope.pageId,
    workspaceId: input.scope.workspaceId,
    channelConnectionId: input.scope.channelConnectionId,
    bindingEpoch: input.scope.bindingEpoch,
    privacyEpoch: input.scope.privacyEpoch,
    reqId: input.reqId,
    lang: "nl",
  };
}

/**
 * Publishes one Messenger object without ever opening an untracked PUT window.
 *
 * The exact key enters the durable privacy inventory before the provider call
 * is marked started. A timeout stays inventoried and provider-fenced because a
 * remote PUT can still commit after the local request has become terminal.
 */
export async function uploadMessengerStorageObject<T>(input: {
  objectKey: string;
  scope: MessengerStorageRequestScope;
  reqId: string;
  providerOperation:
    | "source_image_storage_upload"
    | "generated_image_storage_upload"
    | "generated_video_storage_upload";
  upload: () => Promise<T>;
}): Promise<T> {
  if (!messengerStorageObjectMatchesScope(input.objectKey, input.scope)) {
    throw new Error("Messenger storage object does not match its tenant scope");
  }
  const completionFence = completionFenceFromScope(input.scope);
  const providerFence = await reserveMessengerProviderAttemptFence(
    providerJobFromScope(input),
    input.providerOperation,
    1
  );
  let inventoried = false;
  try {
    inventoried = await registerMessengerObjectForPrivacyCleanup(
      input.objectKey,
      completionFence
    );
    if (!inventoried) {
      throw new Error("Messenger storage upload subject is erased");
    }
    await markMessengerProviderAttemptStarted(providerFence);
  } catch (error) {
    if (inventoried) {
      await unregisterMessengerObjectFromPrivacyCleanup(
        input.objectKey,
        completionFence
      ).catch(() => undefined);
    }
    await finalizeBestEffort(providerFence, "known_failed");
    throw error;
  }

  let result: T;
  try {
    result = await input.upload();
  } catch (error) {
    // Never remove the inventory here. The remote PUT may commit after a
    // timeout even when this best-effort DELETE returns first.
    await storageDelete(input.objectKey).catch(() => undefined);
    await finalizeBestEffort(providerFence, "ambiguous");
    throw error;
  }

  try {
    await finalizeMessengerProviderAttemptFence(providerFence, "succeeded");
  } catch (error) {
    // The PUT is known to have returned. A confirmed DELETE can therefore
    // close the object window; otherwise inventory and the fence stay intact.
    try {
      await storageDelete(input.objectKey);
      await unregisterMessengerObjectFromPrivacyCleanup(
        input.objectKey,
        completionFence
      );
      await finalizeBestEffort(providerFence, "known_failed");
    } catch {
      await finalizeBestEffort(providerFence, "ambiguous");
    }
    throw error;
  }

  return result;
}
