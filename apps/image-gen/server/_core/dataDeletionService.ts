import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import {
  eraseBillingHandoffIdentity,
  getConnectedFacebookPageConnection,
} from "../db";
import { deleteCostLedgerEntriesForSubject } from "./costLedger";
import { deleteFaceMemoryForUser } from "./faceMemory";
import { safeLog } from "./messengerApi";
import { deleteMessengerGenerationCompletionsForUser } from "./messengerGenerationCompletion";
import { deleteMessengerQuotaReservationsForErasure } from "./messengerQuota";
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
  deleteLegacyMessengerQuotaShadow,
  deleteLegacyPersistedState,
  deletePersistedStateHistoryForErasure,
  getPersistedStateForErasure,
  getPersistedStateHistoryForErasure,
  replacePersistedState,
} from "./messengerStatePersistence";
import {
  getMessengerRequestChannel,
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import {
  beginMessengerPrivacyErasure,
  completeMessengerPrivacyErasure,
  isMessengerPrivacyErasureComplete,
} from "./messengerPrivacySubject";
import {
  beginMessengerPrivacyOwnershipErasure,
  completeMessengerPrivacyOwnershipErasure,
  isMessengerPrivacyOwnershipErased,
  type MessengerPrivacyOwnershipScope,
} from "./messengerPrivacyOwnershipHistory";
import {
  claimMessengerPrivacyErasureJob,
  completeMessengerPrivacyErasureJob,
  enqueueMessengerPrivacyErasureJob,
  rescheduleMessengerPrivacyErasureJob,
  setMessengerPrivacyErasureEpoch,
  type ClaimedMessengerPrivacyErasureJob,
} from "./messengerPrivacyErasureQueue";
import { containMessengerProviderAttemptsForPrivacy } from "./messengerProviderAttemptFence";
import { eraseWebhookIngressDeliveriesForSubject } from "./meta/webhookIngressQueue";
import { eraseMessengerGenerationJobsForSubject } from "./messengerGenerationQueue";

const LEGACY_CHAT_HISTORY_SCOPE = "chat:history";

function ownershipScopeIdentity(scope: MessengerPrivacyOwnershipScope): string {
  return `${scope.channel ?? "facebook_messenger"}:${scope.workspaceId}:${scope.channelConnectionId}:${scope.bindingEpoch}`;
}

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
  psid: string,
  erasureClaim?: ClaimedMessengerPrivacyErasureJob
): Promise<UserDataDeletionOutcome> {
  const state = await Promise.resolve(getPersistedStateForErasure(psid));
  const claimJob = erasureClaim?.job;
  if (!state && erasureClaim) {
    const erasureEpoch = erasureClaim.job.erasureEpoch;
    if (erasureEpoch) {
      const erasureScope = {
        workspaceId: erasureClaim.job.workspaceId,
        channelConnectionId: erasureClaim.job.channelConnectionId,
        userKey: erasureClaim.job.userKey,
        privacyEpoch: erasureEpoch,
      };
      if (
        await isMessengerPrivacyOwnershipErased({
          pageId: erasureClaim.job.pageId,
          userKey: erasureClaim.job.userKey,
          channel: erasureClaim.job.channel ?? "facebook_messenger",
        })
      ) {
        if (!(await isMessengerPrivacyErasureComplete(erasureScope))) {
          await completeMessengerPrivacyErasure(erasureScope);
        }
        return { status: "completed" };
      }
    }
  }
  if (
    state &&
    claimJob &&
    (state.userKey !== claimJob.userKey ||
      state.pageId !== claimJob.pageId ||
      state.workspaceId !== claimJob.workspaceId ||
      state.channelConnectionId !== claimJob.channelConnectionId ||
      state.bindingEpoch !== claimJob.bindingEpoch)
  ) {
    throw new Error("Messenger erasure job ownership changed");
  }
  const userKey = state?.userKey ?? claimJob?.userKey ?? anonymizePsid(psid);
  const pageId = state?.pageId ?? claimJob?.pageId;
  const workspaceId = state?.workspaceId ?? claimJob?.workspaceId;
  const channelConnectionId =
    state?.channelConnectionId ?? claimJob?.channelConnectionId;
  const bindingEpoch = state?.bindingEpoch ?? claimJob?.bindingEpoch;
  const subjectPrivacyEpoch = state?.privacyEpoch ?? claimJob?.oldPrivacyEpoch;
  const channel =
    claimJob?.channel ?? getMessengerRequestChannel() ?? "facebook_messenger";
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
        bindingEpoch: number;
        userKey: string;
        privacyEpoch: number;
      }
    | undefined;
  if (
    pageId &&
    workspaceId &&
    channelConnectionId &&
    bindingEpoch &&
    subjectPrivacyEpoch
  ) {
    const privacyEpoch = await beginMessengerPrivacyErasure({
      workspaceId,
      channelConnectionId,
      userKey,
    });
    privacyErasure = {
      workspaceId,
      channelConnectionId,
      bindingEpoch,
      userKey,
      privacyEpoch,
    };
    if (erasureClaim && erasureClaim.job.erasureEpoch !== privacyEpoch) {
      await setMessengerPrivacyErasureEpoch({
        claim: erasureClaim,
        erasureEpoch: privacyEpoch,
      });
    }
  } else if (process.env.NODE_ENV === "production") {
    return { status: "failed" };
  }

  let deleteStepsSucceeded = true;
  let providerDrainPending = false;
  let statesForErasure = state ? [state] : [];
  let ownershipScopes: MessengerPrivacyOwnershipScope[] = privacyErasure
    ? [
        {
          workspaceId: privacyErasure.workspaceId,
          channelConnectionId: privacyErasure.channelConnectionId,
          bindingEpoch: privacyErasure.bindingEpoch,
          channel,
          privacyEpoch: Math.max(
            privacyErasure.privacyEpoch,
            subjectPrivacyEpoch ?? privacyErasure.privacyEpoch
          ),
        },
      ]
    : [];

  if (privacyErasure && pageId && bindingEpoch) {
    const historicalScopes = await beginMessengerPrivacyOwnershipErasure({
      pageId,
      userKey,
      channel,
    });
    const scopesByIdentity = new Map<string, MessengerPrivacyOwnershipScope>();
    for (const scope of [...historicalScopes, ...ownershipScopes]) {
      const identity = ownershipScopeIdentity(scope);
      const current = scopesByIdentity.get(identity);
      if (!current || current.privacyEpoch < scope.privacyEpoch) {
        scopesByIdentity.set(identity, scope);
      }
    }
    ownershipScopes = [...scopesByIdentity.values()];

    // Fence every durable privacy subject before touching any tenant content.
    // The current Page can have moved across workspaces/connections since an
    // older job or completion was written. Each exact historical subject is
    // transitioned independently; no Page lookup follows the current owner.
    for (const scope of ownershipScopes) {
      if (
        scope.workspaceId === privacyErasure.workspaceId &&
        scope.channelConnectionId === privacyErasure.channelConnectionId
      ) {
        continue;
      }
      const durableEpoch = await beginMessengerPrivacyErasure({
        workspaceId: scope.workspaceId,
        channelConnectionId: scope.channelConnectionId,
        userKey,
      });
      if (durableEpoch > scope.privacyEpoch) {
        scopesByIdentity.set(ownershipScopeIdentity(scope), {
          ...scope,
          privacyEpoch: durableEpoch,
        });
      }
    }
    ownershipScopes = [...scopesByIdentity.values()];

    const subjectScopesByIdentity = new Map<
      string,
      MessengerPrivacyOwnershipScope
    >();
    for (const scope of ownershipScopes) {
      const identity = ownershipScopeIdentity(scope);
      const current = subjectScopesByIdentity.get(identity);
      if (!current || current.privacyEpoch < scope.privacyEpoch) {
        subjectScopesByIdentity.set(identity, scope);
      }
    }
    const subjectScopes = [...subjectScopesByIdentity.values()];

    const stateTombstoned = await runStep(
      "messenger_state_privacy_tombstone",
      async () => {
        for (const scope of subjectScopes) {
          await beginMessengerStatePrivacyErasure({
            ...scope,
            userKey,
          });
        }
      }
    );
    if (!stateTombstoned) return { status: "failed" };

    const historyLoaded = await runStep(
      "messenger_state_history_inventory",
      async () => {
        const histories = await Promise.all(
          subjectScopes.map(scope =>
            getPersistedStateHistoryForErasure(psid, {
              ...scope,
              userKey,
            })
          )
        );
        const uniqueStates = new Map<string, MessengerUserState>();
        for (const candidate of [
          ...(state ? [state] : []),
          ...histories.flat(),
        ]) {
          const identity = [
            candidate.workspaceId,
            candidate.channelConnectionId,
            candidate.bindingEpoch,
            candidate.privacyEpoch,
            candidate.pageId,
          ].join(":");
          uniqueStates.set(identity, candidate);
        }
        statesForErasure = [...uniqueStates.values()];
      }
    );
    if (!historyLoaded) return { status: "failed" };

    deleteStepsSucceeded =
      (await runStep("webhook_ingress_queue", async () => {
        for (const scope of subjectScopes) {
          await eraseWebhookIngressDeliveriesForSubject({
            workspaceId: scope.workspaceId,
            channelConnectionId: scope.channelConnectionId,
            userKey,
            privacyEpoch: scope.privacyEpoch,
          });
        }
      })) && deleteStepsSucceeded;
    deleteStepsSucceeded =
      (await runStep("messenger_provider_attempts", async () => {
        for (const scope of subjectScopes) {
          const drained = await containMessengerProviderAttemptsForPrivacy({
            workspaceId: scope.workspaceId,
            channelConnectionId: scope.channelConnectionId,
            userKey,
          });
          if (!drained) {
            providerDrainPending = true;
            throw new Error("Messenger provider transport is still in flight");
          }
        }
      })) && deleteStepsSucceeded;
    // Do not scrub completion/object indexes while a provider or Graph
    // transport still owns an active started fence. The finishing worker may
    // need to publish its cleanup inventory before this saga resumes.
    if (providerDrainPending) return { status: "pending" };
    deleteStepsSucceeded =
      (await runStep("messenger_generation_queue", async () => {
        for (const scope of ownershipScopes) {
          await eraseMessengerGenerationJobsForSubject({
            workspaceId: scope.workspaceId,
            channelConnectionId: scope.channelConnectionId,
            bindingEpoch: scope.bindingEpoch,
            pageId,
            userKey,
            privacyEpoch: scope.privacyEpoch,
          });
        }
      })) && deleteStepsSucceeded;

    deleteStepsSucceeded =
      (await runStep("cost_ledger", async () => {
        for (const scope of subjectScopes) {
          await deleteCostLedgerEntriesForSubject({
            workspaceId: scope.workspaceId,
            channelConnectionId: scope.channelConnectionId,
            userKey,
            erasureEpoch: scope.privacyEpoch,
          });
        }
      })) && deleteStepsSucceeded;
  }

  deleteStepsSucceeded =
    (await runStep("billing_handoff_identity", async () => {
      const billingPageId = pageId ?? getMessengerRequestPageId();
      let billingWorkspaceId = workspaceId ?? privacyErasure?.workspaceId;
      if (!billingWorkspaceId && billingPageId) {
        // Compatibility for pre-fence local/legacy deletion only. A durable
        // Messenger erasure always carries immutable workspace scope and never
        // follows a Page's current owner after disconnect or reassignment.
        const currentConnection =
          await getConnectedFacebookPageConnection(billingPageId);
        billingWorkspaceId = currentConnection?.workspaceId;
      }
      if (!billingPageId || !billingWorkspaceId) {
        if (process.env.NODE_ENV === "production") {
          throw new Error("Verified tenant Page scope is required for erasure");
        }
        return;
      }
      // The fenced state/queued job is the immutable historical binding.
      // Never resolve the Page's current owner here: disconnect/rebind must not
      // redirect or permanently strand an already accepted GDPR erasure.
      const billingWorkspaceIds = new Set(
        ownershipScopes.map(scope => scope.workspaceId)
      );
      billingWorkspaceIds.add(billingWorkspaceId);
      for (const historicalWorkspaceId of billingWorkspaceIds) {
        await eraseBillingHandoffIdentity(
          historicalWorkspaceId,
          userKey,
          billingPageId
        );
      }
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

  if (state) {
    deleteStepsSucceeded =
      (await runStep("legacy_messenger_quota_shadow", async () => {
        const outcome = await deleteLegacyMessengerQuotaShadow(psid, state);
        if (outcome === "conflict") {
          throw new Error(
            "Legacy Messenger quota shadow changed during erasure"
          );
        }
      })) && deleteStepsSucceeded;
  }
  // Reservation locks are exact PSID keys and can outlive state creation or a
  // prior partial erasure. Always remove them, even when no persisted state is
  // recoverable, so deletion cannot leave a raw identifier behind.
  deleteStepsSucceeded =
    (await runStep("messenger_quota_reservations", async () => {
      await deleteMessengerQuotaReservationsForErasure(psid);
    })) && deleteStepsSucceeded;

  const faceMemoryUrls = new Set(
    statesForErasure.flatMap(getFaceMemoryStateImageUrls)
  );
  const urls = Array.from(
    new Set(
      statesForErasure
        .flatMap(getGeneralStateImageUrls)
        .filter(url => !faceMemoryUrls.has(url))
    )
  );

  let faceMemoryFailedDeletes: string[] = [];
  if (privacyErasure) {
    const faceDeleteResults = await Promise.all(
      [...faceMemoryUrls].map(async url => ({
        url,
        deleted: await deleteStoredUrl(logUser, url),
      }))
    );
    faceMemoryFailedDeletes = faceDeleteResults
      .filter(result => !result.deleted)
      .map(result => result.url);
  } else if (state) {
    deleteStepsSucceeded =
      (await runStep("face_memory", async () => {
        faceMemoryFailedDeletes = await deleteFaceMemoryForUser(psid, {
          state,
          persistState: false,
        });
      })) && deleteStepsSucceeded;
  }
  const deleteResults = await Promise.all(
    urls.map(async url => ({
      url,
      deleted: await deleteStoredUrl(logUser, url),
    }))
  );
  deleteStepsSucceeded =
    (await runStep("legacy_chat_history", () =>
      Promise.resolve(deleteScopedState(LEGACY_CHAT_HISTORY_SCOPE, userKey))
    )) && deleteStepsSucceeded;
  deleteStepsSucceeded =
    (await runStep("messenger_generation_completion", async () => {
      if (privacyErasure && pageId && bindingEpoch) {
        const completionScopes = new Map<
          string,
          MessengerPrivacyOwnershipScope
        >();
        for (const scope of ownershipScopes) {
          const identity = ownershipScopeIdentity(scope);
          const current = completionScopes.get(identity);
          if (!current || current.privacyEpoch < scope.privacyEpoch) {
            completionScopes.set(identity, scope);
          }
        }
        for (const scope of completionScopes.values()) {
          await deleteMessengerGenerationCompletionsForUser(userKey, {
            ...scope,
            userKey,
            pageId,
            channel: scope.channel ?? "facebook_messenger",
          });
        }
        return;
      }
      await deleteMessengerGenerationCompletionsForUser(userKey);
    })) && deleteStepsSucceeded;
  const providerVideoArtifacts = new Map<
    string,
    { provider: string | null; providerJobId: string }
  >();
  for (const historicalState of statesForErasure) {
    if (!historicalState.lastGeneratedVideoProviderJobId) continue;
    const artifact = {
      provider: historicalState.lastGeneratedVideoProvider ?? null,
      providerJobId: historicalState.lastGeneratedVideoProviderJobId,
    };
    providerVideoArtifacts.set(
      `${artifact.provider ?? ""}:${artifact.providerJobId}`,
      artifact
    );
  }
  if (providerVideoArtifacts.size) {
    deleteStepsSucceeded =
      (await runStep("video_provider_artifact", async () => {
        await Promise.all(
          [...providerVideoArtifacts.values()].map(artifact =>
            deleteProviderVideoForUser({
              ...artifact,
              reqId: "delete-my-data",
            })
          )
        );
      })) && deleteStepsSucceeded;
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

  if (privacyErasure) {
    // This is the final content-bearing scrub. The Redis tombstone prevents
    // stale old-binding writers from racing this CAS deletion; the durable
    // scrub marker lets a crashed saga resume the DB transition without
    // recreating or globally scanning state.
    const subjectScopes = new Map<string, MessengerPrivacyOwnershipScope>();
    for (const scope of ownershipScopes) {
      const identity = ownershipScopeIdentity(scope);
      const current = subjectScopes.get(identity);
      if (!current || current.privacyEpoch < scope.privacyEpoch) {
        subjectScopes.set(identity, scope);
      }
    }
    for (const scope of subjectScopes.values()) {
      await deletePersistedStateHistoryForErasure(psid, {
        ...scope,
        userKey,
      });
    }
    // Persist every historical DB subject transition before deleting the
    // durable scope inventory. A crash can then resume from that inventory;
    // the final ownership marker means all subject transitions completed.
    for (const scope of subjectScopes.values()) {
      await completeMessengerPrivacyErasure({
        workspaceId: scope.workspaceId,
        channelConnectionId: scope.channelConnectionId,
        userKey,
        privacyEpoch: scope.privacyEpoch,
      });
    }
    await completeMessengerPrivacyOwnershipErasure({
      pageId: pageId!,
      userKey,
      channel,
    });
  }
  // Memory/local compatibility still needs the exact active key removed. In
  // Redis this is an idempotent no-op after the historical CAS scrub.
  await Promise.resolve(clearUserState(psid));
  return { status: "completed" };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

export async function processClaimedMessengerPrivacyErasureJob(
  claim: ClaimedMessengerPrivacyErasureJob
): Promise<UserDataDeletionOutcome> {
  try {
    const outcome = await runWithMessengerRequestContext(
      claim.job.pageId,
      async () => {
        setMessengerRequestPrivacySubject({
          userKey: claim.job.userKey,
          privacyEpoch: claim.job.oldPrivacyEpoch,
        });
        return await deleteUserDataInternal(claim.psid, claim);
      },
      {
        workspaceId: claim.job.workspaceId,
        channelConnectionId: claim.job.channelConnectionId,
        bindingEpoch: claim.job.bindingEpoch,
      }
    );
    if (outcome.status === "completed") {
      await completeMessengerPrivacyErasureJob(claim);
      return outcome;
    }
    await rescheduleMessengerPrivacyErasureJob({
      claim,
      errorCode:
        outcome.status === "pending" ? "ErasurePending" : "ErasureFailed",
    });
    return { status: "pending" };
  } catch (error) {
    try {
      await rescheduleMessengerPrivacyErasureJob({
        claim,
        errorCode: errorCode(error),
      });
    } catch {
      // The durable pending member remains. A replica can reclaim it after the
      // lease expires; never discard the original failure in favor of cleanup.
    }
    return { status: "pending" };
  }
}

export async function processMessengerPrivacyErasureJob(
  jobId: string
): Promise<UserDataDeletionOutcome> {
  const claim = await claimMessengerPrivacyErasureJob(jobId);
  if (!claim) return { status: "pending" };
  return await processClaimedMessengerPrivacyErasureJob(claim);
}

export async function deleteUserData(
  psid: string,
  options?: {
    /**
     * Runs only after the Messenger erasure job is durably enqueued and while
     * the subject is still active. The caller can acknowledge acceptance here;
     * normal Messenger delivery must fail closed once erasure begins.
     */
    onDurablyAccepted?: () => Promise<void>;
  }
): Promise<UserDataDeletionOutcome> {
  try {
    const ownership = getMessengerRequestOwnership();
    const subject = getMessengerRequestPrivacySubject();
    const pageId = getMessengerRequestPageId();
    if (ownership && subject && pageId) {
      const computedUserKey = anonymizePsid(psid);
      if (subject.userKey !== computedUserKey) {
        throw new Error("Messenger privacy subject does not match sender");
      }
      const jobId = await enqueueMessengerPrivacyErasureJob({
        psid,
        scope: {
          ...ownership,
          channel: getMessengerRequestChannel() ?? "facebook_messenger",
          pageId,
          userKey: computedUserKey,
          oldPrivacyEpoch: subject.privacyEpoch,
        },
      });
      try {
        await options?.onDurablyAccepted?.();
      } catch (error) {
        // Notification delivery must never block an accepted GDPR erasure.
        // Record metadata only; the durable job remains authoritative.
        safeLog("messenger_privacy_erasure_acceptance_reply_failed", {
          level: "warn",
          errorCode: errorCode(error),
        });
      }
      return await processMessengerPrivacyErasureJob(jobId);
    }
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
