import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storageDeleteMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    storageDelete: storageDeleteMock,
  };
});

import { handleMessengerConsentGate } from "./_core/consentService";
import {
  anonymizePsid,
  getOrCreateState,
  getState,
  rememberFaceSourceImage,
  resetStateStore,
  setConsentState,
  setLastGenerated,
  setPendingStoredImage,
} from "./_core/messengerState";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./_core/messengerGenerationCompletion";

describe("Messenger consent deletion flow", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    process.env.PRIVACY_PEPPER = "consent-service-test-pepper";
    resetStateStore();
    storageDeleteMock.mockClear();
  });

  afterEach(() => {
    resetStateStore();
    storageDeleteMock.mockReset();
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

  it("deletes state, retained source assets, generated assets, and completion markers after confirmation", async () => {
    const psid = "messenger-delete-command-user";
    const userKey = anonymizePsid(psid);
    const sourceUrl = "https://assets.example/inbound-source/delete-command-source.jpg";
    const retainedUrl = "https://assets.example/inbound-source/delete-command-retained.jpg";
    const generatedUrl = "https://assets.example/generated/images/delete-command-result.jpg";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setConsentState(psid, true));
    await Promise.resolve(setPendingStoredImage(psid, sourceUrl));
    await Promise.resolve(rememberFaceSourceImage(psid, retainedUrl));
    await Promise.resolve(setLastGenerated(psid, generatedUrl));
    await markMessengerGenerationCompleted(
      "req-delete-command",
      generatedUrl,
      userKey,
      1_771_000_000_000
    );

    const initialState = await Promise.resolve(getState(psid));
    expect(initialState).not.toBeNull();

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        text: "delete my data",
        state: initialState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(sendActions).toHaveBeenCalledWith(
      expect.stringContaining("This will delete all data"),
      expect.arrayContaining([
        expect.objectContaining({ id: "GDPR_DELETE_CONFIRM" }),
      ])
    );

    const confirmationState = await Promise.resolve(getState(psid));
    expect(confirmationState?.pendingDeleteConfirm).toBe(true);

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        text: "yes",
        state: confirmationState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/delete-command-source.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/delete-command-retained.jpg"
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/delete-command-result.jpg"
    );
    expect(
      await Promise.resolve(getMessengerGenerationCompletion("req-delete-command"))
    ).toBeNull();
    expect(await Promise.resolve(getState(psid))).toBeNull();
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("Your data has been deleted")
    );
  });
});
