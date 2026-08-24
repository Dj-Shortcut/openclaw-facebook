import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import {
  eraseBillingHandoffIdentity,
  getConnectedFacebookPageConnection,
  getConnectedMetaChannelConnection,
} from "../db";
import {
  deleteCostLedgerEntriesForUser,
  purgeLegacyCostLedgerEntriesForUser,
} from "./costLedger";
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
  deletePersistedStateForErasure,
  deleteLegacyPersistedState,
  getPersistedStateForErasure,
  replacePersistedState,
} from "./messengerStatePersistence";
import {
  getMessengerRequestErasurePrivacySubject,
  getMessengerRequestChannel,
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  setMessengerRequestErasurePrivacySubject,
  type MessengerChannel,
} from "./messengerRequestContext";
import {
  beginMessengerPrivacyErasure,
  runWithLockedMessengerPrivacyErasure,
  type MessengerErasingPrivacySubject,
} from "./messengerPrivacySubject";
import { containMessengerProviderAttemptsForPrivacy } from "./messengerProviderAttemptFence";
import { eraseWebhookIngressDeliveriesForSubject } from "./meta/webhookIngressQueue";
import { eraseMessengerGenerationJobsForSubject } from "./messengerGenerationQueue";
import { eraseMessengerImageQuotaForUser } from "./messengerImageQuotaStore";
import { hashStorageObjectKeyForLog } from "./messengerStorageObject";
import { isLocalGeneratedImageUrl } from "./generatedImageStore";

const LEGACY_CHAT_HISTORY_SCOPE = "chat:history";

export type UserDataDeletionOutcome =
  { status: "completed" } | { status: "pending" } | { status: "failed" };

