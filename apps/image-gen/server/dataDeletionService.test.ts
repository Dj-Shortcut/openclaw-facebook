import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storageDeleteMock, deleteProviderVideoForUserMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
  deleteProviderVideoForUserMock: vi.fn(async () => undefined),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    storageDelete: storageDeleteMock,
  };
});
vi.mock("./_core/video-generation/videoProviderRegistry", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/video-generation/videoProviderRegistry")>();
  return {
    ...actual,
    deleteProviderVideoForUser: deleteProviderVideoForUserMock,
  };
});
import { deleteUserData } from "./_core/dataDeletionService";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./_core/messengerGenerationCompletion";
import {
  anonymizePsid,
  getOrCreateState,
  getState,
  resetStateStore,
  setPendingImage,
} from "./_core/messengerState";
import { readScopedState, writeScopedState, writeState } from "./_core/stateStore";

describe("data deletion service", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    process.env.PRIVACY_PEPPER = "data-deletion-test-pepper";
    resetStateStore();
  });

  afterEach(() => {
    resetStateStore();
    storageDeleteMock.mockReset();
    deleteProviderVideoForUserMock.mockReset();
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

    expect(await Promise.resolve(readScopedState("chat:history", userKey))).toEqual([
      expect.objectContaining({ text: "old chat" }),
    ]);

    await deleteUserData(psid);

    expect(await Promise.resolve(readScopedState("chat:history", userKey))).toBeNull();
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

    await deleteUserData(psid);

    expect(
      await Promise.resolve(
        getMessengerGenerationCompletion("req-delete-completion")
      )
    ).toBeNull();
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

    await deleteUserData(psid);

    expect((await Promise.resolve(getState(psid)))?.pendingSourceImageDeleteUrl).toBe(
      "https://assets.example/inbound-source/delete-me.jpg"
    );
  });

  it("keeps every failed object deletion marker during user erasure", async () => {
    const psid = "delete-multiple-storage-failure-user";
    const sourceUrl = "https://assets.example/inbound-source/source-fail.jpg";
    const generatedUrl = "https://assets.example/generated/images/generated-fail.jpg";
    storageDeleteMock.mockRejectedValue(new Error("delete failed"));

    writeState(psid, {
      ...(await Promise.resolve(getOrCreateState(psid))),
      lastPhotoUrl: sourceUrl,
      lastPhoto: sourceUrl,
      lastPhotoSource: "stored",
      pendingImageUrl: sourceUrl,
      lastGeneratedUrl: generatedUrl,
    });

    await deleteUserData(psid);

    const state = await Promise.resolve(getState(psid));
    expect(state?.pendingSourceImageDeleteUrl).toBe(sourceUrl);
    expect(state?.pendingSourceImageDeleteUrls).toEqual([
      sourceUrl,
      generatedUrl,
    ]);
  });

  it("deletes state-referenced source and generated objects during user erasure", async () => {
    const psid = "delete-all-state-images-user";
    const sourceUrl = "https://assets.example/inbound-source/user-source.jpg";
    const retainedSourceUrl =
      "https://assets.example/inbound-source/retained-source.jpg";
    const generatedUrl = "https://assets.example/generated/images/result.jpg";
    const legacyGeneratedUrl = "https://assets.example/generated/legacy-result.jpg";

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
    });

    await deleteUserData(psid);

    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/user-source.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/retained-source.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/result.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/legacy-result.jpg");
    expect(await Promise.resolve(getState(psid))).toBeNull();
  });

  it("deletes provider-side generated video artifacts during user erasure", async () => {
    const psid = "delete-provider-video-user";
    const generatedVideoUrl = "https://assets.example/generated/videos/result.mp4";

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
