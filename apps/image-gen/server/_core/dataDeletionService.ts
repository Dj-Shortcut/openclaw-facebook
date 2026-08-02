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
  type MessengerUserState,
} from "./messengerState";

const LEGACY_CHAT_HISTORY_SCOPE = "chat:history";

export type UserDataDeletionOutcome =
  { status: "completed" } | { status: "pending" } | { status: "failed" };

function getGeneralStateImageUrls(state: MessengerUserState): string[] {
  return [
    state.lastPhotoUrl,
    state.pendingImageUrl,
    state.lastGeneratedUrl,
    state.lastImageUrl,
    state.lastGeneratedVideoUrl,
  ].filter((url): url is string => Boolean(url));
}

function getFaceMemoryStateImageUrls(state: MessengerUserState): string[] {
  return [
    state.lastSourceImageUrl,
    state.pendingSourceImageDeleteUrl,
    ...(state.pendingSourceImageDeleteUrls ?? []),
  ].filter((url): url is string => Boolean(url));
}

async function deleteStoredUrl(
  logUser: string,
  imageUrl: string
): Promise<boolean> {
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
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return false;
  }
}

async function deleteUserDataInternal(
  psid: string
): Promise<UserDataDeletionOutcome> {
  const state = await getState(psid);
  const userKey = state?.userKey ?? anonymizePsid(psid);
  const logUser = toLogUser(userKey);
  const retryContext = state
    ? {
        stage: state.stage,
        state: state.state,
        pendingScreenshotIntentContinuation:
          state.pendingScreenshotIntentContinuation,
        pendingEditIntent: state.pendingEditIntent,
      }
    : null;

  const runStep = async (
    step: string,
    fn: () => Promise<void>
  ): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      safeLog("user_data_delete_step_failed", {
        user: logUser,
        step,
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
      return false;
    }
  };

  const persistDeletionRetryState = async (
    pendingDeleteUrls: string[]
  ): Promise<boolean> => {
    const currentState = await getState(psid);
    if (!currentState) {
      return false;
    }

    const uniquePendingDeleteUrls = Array.from(
      new Set(
        [
          ...pendingDeleteUrls,
          currentState.pendingSourceImageDeleteUrl,
          ...(currentState.pendingSourceImageDeleteUrls ?? []),
        ].filter((url): url is string => Boolean(url))
      )
    );
    await Promise.resolve(
      writeState(psid, {
        ...currentState,
        ...retryContext,
        lastPhotoUrl: null,
        lastPhoto: null,
        lastPhotoSource: null,
        pendingImageUrl: undefined,
        pendingImageAt: undefined,
        lastImageUrl: undefined,
        lastGeneratedUrl: null,
        lastGeneratedAt: undefined,
        lastGeneratedVideoUrl: null,
        lastGeneratedVideoAt: null,
        pendingSourceImageDeleteUrl: uniquePendingDeleteUrls[0] ?? null,
        pendingSourceImageDeleteUrls: uniquePendingDeleteUrls.length
          ? uniquePendingDeleteUrls
          : null,
      })
    );
    return true;
  };

  let deleteStepsSucceeded = true;

  deleteStepsSucceeded =
    (await runStep("cost_ledger", async () => {
      await deleteCostLedgerEntriesForUser(userKey);
    })) && deleteStepsSucceeded;

  deleteStepsSucceeded =
    (await runStep("portal_handoff_tokens", async () => {
      await deletePortalHandoffTokensForMessengerUserKey(userKey);
    })) && deleteStepsSucceeded;

  deleteStepsSucceeded =
    (await runStep("legacy_shadow_state", async () => {
      // Older Messenger handlers also wrote selected flow fields under the
      // privacy-peppered user key. No runtime reader needs that shadow record,
      // but erasure must remove it while legacy data can still exist.
      await Promise.resolve(clearUserState(userKey));
    })) && deleteStepsSucceeded;

  if (!state) {
    if (!deleteStepsSucceeded) {
      return { status: "failed" };
    }
    await Promise.resolve(clearUserState(psid));
    return { status: "completed" };
  }

  const faceMemoryUrls = new Set(getFaceMemoryStateImageUrls(state));
  const urls = Array.from(
    new Set(
      getGeneralStateImageUrls(state).filter(url => !faceMemoryUrls.has(url))
    )
  );

  let faceMemoryFailedDeletes: string[] = [];
  deleteStepsSucceeded =
    (await runStep("face_memory", async () => {
      faceMemoryFailedDeletes = await deleteFaceMemoryForUser(psid);
    })) && deleteStepsSucceeded;
  const deleteResults = await Promise.all(
    urls.map(async url => ({
      url,
      deleted: await deleteStoredUrl(logUser, url),
    }))
  );
  deleteStepsSucceeded =
    (await runStep("legacy_chat_history", () =>
      Promise.resolve(
        deleteScopedState(LEGACY_CHAT_HISTORY_SCOPE, state.userKey)
      )
    )) && deleteStepsSucceeded;
  deleteStepsSucceeded =
    (await runStep("messenger_generation_completion", () =>
      deleteMessengerGenerationCompletionsForUser(state.userKey)
    )) && deleteStepsSucceeded;
  if (state.lastGeneratedVideoProviderJobId) {
    deleteStepsSucceeded =
      (await runStep("video_provider_artifact", () =>
        deleteProviderVideoForUser({
          provider: state.lastGeneratedVideoProvider ?? null,
          providerJobId: state.lastGeneratedVideoProviderJobId!,
          reqId: "delete-my-data",
        })
      )) && deleteStepsSucceeded;
  }

  const failedDeletes = Array.from(
    new Set([
      ...faceMemoryFailedDeletes,
      ...deleteResults
        .filter(result => !result.deleted)
        .map(result => result.url),
    ])
  );
  if (failedDeletes.length) {
    return (await persistDeletionRetryState(failedDeletes))
      ? { status: "pending" }
      : { status: "failed" };
  }

  if (!deleteStepsSucceeded) {
    // Keep retry-related state when required deletion steps fail; allow
    // delete-my-data operations to be retried without losing in-flight context.
    if (retryContext && (await persistDeletionRetryState([]))) {
      return { status: "pending" };
    }
    return { status: "failed" };
  }

  await Promise.resolve(clearUserState(psid));
  return { status: "completed" };
}

export async function deleteUserData(
  psid: string
): Promise<UserDataDeletionOutcome> {
  try {
    return await deleteUserDataInternal(psid);
  } catch (error) {
    let logUser = "unknown";
    try {
      logUser = toLogUser(anonymizePsid(psid));
    } catch {
      // Keep the fallback metadata-only identifier when privacy config is invalid.
    }
    safeLog("user_data_delete_failed", {
      user: logUser,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return { status: "failed" };
  }
}