function getGeneralStateImageUrls(state: MessengerUserState): string[] {
  return [
    state.lastPhotoUrl,
    state.pendingImageUrl,
    ...(state.pendingImageUrls ?? []),
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
    // The process-owned fallback is still live but has no object-storage key,
    // so retain its cleanup reference until it expires. Foreign/legacy URLs
    // are not objects owned by this storage service.
    return !isLocalGeneratedImageUrl(imageUrl);
  }

  try {
    await storageDelete(key);
    return true;
  } catch (error) {
    safeLog("user_data_storage_delete_failed", {
      user: logUser,
      objectKeyHash: hashStorageObjectKeyForLog(key),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return false;
  }
}

type LockedPrivacyErasure = MessengerErasingPrivacySubject & {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
};

function getConnectedDeletionChannelConnection(
  channel: MessengerChannel,
  externalId: string,
  expected?: {
    workspaceId?: number | null;
    channelConnectionId?: number | null;
    bindingEpoch?: number | null;
  }
) {
  return channel === "whatsapp"
    ? getConnectedMetaChannelConnection(channel, externalId, expected)
    : getConnectedFacebookPageConnection(externalId, expected);
}

async function deleteUserDataInternal(
  psid: string,
  lockedPrivacyErasure?: LockedPrivacyErasure
): Promise<UserDataDeletionOutcome> {
  const requestChannel = getMessengerRequestChannel();
  if (!requestChannel && process.env.NODE_ENV === "production") {
    return { status: "failed" };
  }
  const erasureRetry = getMessengerRequestErasurePrivacySubject();
  if (erasureRetry) {
    const ownership = getMessengerRequestOwnership();
    const expectedUserKey = anonymizePsid(psid);
    if (!ownership || erasureRetry.userKey !== expectedUserKey) {
      return { status: "failed" };
    }
    if (
      lockedPrivacyErasure &&
      (lockedPrivacyErasure.workspaceId !== ownership.workspaceId ||
        lockedPrivacyErasure.channelConnectionId !==
          ownership.channelConnectionId ||
        lockedPrivacyErasure.userKey !== expectedUserKey ||
        lockedPrivacyErasure.privacyEpoch !== erasureRetry.privacyEpoch ||
        lockedPrivacyErasure.dataPrivacyEpoch !== erasureRetry.dataPrivacyEpoch)
    ) {
      return { status: "failed" };
    }
  }
  let state = await Promise.resolve(getPersistedStateForErasure(psid));
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
        pendingDeleteConfirmAt: undefined,
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
  if (lockedPrivacyErasure) {
    privacyErasure = {
      workspaceId: lockedPrivacyErasure.workspaceId,
      channelConnectionId: lockedPrivacyErasure.channelConnectionId,
      userKey: lockedPrivacyErasure.userKey,
      privacyEpoch: lockedPrivacyErasure.privacyEpoch,
    };
  } else if (erasureRetry) {
    const ownership = getMessengerRequestOwnership();
    if (!ownership) return { status: "failed" };
    privacyErasure = {
      workspaceId: ownership.workspaceId,
      channelConnectionId: ownership.channelConnectionId,
      userKey,
      privacyEpoch: erasureRetry.privacyEpoch,
    };
  }
  if (
    state?.pageId &&
    state.workspaceId &&
    state.channelConnectionId &&
    state.bindingEpoch &&
    state.privacyEpoch
  ) {
    if (!requestChannel) return { status: "failed" };
    const connection = await getConnectedDeletionChannelConnection(
      requestChannel,
      state.pageId,
      {
        workspaceId: state.workspaceId,
        channelConnectionId: state.channelConnectionId,
        bindingEpoch: state.bindingEpoch,
      }
    );
    if (!connection) return { status: "failed" };
    if (
      erasureRetry &&
      (erasureRetry.userKey !== userKey ||
        erasureRetry.dataPrivacyEpoch !== state.privacyEpoch)
    ) {
      return { status: "failed" };
    }
    if (
      lockedPrivacyErasure &&
      lockedPrivacyErasure.dataPrivacyEpoch !== state.privacyEpoch
    ) {
      return { status: "failed" };
    }
    const privacyEpoch =
      lockedPrivacyErasure?.privacyEpoch ??
      privacyErasure?.privacyEpoch ??
      (await beginMessengerPrivacyErasure({
        workspaceId: state.workspaceId,
        channelConnectionId: state.channelConnectionId,
        userKey,
      }));
    privacyErasure = {
      workspaceId: state.workspaceId,
      channelConnectionId: state.channelConnectionId,
      userKey,
      privacyEpoch,
    };
  } else if (!privacyErasure && process.env.NODE_ENV === "production") {
    return { status: "failed" };
  }

  if (privacyErasure && !lockedPrivacyErasure) {
    const dataPrivacyEpoch =
      state?.privacyEpoch ?? erasureRetry?.dataPrivacyEpoch;
    if (!dataPrivacyEpoch) return { status: "failed" };
    const erasure = { ...privacyErasure, dataPrivacyEpoch };
    setMessengerRequestErasurePrivacySubject({
      userKey: erasure.userKey,
      privacyEpoch: erasure.privacyEpoch,
      dataPrivacyEpoch: erasure.dataPrivacyEpoch,
    });
    return await runWithLockedMessengerPrivacyErasure(erasure, async () => {
      const value = await deleteUserDataInternal(psid, erasure);
      return { value, complete: value.status === "completed" };
    });
  }

  let deleteStepsSucceeded = true;
  let providerDrainPending = false;

  if (privacyErasure && state?.bindingEpoch) {
    const tombstoneBindingEpoch = state.bindingEpoch;
    const stateTombstoned = await runStep(
      "messenger_state_privacy_tombstone",
      async () => {
        await beginMessengerStatePrivacyErasure({
          ...privacyErasure,
          bindingEpoch: tombstoneBindingEpoch,
        });
      }
    );
    if (!stateTombstoned) return { status: "failed" };

    const refreshedState = await runStep(
      "messenger_state_privacy_snapshot",
      async () => {
        const latestState = await Promise.resolve(
          getPersistedStateForErasure(psid)
        );
        if (latestState) state = latestState;
      }
    );
    if (!refreshedState) return { status: "pending" };

    deleteStepsSucceeded =
      (await runStep("webhook_ingress_queue", async () => {
        await eraseWebhookIngressDeliveriesForSubject(privacyErasure);
      })) && deleteStepsSucceeded;
  }

  const generationState = state;
  if (
    privacyErasure &&
    generationState?.pageId &&
    generationState.bindingEpoch
  ) {
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
          bindingEpoch: generationState.bindingEpoch!,
          pageId: generationState.pageId!,
          privacyEpoch: generationState.privacyEpoch!,
        });
      })) && deleteStepsSucceeded;
  }

  deleteStepsSucceeded =
    (await runStep("cost_ledger", async () => {
      const bindingEpoch =
        state?.bindingEpoch ?? getMessengerRequestOwnership()?.bindingEpoch;
      if (lockedPrivacyErasure && bindingEpoch) {
        await deleteCostLedgerEntriesForUser({
          workspaceId: lockedPrivacyErasure.workspaceId,
          channelConnectionId: lockedPrivacyErasure.channelConnectionId,
          bindingEpoch,
          privacyEpoch: lockedPrivacyErasure.dataPrivacyEpoch,
          userKey,
        });
        return;
      }
      if (process.env.NODE_ENV === "production") {
        throw new Error("Tenant-scoped cost ledger erasure is required");
      }
      // Old development/test states have no trustworthy tenant boundary. Only
      // purge equally unscoped legacy records; never attribute or delete a
      // scoped record from a guessed tenant.
      await purgeLegacyCostLedgerEntriesForUser(userKey);
    })) && deleteStepsSucceeded;

  if (privacyErasure) {
    deleteStepsSucceeded =
      (await runStep("messenger_image_quota", async () => {
        await eraseMessengerImageQuotaForUser(privacyErasure);
      })) && deleteStepsSucceeded;
  }

  deleteStepsSucceeded =
    (await runStep("billing_handoff_identity", async () => {
      const pageId = state?.pageId ?? getMessengerRequestPageId();
      if (!pageId) {
        if (process.env.NODE_ENV === "production") {
          throw new Error("Verified Page scope is required for erasure");
        }
        return;
      }
      if (!requestChannel) {
        if (process.env.NODE_ENV === "production") {
          throw new Error("Verified request channel is required for erasure");
        }
        return;
      }
      const ownership = getMessengerRequestOwnership();
      const expectedConnection =
        state?.workspaceId && state.channelConnectionId && state.bindingEpoch
          ? {
              workspaceId: state.workspaceId,
              channelConnectionId: state.channelConnectionId,
              bindingEpoch: state.bindingEpoch,
            }
          : ownership;
      if (requestChannel === "whatsapp" && !expectedConnection) {
        throw new Error("Exact WhatsApp ownership is required for erasure");
      }
      const connection = await getConnectedDeletionChannelConnection(
        requestChannel,
        pageId,
        expectedConnection
      );
      if (!connection)
        throw new Error("Verified channel ownership is unavailable");
      const maxPrivacyEpoch =
        lockedPrivacyErasure?.dataPrivacyEpoch ??
        erasureRetry?.dataPrivacyEpoch ??
        state?.privacyEpoch;
      if (
        (requestChannel === "whatsapp" ||
          process.env.NODE_ENV === "production") &&
        (!Number.isSafeInteger(maxPrivacyEpoch) || Number(maxPrivacyEpoch) <= 0)
      ) {
        throw new Error("Exact billing privacy scope is required for erasure");
      }
      if (maxPrivacyEpoch) {
        await eraseBillingHandoffIdentity(
          connection.workspaceId,
          userKey,
          pageId,
          {
            channelConnectionId: connection.id,
            maxPrivacyEpoch,
          }
        );
        return;
      }
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
    if (privacyErasure) return { status: "completed" };
    await Promise.resolve(clearUserState(psid));
    return { status: "completed" };
  }
  const deletionState = state;

  const faceMemoryUrls = new Set(getFaceMemoryStateImageUrls(deletionState));
  const urls = Array.from(
    new Set(
      getGeneralStateImageUrls(deletionState).filter(
        url => !faceMemoryUrls.has(url)
      )
    )
  );

  let faceMemoryFailedDeletes: string[] = [];
  deleteStepsSucceeded =
    (await runStep("face_memory", async () => {
      faceMemoryFailedDeletes = await deleteFaceMemoryForUser(psid, {
        state: deletionState,
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
        deleteScopedState(LEGACY_CHAT_HISTORY_SCOPE, deletionState.userKey)
      )
    )) && deleteStepsSucceeded;
  deleteStepsSucceeded =
    (await runStep("messenger_generation_completion", () =>
      deleteMessengerGenerationCompletionsForUser(
        deletionState.userKey,
        privacyErasure &&
          deletionState.bindingEpoch &&
          deletionState.privacyEpoch &&
          requestChannel
          ? {
              workspaceId: privacyErasure.workspaceId,
              channelConnectionId: privacyErasure.channelConnectionId,
              bindingEpoch: deletionState.bindingEpoch,
              privacyEpoch: deletionState.privacyEpoch,
              userKey: deletionState.userKey,
              pageId: deletionState.pageId!,
              channel: requestChannel,
            }
          : undefined,
        requestChannel === "whatsapp"
          ? { includeLegacyUnqualifiedWhatsAppIndexes: true }
          : undefined
      )
    )) && deleteStepsSucceeded;
  if (deletionState.lastGeneratedVideoProviderJobId) {
    deleteStepsSucceeded =
      (await runStep("video_provider_artifact", () =>
        deleteProviderVideoForUser({
          provider: deletionState.lastGeneratedVideoProvider ?? null,
          providerJobId: deletionState.lastGeneratedVideoProviderJobId!,
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

  await Promise.resolve(
    privacyErasure
      ? deletePersistedStateForErasure(psid, deletionState)
      : clearUserState(psid)
  );
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
