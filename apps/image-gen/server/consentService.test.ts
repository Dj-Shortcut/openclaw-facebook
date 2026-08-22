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

import {
  handleMessengerConsentGate,
  handleWhatsAppConsentGate,
} from "./_core/consentService";
import {
  anonymizePsid,
  clearUserState,
  getOrCreateState,
  getState,
  rememberFaceSourceImage,
  resetStateStore,
  setConsentState,
  setLastGenerated,
  setPendingStoredImage,
} from "./_core/messengerState";
import { writeState } from "./_core/stateStore";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./_core/messengerGenerationCompletion";

describe("Messenger consent deletion flow", () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    process.env.PRIVACY_PEPPER = "consent-service-test-pepper";
    resetStateStore();
    storageDeleteMock.mockReset();
    storageDeleteMock.mockResolvedValue(undefined);
    deleteProviderVideoForUserMock.mockReset();
    deleteProviderVideoForUserMock.mockResolvedValue(undefined);
    deletePortalHandoffTokensForMessengerUserKeyMock.mockReset();
    deletePortalHandoffTokensForMessengerUserKeyMock.mockResolvedValue(0);
  });

  afterEach(() => {
    resetStateStore();
    storageDeleteMock.mockReset();
    deleteProviderVideoForUserMock.mockReset();
    deletePortalHandoffTokensForMessengerUserKeyMock.mockReset();
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
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("deletes state, retained source assets, generated assets, and completion markers after confirmation", async () => {
    const psid = "messenger-delete-command-user";
    const userKey = anonymizePsid(psid);
    const sourceUrl =
      "https://assets.example/inbound-source/delete-command-source.jpg";
    const retainedUrl =
      "https://assets.example/inbound-source/delete-command-retained.jpg";
    const generatedUrl =
      "https://assets.example/generated/images/delete-command-result.jpg";
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
      await Promise.resolve(
        getMessengerGenerationCompletion("req-delete-command")
      )
    ).toBeNull();
    expect(await Promise.resolve(getState(psid))).toBeNull();
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("Your data has been deleted")
    );
  });

  it("accepts polite delete-data command variants used in Messenger smoke tests", async () => {
    const psid = "messenger-delete-command-variant-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setConsentState(psid, true));

    const initialState = await Promise.resolve(getState(psid));
    expect(initialState).not.toBeNull();

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        text: "Delete my data aub",
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
    expect((await Promise.resolve(getState(psid)))?.pendingDeleteConfirm).toBe(
      true
    );
  });

  it("does not claim Messenger deletion succeeded when storage cleanup is pending", async () => {
    const psid = "messenger-delete-storage-pending-user";
    const sourceUrl =
      "https://assets.example/inbound-source/delete-storage-pending.jpg";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setPendingStoredImage(psid, sourceUrl));
    const state = await Promise.resolve(getState(psid));
    storageDeleteMock.mockRejectedValueOnce(new Error("delete failed"));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        payload: "GDPR_DELETE_CONFIRM",
        state: state!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(
      (await Promise.resolve(getState(psid)))?.pendingSourceImageDeleteUrl
    ).toBe(sourceUrl);
    expect((await Promise.resolve(getState(psid)))?.pendingDeleteConfirm).toBe(
      false
    );
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("couldn't finish deleting all your data yet")
    );
    expect(sendText).not.toHaveBeenCalledWith(
      expect.stringContaining("Your data has been deleted")
    );
  });

  it("sends failure copy when Messenger deletion has no safe retry state", async () => {
    const psid = "messenger-delete-failed-without-retry-state-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const staleState = await Promise.resolve(getOrCreateState(psid));

    await Promise.resolve(clearUserState(psid));
    process.env.NODE_ENV = "production";

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        payload: "GDPR_DELETE_CONFIRM",
        state: staleState,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("couldn't complete your data deletion request")
    );
    expect(sendText).not.toHaveBeenCalledWith(
      expect.stringContaining("Your data has been deleted")
    );
  });

  it("accepts Dutch delete-data command variants already classified by the gateway", async () => {
    const psid = "messenger-delete-command-gegevens-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setConsentState(psid, true));

    const initialState = await Promise.resolve(getState(psid));
    expect(initialState).not.toBeNull();

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "verwijder mijn gegevens a.u.b.",
        state: initialState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(sendActions).toHaveBeenCalledWith(
      expect.stringContaining("Dit verwijdert alle data"),
      expect.arrayContaining([
        expect.objectContaining({ id: "GDPR_DELETE_CONFIRM" }),
      ])
    );
    expect((await Promise.resolve(getState(psid)))?.pendingDeleteConfirm).toBe(
      true
    );
  });

  it("accepts polite WhatsApp delete-data command variants", async () => {
    const senderId = "whatsapp-delete-command-variant-user";
    const sendText = vi.fn(async () => undefined);
    const sendButtons = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(senderId));
    await Promise.resolve(setConsentState(senderId, true));

    const initialState = await Promise.resolve(getState(senderId));
    expect(initialState).not.toBeNull();

    await expect(
      handleWhatsAppConsentGate({
        event: {
          channel: "whatsapp",
          messageId: "wamid-delete-command-variant",
          messageType: "text",
          senderId,
          userId: senderId,
          textBody: "delete my data please",
          timestamp: 1_771_000_000,
        },
        lang: "en",
        state: initialState!,
        sendText,
        sendButtons,
      })
    ).resolves.toBe(true);

    expect(sendButtons).toHaveBeenCalledWith(
      expect.stringContaining("This will delete all data"),
      expect.arrayContaining([
        expect.objectContaining({ id: "GDPR_DELETE_CONFIRM" }),
      ])
    );
    expect(
      (await Promise.resolve(getState(senderId)))?.pendingDeleteConfirm
    ).toBe(true);
  });

  it("does not claim WhatsApp deletion succeeded when a required step is pending", async () => {
    const senderId = "whatsapp-delete-required-step-pending-user";
    const sendText = vi.fn(async () => undefined);
    const sendButtons = vi.fn(async () => undefined);
    const initialState = await Promise.resolve(getOrCreateState(senderId));

    await Promise.resolve(
      writeState(senderId, {
        ...initialState,
        lastGeneratedVideoProvider: "openai",
        lastGeneratedVideoProviderJobId: "video_job_delete_pending",
      })
    );
    const state = await Promise.resolve(getState(senderId));
    deleteProviderVideoForUserMock.mockRejectedValueOnce(
      new Error("temporary video artifact deletion failure")
    );

    await expect(
      handleWhatsAppConsentGate({
        event: {
          channel: "whatsapp",
          messageId: "wamid-delete-required-step-pending",
          messageType: "text",
          senderId,
          userId: senderId,
          timestamp: 1_771_000_000,
          rawEventMeta: { interactiveReplyId: "GDPR_DELETE_CONFIRM" },
        },
        lang: "nl",
        state: state!,
        sendText,
        sendButtons,
      })
    ).resolves.toBe(true);

    expect(await Promise.resolve(getState(senderId))).not.toBeNull();
    expect(
      (await Promise.resolve(getState(senderId)))?.pendingDeleteConfirm
    ).toBe(false);
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("nog niet al je data verwijderen")
    );
    expect(sendText).not.toHaveBeenCalledWith(
      expect.stringContaining("Je data is verwijderd")
    );
  });
});
