import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  storageDeleteMock,
  deleteProviderVideoForUserMock,
  deletePortalHandoffTokensForMessengerUserKeyMock,
} = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
  deleteProviderVideoForUserMock: vi.fn(async () => undefined),
  deletePortalHandoffTokensForMessengerUserKeyMock: vi.fn(async () => 0),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    storageDelete: storageDeleteMock,
  };
});
vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    deletePortalHandoffTokensForMessengerUserKey:
      deletePortalHandoffTokensForMessengerUserKeyMock,
  };
});
vi.mock(
  "./_core/video-generation/videoProviderRegistry",
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import("./_core/video-generation/videoProviderRegistry")
      >();
    return {
      ...actual,
      deleteProviderVideoForUser: deleteProviderVideoForUserMock,
    };
  }
);
import { deleteUserData } from "./_core/dataDeletionService";
import {
  appendCostLedgerEntry,
  readCostLedgerPeriod,
} from "./_core/costLedger";
import * as costLedger from "./_core/costLedger";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./_core/messengerGenerationCompletion";
import {
  anonymizePsid,
  getOrCreateState,
  getState,
  resetStateStore,
  setLastGenerationContext,
  setPendingImage,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import {
  readScopedState,
  readState,
  writeScopedState,
  writeState,
} from "./_core/stateStore";

describe("data deletion service", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
  const originalPageScopedStateEnabled =
    process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    process.env.PRIVACY_PEPPER = "data-deletion-test-pepper";
    resetStateStore();
  });

  afterEach(() => {
    resetStateStore();
    storageDeleteMock.mockReset();
    deleteProviderVideoForUserMock.mockReset();
    deletePortalHandoffTokensForMessengerUserKeyMock.mockReset();
    deletePortalHandoffTokensForMessengerUserKeyMock.mockResolvedValue(0);
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }

    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    if (originalPageScopedStateEnabled === undefined) {
      delete process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED;
    } else {
      process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED =
        originalPageScopedStateEnabled;
    }
  });

  it("deletes legacy Messenger chat history during user erasure", async () => {
    const psid = "delete-chat-history-user";
    const userKey = anonymizePsid(psid);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(
      writeScopedState(
        "chat:history",
        userKey,
        [{ role: "user", text: "old chat", ts: Date.now() }],
        60
      )
    );

    expect(
      await Promise.resolve(readScopedState("chat:history", userKey))
    ).toEqual([expect.objectContaining({ text: "old chat" })]);

    await expect(deleteUserData(psid)).resolves.toEqual({
      status: "completed",
    });

    expect(
      await Promise.resolve(readScopedState("chat:history", userKey))
    ).toBeNull();
  });

  it("deletes Messenger generation completion markers during user erasure", async () => {
    const psid = "delete-generation-completion-user";
    const userKey = anonymizePsid(psid);

    await Promise.resolve(getOrCreateState(psid));
    await markMessengerGenerationCompleted(
      "req-delete-completion",
      "https://assets.example/generated/delete-completion.jpg",
      userKey,
      1_771_000_000_000
    );

    expect(
      await Promise.resolve(
        getMessengerGenerationCompletion("req-delete-completion")
      )
    ).toEqual(expect.objectContaining({ userKey }));

    await expect(deleteUserData(psid)).resolves.toEqual({
      status: "completed",
    });

    expect(
      await Promise.resolve(
        getMessengerGenerationCompletion("req-delete-completion")
      )
    ).toBeNull();
  });

  it("deletes cost ledger entries for the erased user", async () => {
    const psid = "delete-cost-ledger-user";
    const userKey = anonymizePsid(psid);
    const otherUserKey = anonymizePsid("other-cost-ledger-user");
    const recordedAt = new Date();
    const period = recordedAt.toISOString().slice(0, 10);

    await Promise.resolve(getOrCreateState(psid));
    await appendCostLedgerEntry(
      {
        id: "req-delete-cost:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey,
        reqId: "req-delete-cost",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      recordedAt
    );
    await appendCostLedgerEntry(
      {
        id: "req-keep-cost:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: otherUserKey,
        reqId: "req-keep-cost",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      recordedAt
    );

    await expect(deleteUserData(psid)).resolves.toEqual({
      status: "completed",
    });

    const remainingEntries = await readCostLedgerPeriod(period);
    expect(remainingEntries).toEqual([
      expect.objectContaining({
        id: "req-keep-cost:attempt-1",
        userKey: otherUserKey,
      }),
    ]);
  });

  it("deletes portal handoff tokens for the erased Messenger user key", async () => {
    const psid = "delete-handoff-token-user";
    const userKey = anonymizePsid(psid);

    await Promise.resolve(getOrCreateState(psid));

    await expect(deleteUserData(psid)).resolves.toEqual({
      status: "completed",
    });

    expect(
      deletePortalHandoffTokensForMessengerUserKeyMock
    ).toHaveBeenCalledWith(userKey);
  });

  it("deletes legacy state shadowed under the privacy-peppered user key", async () => {
    const psid = "delete-shadow-state-user";
    const userKey = anonymizePsid(psid);

    await Promise.resolve(
      writeState(userKey, {
        ...(await Promise.resolve(getOrCreateState(psid))),
        psid,
        userKey,
        stage: "PROCESSING",
        state: "PROCESSING",
      })
    );
    expect(await Promise.resolve(readState(userKey))).toMatchObject({
      psid,
      stage: "PROCESSING",
    });

    await expect(deleteUserData(psid)).resolves.toEqual({
      status: "completed",
    });

    expect(await Promise.resolve(getState(psid))).toBeNull();
    expect(await Promise.resolve(readState(userKey))).toBeNull();
  });

  it("sanitizes the active Page state and deletes the true legacy shadow", async () => {
    process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED = "true";
    const psid = "delete-page-scoped-state-user";
    const pageId = "delete-page-scoped-state-page";
    const userKey = anonymizePsid(psid);
    const sourceUrl =
      "https://assets.example/inbound-source/page-scoped-delete.jpg";
    storageDeleteMock.mockRejectedValueOnce(new Error("delete failed"));

    await Promise.resolve(
      writeState(userKey, {
        ...(await Promise.resolve(getOrCreateState(userKey))),
        psid,
        userKey,
        lastPrompt: "private legacy shadow prompt",
      })
    );

    await runWithMessengerRequestContext(pageId, async () => {
      await Promise.resolve(
        setPendingImage(psid, sourceUrl, Date.now(), "stored")
      );
      await Promise.resolve(
        setLastGenerationContext(psid, {
          prompt: "private page-scoped prompt",
        })
      );

      await expect(deleteUserData(psid)).resolves.toEqual({
        status: "pending",
      });

      const stateAfter = await Promise.resolve(getState(psid));
      expect(stateAfter?.lastPhotoUrl).toBeNull();
      expect(stateAfter?.pendingImageUrl).toBeUndefined();
      expect(stateAfter?.lastPrompt).toBeUndefined();
      expect(stateAfter?.pendingSourceImageDeleteUrl).toBe(sourceUrl);
    });

    expect(await Promise.resolve(readState(psid))).toBeNull();
    expect(await Promise.resolve(readState(userKey))).toBeNull();
  });

  it("preserves an unowned raw channel record during Page-scoped deletion", async () => {
    process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED = "true";
    const psid = "delete-page-state-with-ambiguous-raw-user";
    const pageId = "delete-page-state-with-ambiguous-raw-page";
    const rawState = await Promise.resolve(getOrCreateState(psid));

    await Promise.resolve(
      writeState(psid, {
        ...rawState,
        lastPrompt: "private non-Messenger state",
      })
    );

    await runWithMessengerRequestContext(pageId, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await expect(deleteUserData(psid)).resolves.toEqual({
        status: "completed",
      });
      expect(await Promise.resolve(getState(psid))).toBeNull();
    });

    expect(await Promise.resolve(readState(psid))).toMatchObject({
      lastPrompt: "private non-Messenger state",
    });
  });

  it("keeps provider retry metadata without restoring deleted image state", async () => {
    const psid = "delete-step-failure-user";
    const imageUrl = "https://assets.example/inbound-source/fail-step.jpg";
    let state = await Promise.resolve(getOrCreateState(psid));

    await Promise.resolve(
      setPendingImage(psid, imageUrl, Date.now(), "stored")
    );
    state = await Promise.resolve(getState(psid));
    await Promise.resolve(
      writeState(psid, {
        ...state,
        lastGeneratedVideoProvider: "openai",
        lastGeneratedVideoProviderJobId: "video_job_fail",
      })
    );

    deleteProviderVideoForUserMock.mockRejectedValueOnce(
      new Error("temporary video artifact deletion failure")
    );

    await expect(deleteUserData(psid)).resolves.toEqual({ status: "pending" });

    const stateAfter = await Promise.resolve(getState(psid));
    expect(stateAfter).toMatchObject({
      userKey: state.userKey,
      lastPhotoUrl: null,
      lastPhoto: null,
      lastPhotoSource: null,
      lastGeneratedUrl: null,
      lastGeneratedVideoUrl: null,
      lastGeneratedVideoProvider: "openai",
      lastGeneratedVideoProviderJobId: "video_job_fail",
    });
    expect(stateAfter?.pendingImageUrl).toBeUndefined();
    expect(stateAfter?.pendingImageAt).toBeUndefined();
    expect(stateAfter?.lastImageUrl).toBeUndefined();
  });

  it("retains only non-image flow and provider retry context after successful storage deletion", async () => {
    const psid = "delete-step-failure-retry-state-user";
    const imageUrl = "https://assets.example/inbound-source/delete-my-data.jpg";
    const generatedUrl =
      "https://assets.example/generated/images/retry-result.jpg";
    const legacyImageUrl =
      "https://assets.example/generated/images/legacy-retry.jpg";
    const retainedFaceUrl =
      "https://assets.example/inbound-source/retry-retained-face.jpg";
    const generatedVideoUrl =
      "https://assets.example/generated/videos/retry-result.mp4";
    let state = await Promise.resolve(getOrCreateState(psid));

    await Promise.resolve(
      setPendingImage(psid, imageUrl, Date.now(), "stored")
    );
    state = await Promise.resolve(getState(psid));

    await Promise.resolve(
      writeState(psid, {
        ...state,
        stage: "PROCESSING",
        state: "PROCESSING",
        pendingScreenshotIntentContinuation: true,
        pendingEditIntent: "change_background",
        pendingDeleteConfirm: true,
        lastPrompt: "private prompt that must be erased",
        pendingConversationActions: [
          { id: "private-action", label: "Private action" },
        ],
        pendingConversationActionsByMessageId: {
          "private-message-id": [
            { id: "private-action", label: "Private action" },
          ],
        },
        faceMemoryConsent: {
          given: true,
          timestamp: Date.now(),
          version: "v1",
        },
        lastSourceImageUrl: retainedFaceUrl,
        lastSourceImageUpdatedAt: Date.now(),
        lastGeneratedUrl: generatedUrl,
        lastGeneratedAt: Date.now(),
        lastImageUrl: legacyImageUrl,
        lastGeneratedVideoUrl: generatedVideoUrl,
        lastGeneratedVideoAt: Date.now(),
        lastGeneratedVideoProvider: "openai",
        lastGeneratedVideoProviderJobId: "video_job_retry_state_fail",
      })
    );

    deleteProviderVideoForUserMock.mockRejectedValueOnce(
      new Error("temporary video artifact deletion failure")
    );
    await expect(deleteUserData(psid)).resolves.toEqual({ status: "pending" });

    const stateAfter = await Promise.resolve(getState(psid));
    expect(stateAfter).toEqual(
      expect.objectContaining({
        userKey: state.userKey,
        stage: "PROCESSING",
        state: "PROCESSING",
        pendingScreenshotIntentContinuation: true,
        pendingEditIntent: "change_background",
        lastPhotoUrl: null,
        lastPhoto: null,
        lastPhotoSource: null,
        faceMemoryConsent: null,
        lastSourceImageUrl: null,
        lastSourceImageUpdatedAt: null,
        lastGeneratedUrl: null,
        lastGeneratedVideoUrl: null,
        lastGeneratedVideoAt: null,
        lastGeneratedVideoProvider: "openai",
        lastGeneratedVideoProviderJobId: "video_job_retry_state_fail",
      })
    );
    expect(stateAfter?.pendingImageUrl).toBeUndefined();
    expect(stateAfter?.pendingImageAt).toBeUndefined();
    expect(stateAfter?.lastImageUrl).toBeUndefined();
    expect(stateAfter?.lastGeneratedAt).toBeUndefined();
    expect(stateAfter?.pendingSourceImageDeleteUrl).toBeNull();
    expect(stateAfter?.pendingSourceImageDeleteUrls).toBeNull();
    expect(stateAfter?.pendingDeleteConfirm).toBe(false);
    expect(stateAfter?.lastPrompt).toBeUndefined();
    expect(stateAfter?.pendingConversationActions).toBeUndefined();
    expect(stateAfter?.pendingConversationActionsByMessageId).toBeUndefined();
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/delete-my-data.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/retry-result.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/legacy-retry.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/retry-retained-face.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/videos/retry-result.mp4"
    );
  });

  it("keeps a pending deletion marker when object storage deletion fails", async () => {
    const psid = "delete-storage-failure-user";
    storageDeleteMock.mockRejectedValueOnce(new Error("delete failed"));

    await Promise.resolve(
      setPendingImage(
        psid,
        "https://assets.example/inbound-source/delete-me.jpg",
        Date.now(),
        "stored"
      )
    );

    await expect(deleteUserData(psid)).resolves.toEqual({ status: "pending" });

    expect(
      (await Promise.resolve(getState(psid)))?.pendingSourceImageDeleteUrl
    ).toBe("https://assets.example/inbound-source/delete-me.jpg");
    const stateAfter = await Promise.resolve(getState(psid));
    expect(stateAfter?.lastPhotoUrl).toBeNull();
    expect(stateAfter?.lastPhoto).toBeNull();
    expect(stateAfter?.pendingImageUrl).toBeUndefined();
    expect(stateAfter?.pendingImageAt).toBeUndefined();
  });

  it("reports failure when a required deletion step fails without retry state", async () => {
    const psid = "delete-step-failure-without-state-user";
    deletePortalHandoffTokensForMessengerUserKeyMock.mockRejectedValueOnce(
      new Error("temporary handoff-token deletion failure")
    );

    await expect(deleteUserData(psid)).resolves.toEqual({ status: "failed" });
    expect(await Promise.resolve(getState(psid))).toBeNull();
  });

  it("does not log raw PSIDs when object storage deletion fails", async () => {
    const psid = "delete-storage-log-user";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    storageDeleteMock.mockRejectedValueOnce(new Error("delete failed"));

    await Promise.resolve(
      setPendingImage(
        psid,
        "https://assets.example/inbound-source/delete-log.jpg",
        Date.now(),
        "stored"
      )
    );

    await deleteUserData(psid);

    const serializedLogs = JSON.stringify(logSpy.mock.calls);
    expect(serializedLogs).toContain("user_data_storage_delete_failed");
    expect(serializedLogs).not.toContain(psid);
    expect(serializedLogs).not.toContain("psid");
    logSpy.mockRestore();
  });

  it("keeps every failed object deletion marker during user erasure", async () => {
    const psid = "delete-multiple-storage-failure-user";
    const sourceUrl = "https://assets.example/inbound-source/source-fail.jpg";
    const generatedUrl =
      "https://assets.example/generated/images/generated-fail.jpg";
    storageDeleteMock.mockRejectedValue(new Error("delete failed"));

    await Promise.resolve(
      writeState(psid, {
        ...(await Promise.resolve(getOrCreateState(psid))),
        lastPhotoUrl: sourceUrl,
        lastPhoto: sourceUrl,
        lastPhotoSource: "stored",
        pendingImageUrl: sourceUrl,
        lastGeneratedUrl: generatedUrl,
      })
    );

    await deleteUserData(psid);

    const state = await Promise.resolve(getState(psid));
    expect(state?.pendingSourceImageDeleteUrl).toBe(sourceUrl);
    expect(state?.pendingSourceImageDeleteUrls).toEqual([
      sourceUrl,
      generatedUrl,
    ]);
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.lastPhoto).toBeNull();
    expect(state?.lastGeneratedUrl).toBeNull();
    expect(state?.pendingImageUrl).toBeUndefined();
  });

  it("merges face-memory and general deletion failures without deleting overlapping URLs twice", async () => {
    const psid = "delete-face-and-general-failure-user";
    const faceUrl = "https://assets.example/inbound-source/retained-face.jpg";
    const generatedUrl =
      "https://assets.example/generated/images/general-fail.jpg";
    storageDeleteMock.mockRejectedValue(new Error("delete failed"));

    await Promise.resolve(
      writeState(psid, {
        ...(await Promise.resolve(getOrCreateState(psid))),
        faceMemoryConsent: {
          given: true,
          timestamp: Date.now(),
          version: "v1",
        },
        lastSourceImageUrl: faceUrl,
        lastSourceImageUpdatedAt: Date.now(),
        pendingSourceImageDeleteUrl: faceUrl,
        pendingSourceImageDeleteUrls: [faceUrl],
        lastPhotoUrl: faceUrl,
        lastPhoto: faceUrl,
        lastPhotoSource: "stored",
        pendingImageUrl: faceUrl,
        lastGeneratedUrl: generatedUrl,
      })
    );

    await expect(deleteUserData(psid)).resolves.toEqual({ status: "pending" });

    const deletedKeys = storageDeleteMock.mock.calls.map(([key]) => key);
    expect(
      deletedKeys.filter(key => key === "inbound-source/retained-face.jpg")
    ).toHaveLength(1);
    expect(
      deletedKeys.filter(key => key === "generated/images/general-fail.jpg")
    ).toHaveLength(1);
    const state = await Promise.resolve(getState(psid));
    expect(state?.pendingSourceImageDeleteUrl).toBe(faceUrl);
    expect(state?.pendingSourceImageDeleteUrls).toEqual([
      faceUrl,
      generatedUrl,
    ]);
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.lastPhoto).toBeNull();
    expect(state?.lastSourceImageUrl).toBeNull();
    expect(state?.lastGeneratedUrl).toBeNull();
    expect(state?.pendingImageUrl).toBeUndefined();
  });

  it("deletes state-referenced source and generated objects during user erasure", async () => {
    const psid = "delete-all-state-images-user";
    const sourceUrl = "https://assets.example/inbound-source/user-source.jpg";
    const retainedSourceUrl =
      "https://assets.example/inbound-source/retained-source.jpg";
    const generatedUrl = "https://assets.example/generated/images/result.jpg";
    const legacyGeneratedUrl =
      "https://assets.example/generated/legacy-result.jpg";

    await Promise.resolve(
      writeState(psid, {
        ...(await Promise.resolve(getOrCreateState(psid))),
        lastPhotoUrl: sourceUrl,
        lastPhoto: sourceUrl,
        lastPhotoSource: "stored",
        pendingImageUrl: sourceUrl,
        lastSourceImageUrl: retainedSourceUrl,
        pendingSourceImageDeleteUrl: retainedSourceUrl,
        lastGeneratedUrl: generatedUrl,
        lastImageUrl: legacyGeneratedUrl,
      })
    );

    await deleteUserData(psid);

    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/user-source.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/retained-source.jpg"
    );
    expect(
      storageDeleteMock.mock.calls.filter(
        ([key]) => key === "inbound-source/retained-source.jpg"
      )
    ).toHaveLength(1);
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/result.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/legacy-result.jpg"
    );
    expect(await Promise.resolve(getState(psid))).toBeNull();
  });

  it("deletes provider-side generated video artifacts during user erasure", async () => {
    const psid = "delete-provider-video-user";
    const generatedVideoUrl =
      "https://assets.example/generated/videos/result.mp4";

    writeState(psid, {
      ...(await Promise.resolve(getOrCreateState(psid))),
      lastGeneratedVideoUrl: generatedVideoUrl,
      lastGeneratedVideoProvider: "openai",
      lastGeneratedVideoProviderJobId: "video_job_delete_me",
    });

    await deleteUserData(psid);

    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/videos/result.mp4"
    );
    expect(deleteProviderVideoForUserMock).toHaveBeenCalledWith({
      provider: "openai",
      providerJobId: "video_job_delete_me",
      reqId: "delete-my-data",
    });
    expect(await Promise.resolve(getState(psid))).toBeNull();
  });
});
