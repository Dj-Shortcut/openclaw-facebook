import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anonymizePsid,
  clearPendingImageState,
  findStateByUserKey,
  getOrCreateState,
  resetStateStore,
  setMessengerPageId,
  setMessengerOwnership,
  setPendingImage,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("messenger state flow", () => {
  beforeAll(() => {
    process.env.PRIVACY_PEPPER = TEST_PEPPER;
  });

  beforeEach(() => {
    resetStateStore();
  });

  afterAll(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }

    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("handles photo-first transition", () => {
    const userId = "photo-first-user";

    setPendingImage(userId, "https://img.example/pic.jpg", 1000);

    const state = getOrCreateState(userId);
    expect(state.stage).toBe("AWAITING_EDIT_PROMPT");
    expect(state.lastPhoto).toBe("https://img.example/pic.jpg");
    expect(state.hasSeenIntro).toBe(false);
  });

  it("clears stale generated image pointers when a new photo becomes pending", () => {
    const userId = "fresh-photo-user";
    const state = getOrCreateState(userId);
    state.lastGeneratedUrl = "https://img.example/old-generated.jpg";
    state.lastImageUrl = "https://img.example/old-image.jpg";

    setPendingImage(userId, "https://img.example/new-photo.jpg", 1000);

    const updated = getOrCreateState(userId);
    expect(updated.lastPhotoUrl).toBe("https://img.example/new-photo.jpg");
    expect(updated.lastGeneratedUrl).toBeNull();
    expect(updated.lastImageUrl).toBeUndefined();
  });

  it("clears stale generated image pointers when pending image state is cleared", () => {
    const userId = "clear-pending-photo-user";
    setPendingImage(userId, "https://img.example/new-photo.jpg", 1000);
    const state = getOrCreateState(userId);
    state.lastGeneratedUrl = "https://img.example/old-generated.jpg";
    state.lastImageUrl = "https://img.example/old-image.jpg";

    clearPendingImageState(userId, 2000);

    const updated = getOrCreateState(userId);
    expect(updated.lastPhotoUrl).toBeNull();
    expect(updated.lastPhoto).toBeNull();
    expect(updated.lastGeneratedUrl).toBeNull();
    expect(updated.lastImageUrl).toBeUndefined();
  });

  it("hashes PSID deterministically", () => {
    const first = anonymizePsid("12345");
    const second = anonymizePsid("12345");
    const other = anonymizePsid("abcde");

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });

  it("finds an existing Messenger state by privacy-peppered user key", async () => {
    const psid = "lookup-user-by-key";
    const pageId = "lookup-page";
    const state = await runWithMessengerRequestContext(pageId, async () => {
      const created = await getOrCreateState(psid);
      await setMessengerPageId(psid, pageId);
      return created;
    });

    await expect(
      findStateByUserKey(state.userKey, pageId)
    ).resolves.toMatchObject({
      psid,
      userKey: state.userKey,
    });
    await expect(
      findStateByUserKey(anonymizePsid("missing-user"), pageId)
    ).resolves.toBeNull();
    await expect(findStateByUserKey(state.userKey)).resolves.toBeNull();
  });

  it("finds webhook-created fenced state from an outbox without ALS and rejects a rebind", async () => {
    const psid = "background-fenced-user";
    const pageId = "background-fenced-page";
    const fence = {
      workspaceId: 71,
      channelConnectionId: 19,
      bindingEpoch: 4,
      privacyEpoch: 2,
    };
    const state = await runWithMessengerRequestContext(
      pageId,
      async () => {
        const created = await getOrCreateState(psid);
        await setMessengerPageId(psid, pageId);
        await setMessengerOwnership(psid, fence);
        return getOrCreateState(psid);
      },
      { ...fence, userKey: anonymizePsid(psid) }
    );

    await expect(
      findStateByUserKey(state.userKey, pageId, fence)
    ).resolves.toMatchObject({ psid, ...fence });
    await expect(
      findStateByUserKey(state.userKey, pageId, {
        ...fence,
        workspaceId: 72,
        bindingEpoch: 5,
      })
    ).resolves.toBeNull();
  });
});
