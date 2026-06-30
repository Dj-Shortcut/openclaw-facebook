import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import { deletePortalHandoffTokensForMessengerUserKey } from "../db";
import { deleteCostLedgerEntriesForUser } from "./costLedger";
import { deleteFaceMemoryForUser } from "./faceMemory";
import { safeLog } from "./messengerApi";
import { deleteMessengerGenerationCompletionsForUser } from "./messengerGenerationCompletion";
import { toLogUser } from "./privacy";
import { deleteScopedState, writeState } from "./stateStore";
import { deleteProviderVideoForUser } from "./video-generation/videoProviderRegistry";
import {
  anonymizePsid,
  clearUserState,
  getState,
  setPendingSourceImageDeleteUrls,
  type MessengerUserState,
} from "./messengerState";

const LEGACY_CHAT_HISTORY_SCOPE = "chat:history";

function getStateImageUrls(state: MessengerUserState): string[] {
  return [
    state.lastPhotoUrl,
    state.pendingImageUrl,
    state.lastSourceImageUrl,
    state.pendingSourceImageDeleteUrl,
    ...(state.pendingSourceImageDeleteUrls ?? []),
    state.lastGeneratedUrl,
    state.lastImageUrl,
    state.lastGeneratedVideoUrl,
  ].filter((url): url is string => Boolean(url));
}

async function deleteStoredUrl(logUser: string, imageUrl: string): Promise<boolean> {
  const key = storageKeyFromPublicUrl(imageUrl);
  if (!key) {
    return true;
  }

  try {
    await storageDelete(key);
    return true;
  } catch (error) {
    safeLog("user_data_storage_delete_failed", {
      user: logUser,
      key,
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return false;
  }
}

export async function deleteUserData(psid: string): Promise<void> {
  const state = await getState(psid);
  const userKey = state?.userKey ?? anonymizePsid(psid);
  const logUser = toLogUser(userKey);
  const retryContext = state
    ? {
        lastPhotoUrl: state.lastPhotoUrl,
        lastPhoto: state.lastPhoto,
        lastPhotoSource: state.lastPhotoSource,
        lastImageUrl: state.lastImageUrl,
        lastGeneratedUrl: state.lastGeneratedUrl,
        pendingImageUrl: state.pendingImageUrl,
        pendingImageAt: state.pendingImageAt,
        stage: state.stage,
        state: state.state,
        pendingScreenshotIntentContinuation: state.pendingScreenshotIntentContinuation,
        pendingEditIntent: state.pendingEditIntent,
      }
    : null;

  const runStep = async (step: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      safeLog("user_data_delete_step_failed", {
        user: logUser,
        step,
        errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
      });
      return false;
    }
  };

  let deleteStepsSucceeded = true;

  deleteStepsSucceeded = (await runStep("cost_ledger", async () => {
    await deleteCostLedgerEntriesForUser(userKey);
  })) && deleteStepsSucceeded;

  deleteStepsSucceeded = (await runStep("portal_handoff_tokens", async () => {
    await deletePortalHandoffTokensForMessengerUserKey(userKey);
  })) && deleteStepsSucceeded;

  if (!state) {
    if (deleteStepsSucceeded) {
      await Promise.resolve(clearUserState(psid));
    }
    return;
  }

  const urls = Array.from(new Set(getStateImageUrls(state)));

  deleteStepsSucceeded = (await runStep("face_memory", () =>
    deleteFaceMemoryForUser(psid)
  )) && deleteStepsSucceeded;
  const deleteResults = await Promise.all(
    urls.map(async url => ({
      url,
      deleted: await deleteStoredUrl(logUser, url),
    }))
  );
  deleteStepsSucceeded = (await runStep("legacy_chat_history", () =>
    Promise.resolve(deleteScopedState(LEGACY_CHAT_HISTORY_SCOPE, state.userKey))
  )) && deleteStepsSucceeded;
  deleteStepsSucceeded = (await runStep("messenger_generation_completion", () =>
    deleteMessengerGenerationCompletionsForUser(state.userKey)
  )) && deleteStepsSucceeded;
  if (state.lastGeneratedVideoProviderJobId) {
    deleteStepsSucceeded = (await runStep("video_provider_artifact", () =>
      deleteProviderVideoForUser({
        provider: state.lastGeneratedVideoProvider ?? null,
        providerJobId: state.lastGeneratedVideoProviderJobId!,
        reqId: "delete-my-data",
      })
    )) && deleteStepsSucceeded;
  }

  const failedDeletes = deleteResults
    .filter(result => !result.deleted)
    .map(result => result.url);
  if (failedDeletes.length) {
    await Promise.resolve(
      setPendingSourceImageDeleteUrls(psid, failedDeletes)
    );
    return;
  }

  if (!deleteStepsSucceeded) {
    // Keep retry-related state when required deletion steps fail; allow
    // delete-my-data operations to be retried without losing in-flight context.
    if (state && retryContext) {
      const currentState = await getState(psid);
      if (currentState) {
        await Promise.resolve(
          writeState(psid, {
            ...currentState,
            ...retryContext,
          })
        );
      }
    }
    return;
  }

  await Promise.resolve(clearUserState(psid));
}
