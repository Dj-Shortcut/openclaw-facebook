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
  setConsentPromptedAt,
  setConsentState,
  setLastGenerated,
  setPendingDeleteConfirm,
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
  });

  it("accepts the visible Messenger consent label as a text fallback", async () => {
    const psid = "messenger-consent-text-fallback-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const state = await Promise.resolve(getOrCreateState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Ik ga akkoord",
        state,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(true);
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("Je toestemming is geregistreerd")
    );
    expect(sendActions).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.objectContaining({ id: "new_image" })])
    );
  });

  it.each([
    "Die toestemming heb je",
    "Mijn toestemming heb je",
    "Mijnt toestemming heb je van mij",
    "Je hebt mijn toesteming",
    "Permission granted",
    "Ik geef mijn toestemming",
    "Hierbij geef ik je mijn toestemming",
    "U hebt mijn akkoord",
    "Jullie hebben mijn toestemming",
    "Ik stem hiermee in",
    "I consent",
    "Ja, ik ga akkoord",
    "Yes, I do agree",
    "akoord",
    "akord",
    "akkoort",
    "accoort",
    "I aggre",
    "Ja akkoord, geen probleem",
    "No problem, I agree",
  ])(
    "accepts conservative explicit consent phrases and supported typos: %s",
    async consentText => {
      const psid = `messenger-consent-typo-${consentText}`;
      const sendText = vi.fn(async () => undefined);
      const sendActions = vi.fn(async () => undefined);
      const state = await Promise.resolve(getOrCreateState(psid));

      await expect(
        handleMessengerConsentGate({
          psid,
          lang: "nl",
          text: consentText,
          state,
          sendText,
          sendActions,
        })
      ).resolves.toBe(true);

      expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(true);
    }
  );

  it("accepts a short contextual acknowledgement only after the notice was shown", async () => {
    const psid = "messenger-consent-contextual-ok-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const initialState = await Promise.resolve(getOrCreateState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Is ok",
        state: initialState,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(false);
    expect((await Promise.resolve(getState(psid)))?.consentPromptedAt).toEqual(
      expect.any(Number)
    );
    expect(sendText).not.toHaveBeenCalled();

    const promptedState = await Promise.resolve(getState(psid));
    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Is ok",
        state: promptedState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(true);
    expect(
      (await Promise.resolve(getState(psid)))?.consentPromptedAt
    ).toBeUndefined();
  });

  it.each(["Goed", "Dat mag", "Doe maar", "Ga maar door", "Sure", "Go ahead"])(
    "accepts a common short acknowledgement only in fresh prompt context: %s",
    async acknowledgement => {
      const psid = `messenger-consent-contextual-${acknowledgement}`;
      const sendText = vi.fn(async () => undefined);
      const sendActions = vi.fn(async () => undefined);
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentPromptedAt(psid));
      const promptedState = await Promise.resolve(getState(psid));

      await expect(
        handleMessengerConsentGate({
          psid,
          lang: "nl",
          text: acknowledgement,
          state: promptedState!,
          sendText,
          sendActions,
        })
      ).resolves.toBe(true);

      expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(true);
    }
  );

  it("does not accept a contextual acknowledgement after the 15-minute prompt window", async () => {
    const psid = "messenger-consent-stale-context-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(
      setConsentPromptedAt(psid, Date.now() - 15 * 60 * 1000 - 1)
    );
    const stalePromptState = await Promise.resolve(getState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Is ok",
        state: stalePromptState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendActions).toHaveBeenCalledWith(
      expect.stringContaining("toestemming"),
      expect.any(Array)
    );
  });

  it.each([
    "misschien akkoord later",
    "I might agree later",
    "I agree, I guess",
    "I agree, unless something changes",
    "I agree, but I revoke my consent",
    "Ik ga akkoord, maar ik trek mijn toestemming in",
  ])(
    "reprompts instead of treating qualified or uncertain wording as consent: %s",
    async text => {
      const psid = `messenger-consent-deferred-${text}`;
      const sendText = vi.fn(async () => undefined);
      const sendActions = vi.fn(async () => undefined);
      const state = await Promise.resolve(getOrCreateState(psid));

      await expect(
        handleMessengerConsentGate({
          psid,
          lang: "nl",
          text,
          state,
          sendText,
          sendActions,
        })
      ).resolves.toBe(true);

      expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(false);
      expect(sendText).not.toHaveBeenCalled();
      expect(sendActions).toHaveBeenCalledWith(
        expect.stringContaining("toestemming"),
        expect.any(Array)
      );
    }
  );

  it.each(["free", "tree", "green", "degree", "you have my content"])(
    "never turns an ordinary near-match into consent: %s",
    async text => {
      const psid = `messenger-consent-near-match-${text}`;
      const sendText = vi.fn(async () => undefined);
      const sendActions = vi.fn(async () => undefined);
      const state = await Promise.resolve(getOrCreateState(psid));

      await expect(
        handleMessengerConsentGate({
          psid,
          lang: "nl",
          text,
          state,
          sendText,
          sendActions,
        })
      ).resolves.toBe(true);

      expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(false);
      expect(sendActions).toHaveBeenCalledWith(
        expect.stringContaining("toestemming"),
        expect.any(Array)
      );
    }
  );

  it.each([
    "niet akoord",
    "ik ga niet akkoort",
    "Ik kan niet akkoord gaan",
    "Nooit akkoord",
    "Mijn toestemming heb je niet",
    "Je hebt geen toestemming van mij",
    "Is niet ok",
    "I do not aggre",
    "I won't agree",
    "I cannot agree",
    "I never agree",
    "ok maar niet met mijn foto",
  ])("never treats a negated typo as consent: %s", async consentText => {
    const psid = `messenger-consent-negated-${consentText}`;
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const state = await Promise.resolve(getOrCreateState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: consentText,
        state,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(false);
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("Zonder je toestemming")
    );
  });

  it("preserves a typed decline and never presents the consent actions again", async () => {
    const psid = "messenger-consent-persistent-decline-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const initialState = await Promise.resolve(getOrCreateState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Nee bedankt",
        state: initialState,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    const declinedState = await Promise.resolve(getState(psid));
    const declinedAt = declinedState?.consentDeclinedAt;
    expect(declinedState?.consentGiven).toBe(false);
    expect(declinedAt).toEqual(expect.any(Number));

    sendText.mockClear();
    sendActions.mockClear();

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Maak mijn foto wat lichter",
        state: declinedState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect((await Promise.resolve(getState(psid)))?.consentDeclinedAt).toBe(
      declinedAt
    );
    expect(sendActions).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("Zonder je toestemming")
    );
  });

  it("accepts a new explicit consent grant after an earlier decline", async () => {
    const psid = "messenger-consent-reconsidered-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setConsentState(psid, false));
    const declinedState = await Promise.resolve(getState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Ik ga akkoord",
        state: declinedState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(await Promise.resolve(getState(psid))).toMatchObject({
      consentGiven: true,
      consentDeclinedAt: undefined,
    });
  });

  it.each([
    "Akkoord?",
    "Is dit ok?",
    "Waarom heb je toestemming nodig?",
    "Heb je mijn toestemming?",
  ])(
    "reprompts instead of treating a consent question as agreement: %s",
    async text => {
      const psid = `messenger-consent-question-${text}`;
      const sendText = vi.fn(async () => undefined);
      const sendActions = vi.fn(async () => undefined);
      const state = await Promise.resolve(getOrCreateState(psid));

      await expect(
        handleMessengerConsentGate({
          psid,
          lang: "nl",
          text,
          state,
          sendText,
          sendActions,
        })
      ).resolves.toBe(true);

      expect((await Promise.resolve(getState(psid)))?.consentGiven).toBe(false);
      expect(sendText).not.toHaveBeenCalled();
      expect(sendActions).toHaveBeenCalledWith(
        expect.stringContaining("toestemming"),
        expect.any(Array)
      );
    }
  );

  it("explains the text fallback when Messenger does not show consent pills", async () => {
    const psid = "messenger-consent-missing-pills-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const state = await Promise.resolve(getOrCreateState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Hallo",
        state,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(sendActions).toHaveBeenCalledWith(
      expect.stringContaining("IK GA AKKOORD"),
      expect.arrayContaining([
        expect.objectContaining({ id: "GDPR_CONSENT_AGREE" }),
        expect.objectContaining({ id: "GDPR_CONSENT_DECLINE" }),
      ])
    );
  });

  it("does not mark the notice as delivered when controls and text both fail", async () => {
    const psid = "messenger-consent-undelivered-notice-user";
    const sendText = vi.fn(async () => false);
    const sendActions = vi.fn(async () => false);
    const state = await Promise.resolve(getOrCreateState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "nl",
        text: "Hallo",
        state,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(
      (await Promise.resolve(getState(psid)))?.consentPromptedAt
    ).toBeUndefined();
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

  it("does not arm deletion when Messenger fails to deliver the warning controls", async () => {
    const psid = "messenger-delete-controls-undelivered-user";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => false);

    await Promise.resolve(getOrCreateState(psid));
    const state = await Promise.resolve(getState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        text: "delete my data",
        state: state!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(await Promise.resolve(getState(psid))).toMatchObject({
      pendingDeleteConfirm: false,
      pendingDeleteConfirmAt: undefined,
    });
  });

  it("rejects a stale delete postback after cancellation without deleting data", async () => {
    const psid = "messenger-delete-cancelled-stale-postback-user";
    const sourceUrl =
      "https://assets.example/inbound-source/cancelled-delete-source.jpg";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setPendingStoredImage(psid, sourceUrl));
    const initialState = await Promise.resolve(getState(psid));

    await handleMessengerConsentGate({
      psid,
      lang: "en",
      text: "delete my data",
      state: initialState!,
      sendText,
      sendActions,
    });
    const pendingState = await Promise.resolve(getState(psid));

    await handleMessengerConsentGate({
      psid,
      lang: "en",
      payload: "GDPR_DELETE_CANCEL",
      state: pendingState!,
      sendText,
      sendActions,
    });
    const cancelledState = await Promise.resolve(getState(psid));
    sendText.mockClear();
    storageDeleteMock.mockClear();

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        payload: "GDPR_DELETE_CONFIRM",
        state: cancelledState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(await Promise.resolve(getState(psid))).toMatchObject({
      lastPhotoUrl: sourceUrl,
      pendingDeleteConfirm: false,
    });
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("confirmation has expired")
    );
  });

  it("rejects an expired active delete confirmation without deleting data", async () => {
    const psid = "messenger-delete-expired-confirmation-user";
    const sourceUrl =
      "https://assets.example/inbound-source/expired-delete-source.jpg";
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setPendingStoredImage(psid, sourceUrl));
    await Promise.resolve(
      setPendingDeleteConfirm(psid, true, Date.now() - 15 * 60 * 1000 - 1)
    );
    const expiredState = await Promise.resolve(getState(psid));

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        payload: "GDPR_DELETE_CONFIRM",
        state: expiredState!,
        sendText,
        sendActions,
      })
    ).resolves.toBe(true);

    expect(await Promise.resolve(getState(psid))).toMatchObject({
      lastPhotoUrl: sourceUrl,
      pendingDeleteConfirm: false,
    });
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("confirmation has expired")
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
    await Promise.resolve(setPendingDeleteConfirm(psid, true));
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
    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setPendingDeleteConfirm(psid, true));
    const staleState = await Promise.resolve(getState(psid));

    await Promise.resolve(clearUserState(psid));
    deletePortalHandoffTokensForMessengerUserKeyMock.mockRejectedValueOnce(
      new Error("temporary handoff-token deletion failure")
    );

    await expect(
      handleMessengerConsentGate({
        psid,
        lang: "en",
        payload: "GDPR_DELETE_CONFIRM",
        state: staleState!,
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

  it("rejects a stale WhatsApp delete reply without deleting data", async () => {
    const senderId = "whatsapp-stale-delete-confirm-user";
    const sourceUrl =
      "https://assets.example/inbound-source/whatsapp-stale-delete.jpg";
    const sendText = vi.fn(async () => undefined);
    const sendButtons = vi.fn(async () => undefined);

    await Promise.resolve(getOrCreateState(senderId));
    await Promise.resolve(setPendingStoredImage(senderId, sourceUrl));
    const state = await Promise.resolve(getState(senderId));

    await expect(
      handleWhatsAppConsentGate({
        event: {
          channel: "whatsapp",
          messageId: "wamid-stale-delete-confirm",
          messageType: "text",
          senderId,
          userId: senderId,
          timestamp: 1_771_000_000,
          rawEventMeta: { interactiveReplyId: "GDPR_DELETE_CONFIRM" },
        },
        lang: "en",
        state: state!,
        sendText,
        sendButtons,
      })
    ).resolves.toBe(true);

    expect(await Promise.resolve(getState(senderId))).toMatchObject({
      lastPhotoUrl: sourceUrl,
      pendingDeleteConfirm: false,
    });
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      expect.stringContaining("confirmation has expired")
    );
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
    await Promise.resolve(setPendingDeleteConfirm(senderId, true));
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
