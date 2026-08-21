import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import {
  eraseBillingHandoffIdentity,
  getConnectedFacebookPageConnection,
} from "../db";
import { deleteCostLedgerEntriesForUser } from "./costLedger";
import { deleteFaceMemoryForUser } from "./faceMemory";
import { safeLog } from "./messengerApi";
import { deleteMessengerGenerationCompletionsForUser } from "./messengerGenerationCompletion";
import { toLogUser } from "./privacy";
import { deleteScopedState } from "./stateStore";
import { deleteProviderVideoForUser } from "./video-generation/videoProviderRegistry";
import {
  anonymizePsid,
  clearUserState,
  type MessengerUserState,
} from "./messengerState";
import {
  beginMessengerStatePrivacyErasure,
  deleteLegacyPersistedState,
  getPersistedStateForErasure,
  replacePersistedState,
} from "./messengerStatePersistence";
import { getMessengerRequestPageId } from "./messengerRequestContext";
import {
  beginMessengerPrivacyErasure,
  completeMessengerPrivacyErasure,
} from "./messengerPrivacySubject";
import { containMessengerProviderAttemptsForPrivacy } from "./messengerProviderAttemptFence";
import { eraseWebhookIngressDeliveriesForSubject } from "./meta/webhookIngressQueue";
import { eraseMessengerGenerationJobsForSubject } from "./messengerGenerationQueue";

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
  const state = await Promise.resolve(getPersistedStateForErasure(psid));
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
    const currentState = state;
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
      replacePersistedState(psid, {
        psid: currentState.psid,
        userKey: currentState.userKey,
        ...retryContext,
        pendingDeleteConfirm: false,
        lastGeneratedVideoProvider: currentState.lastGeneratedVideoProvider,
        lastGeneratedVideoProviderJobId:
          currentState.lastGeneratedVideoProviderJobId,
        pendingSourceImageDeleteUrl: uniquePendingDeleteUrls[0] ?? null,
        pendingSourceImageDeleteUrls: uniquePendingDeleteUrls.length
          ? uniquePendingDeleteUrls
          : null,
      })
    );
    return true;
  };

  let privacyErasure:
    | {
        workspaceId: number;
        channelConnectionId: number;
        userKey: string;
        privacyEpoch: number;
      }
    | undefined;
  if (
    state?.pageId &&
    state.workspaceId &&
    state.channelConnectionId &&
    state.bindingEpoch &&
    state.privacyEpoch
  ) {
    const connection = await getConnectedFacebookPageConnection(state.pageId, {
      workspaceId: state.workspaceId,
      channelConnectionId: state.channelConnectionId,
      bindingEpoch: state.bindingEpoch,
    });
    if (!connection) return { status: "failed" };
    const privacyEpoch = await beginMessengerPrivacyErasure({
      workspaceId: state.workspaceId,
      channelConnectionId: state.channelConnectionId,
      userKey,
    });
    privacyErasure = {
      workspaceId: state.workspaceId,
      channelConnectionId: state.channelConnectionId,
      userKey,
      privacyEpoch,
    };
  } else if (process.env.NODE_ENV === "production") {
    return { status: "failed" };
  }

  let deleteStepsSucceeded = true;
  let providerDrainPending = false;

  if (privacyErasure && state?.bindingEpoch) {
    const stateTombstoned = await runStep(
      "messenger_state_privacy_tombstone",
      async () => {
        await beginMessengerStatePrivacyErasure({
          ...privacyErasure,
          bindingEpoch: state.bindingEpoch!,
        });
      }
    );
    if (!stateTombstoned) return { status: "failed" };

    deleteStepsSucceeded =
      (await runStep("webhook_ingress_queue", async () => {
        await eraseWebhookIngressDeliveriesForSubject(privacyErasure!);
      })) && deleteStepsSucceeded;
  }

  if (privacyErasure && state?.pageId && state.bindingEpoch) {
    deleteStepsSucceeded =
      (await runStep("messenger_provider_attempts", async () => {
        const drained =
          await containMessengerProviderAttemptsForPrivacy(privacyErasure);
        if (!drained) {
          providerDrainPending = true;
          throw new Error("Messenger provider transport is still in flight");
        }
      })) && deleteStepsSucceeded;
    // Do not scrub completion/object indexes while a provider or Graph
    // transport still owns an active started fence. The finishing worker may
    // need to publish its cleanup inventory before this saga resumes.
    if (providerDrainPending) return { status: "pending" };
    deleteStepsSucceeded =
      (await runStep("messenger_generation_queue", async () => {
        await eraseMessengerGenerationJobsForSubject({
          ...privacyErasure,
          bindingEpoch: state.bindingEpoch!,
          pageId: state.pageId!,
          privacyEpoch: state.privacyEpoch!,
        });
      })) && deleteStepsSucceeded;
  }

  deleteStepsSucceeded =
    (await runStep("cost_ledger", async () => {
      await deleteCostLedgerEntriesForUser(userKey);
    })) && deleteStepsSucceeded;

  deleteStepsSucceeded =
    (await runStep("billing_handoff_identity", async () => {
      const pageId = state?.pageId ?? getMessengerRequestPageId();
      if (!pageId) {
        if (process.env.NODE_ENV === "production") {
          throw new Error("Verified Page scope is required for erasure");
        }
        return;
      }
      const connection = await getConnectedFacebookPageConnection(
        pageId,
        state?.workspaceId && state.channelConnectionId && state.bindingEpoch
          ? {
              workspaceId: state.workspaceId,
              channelConnectionId: state.channelConnectionId,
              bindingEpoch: state.bindingEpoch,
            }
          : undefined
      );
      if (!connection)
        throw new Error("Verified Page ownership is unavailable");
      await eraseBillingHandoffIdentity(
        connection.workspaceId,
        userKey,
        pageId
      );
    })) && deleteStepsSucceeded;

  deleteStepsSucceeded =
    (await runStep("legacy_shadow_state", async () => {
      // Older Messenger handlers also wrote selected flow fields under the
      // privacy-peppered user key. No runtime reader needs that shadow record,
      // but erasure must remove it while legacy data can still exist.
      // Do not delete the raw PSID key here: the legacy keyspace has no channel
      // ownership marker and is still used by non-Messenger callers. The
      // pre-deploy migration must purge only records proven to be Messenger.
      await Promise.resolve(deleteLegacyPersistedState(userKey));
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
      faceMemoryFailedDeletes = await deleteFaceMemoryForUser(psid, {
        state,
        persistState: false,
      });
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
      deleteMessengerGenerationCompletionsForUser(
        state.userKey,
        privacyErasure && state.bindingEpoch && state.privacyEpoch
          ? {
              workspaceId: privacyErasure.workspaceId,
              channelConnectionId: privacyErasure.channelConnectionId,
              bindingEpoch: state.bindingEpoch,
              privacyEpoch: state.privacyEpoch,
              userKey: state.userKey,
              pageId: state.pageId!,
            }
          : undefined
      )
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
    // Once the monotone privacy tombstone is installed, do not attempt to
    // recreate customer state merely to record retry metadata. The existing
    // fenced state remains readable only by this erasure path until every
    // external object has been scrubbed.
    if (privacyErasure) return { status: "pending" };
    return (await persistDeletionRetryState(failedDeletes))
      ? { status: "pending" }
      : { status: "failed" };
  }

  if (!deleteStepsSucceeded) {
    if (providerDrainPending) return { status: "pending" };
    if (privacyErasure) return { status: "pending" };
    // Keep retry-related state when required deletion steps fail; allow
    // delete-my-data operations to be retried without losing in-flight context.
    if (retryContext && (await persistDeletionRetryState([]))) {
      return { status: "pending" };
    }
    return { status: "failed" };
  }

  await Promise.resolve(clearUserState(psid));
  if (privacyErasure) {
    await completeMessengerPrivacyErasure(privacyErasure);
  }
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
