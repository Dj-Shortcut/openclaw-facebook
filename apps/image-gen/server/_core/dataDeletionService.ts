import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import { deleteFaceMemoryForUser } from "./faceMemory";
import { safeLog } from "./messengerApi";
import { deleteScopedState } from "./stateStore";
import {
  clearUserState,
  getState,
  type MessengerUserState,
} from "./messengerState";

const LEGACY_CHAT_HISTORY_SCOPE = "chat:history";

function getStateImageUrls(state: MessengerUserState): string[] {
  return [
    state.lastPhotoUrl,
    state.pendingImageUrl,
    state.lastSourceImageUrl,
    state.pendingSourceImageDeleteUrl,
    state.lastGeneratedUrl,
    state.lastImageUrl,
  ].filter((url): url is string => Boolean(url));
}

async function deleteStoredUrl(psid: string, imageUrl: string): Promise<void> {
  const key = storageKeyFromPublicUrl(imageUrl);
  if (!key) {
    return;
  }

  try {
    await storageDelete(key);
  } catch (error) {
    safeLog("user_data_storage_delete_failed", {
      psid,
      key,
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
  }
}

export async function deleteUserData(psid: string): Promise<void> {
  const state = await getState(psid);
  if (!state) {
    await Promise.resolve(clearUserState(psid));
    return;
  }

  const urls = Array.from(new Set(getStateImageUrls(state)));

  const runStep = async (step: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      safeLog("user_data_delete_step_failed", {
        psid,
        step,
        errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
      });
    }
  };

  await runStep("face_memory", () => deleteFaceMemoryForUser(psid));
  await Promise.all(urls.map(url => deleteStoredUrl(psid, url)));
  await runStep("legacy_chat_history", () =>
    Promise.resolve(deleteScopedState(LEGACY_CHAT_HISTORY_SCOPE, state.userKey))
  );
  await Promise.resolve(clearUserState(psid));
}
