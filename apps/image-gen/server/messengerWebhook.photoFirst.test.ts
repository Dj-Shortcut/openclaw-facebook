import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
  safeLogMock,
} = vi.hoisted(() => ({
  sendImageMock: vi.fn(async () => ({ sent: true })),
  sendQuickRepliesMock: vi.fn(async () => ({ sent: true })),
  sendTextMock: vi.fn(async () => ({ sent: true })),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/messengerApi", () => ({
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
  safeLog: safeLogMock,
}));

import {
  processFacebookWebhookPayload as processFacebookWebhookPayloadBase,
  resetMessengerEventDedupe,
} from "./_core/messengerWebhook";
import { t } from "./_core/i18n";
import { anonymizePsid, getState, resetStateStore } from "./_core/messengerState";
import {
  setSourceImageDnsLookupForTests,
  setSourceImageRequestForTests,
} from "./_core/image-generation/sourceImageFetcher";
import { processConsentedFacebookWebhookPayload } from "./testConsentHelpers";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const originalEnableFaceMemory = process.env.ENABLE_FACE_MEMORY;
const originalFaceMemoryRetentionDays =
  process.env.FACE_MEMORY_RETENTION_DAYS;

const processFacebookWebhookPayload = processConsentedFacebookWebhookPayload(
  processFacebookWebhookPayloadBase
);

function installSourceImageRequestHook(): void {
  setSourceImageRequestForTests(async sourceImageUrl => {
    const response = await fetch(sourceImageUrl, { redirect: "manual" });
    return {
      response,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  });
}

describe("photo-first onboarding", () => {
  beforeAll(() => {
    process.env.PRIVACY_PEPPER = TEST_PEPPER;
  });

  beforeEach(() => {
    setSourceImageDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    installSourceImageRequestHook();
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS =
      "img.example,lookaside.fbsbx.com,leaderbot-fb-image-gen.fly.dev";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    delete process.env.FACE_MEMORY_RETENTION_DAYS;
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    const sourceImage = Buffer.alloc(6000, 7);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const urlString = typeof url === "string" ? url : url.toString();
        if (
          urlString.startsWith("https://img.example/") ||
          urlString.startsWith("https://leaderbot-fb-image-gen.fly.dev/generated/")
        ) {
          return {
            ok: true,
            headers: new Headers({ "content-type": "image/jpeg" }),
            arrayBuffer: async () => sourceImage,
          } as Response;
        }

        throw new Error(`Unexpected fetch in messengerWebhook.photoFirst.test: ${urlString}`);
      })
    );
    resetStateStore();
    resetMessengerEventDedupe();
  });

  afterEach(() => {
    setSourceImageRequestForTests(null);
    setSourceImageDnsLookupForTests(null);
    vi.unstubAllGlobals();
    if (originalEnableFaceMemory === undefined) {
      delete process.env.ENABLE_FACE_MEMORY;
    } else {
      process.env.ENABLE_FACE_MEMORY = originalEnableFaceMemory;
    }
    if (originalFaceMemoryRetentionDays === undefined) {
      delete process.env.FACE_MEMORY_RETENTION_DAYS;
    } else {
      process.env.FACE_MEMORY_RETENTION_DAYS = originalFaceMemoryRetentionDays;
    }
  });

  afterAll(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }

    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("handles inbound image attachment by setting pending image and asking for an edit prompt", async () => {
    const psid = "photo-first-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-photo-first",
                attachments: [{ type: "image", payload: { url: "https://img.example/source.jpg" } }],
              },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.lastPhotoUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.png$/
    );
    expect(userState?.lastPhotoSource).toBe("stored");
    expect(userState?.stage).toBe("AWAITING_EDIT_PROMPT");
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "photoEditPrompt"),
      [
        {
          content_type: "text",
          title: "Pas aan",
          payload: "OPENCLAW_ACTION:Pas%20aan",
        },
        {
          content_type: "text",
          title: "Andere achtergrond",
          payload: "OPENCLAW_ACTION:change_background",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ]
    );
  });

  it("asks explicit face-memory consent behind the feature flag and stores consent on yes", async () => {
    process.env.ENABLE_FACE_MEMORY = "true";
    const psid = "face-memory-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-photo",
                attachments: [{ type: "image", payload: { url: "https://img.example/source.jpg" } }],
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      expect.stringContaining("Mag ik je foto 30 dagen bewaren?"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "CONSENT_FACE_YES" }),
        expect.objectContaining({ payload: "CONSENT_FACE_NO" }),
      ])
    );

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-yes",
                quick_reply: { payload: "CONSENT_FACE_YES" },
              },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.pendingImageUrl).toBe(userState?.lastPhotoUrl);
    expect(userState?.faceMemoryConsent).toEqual(
      expect.objectContaining({ given: true, version: "v1" })
    );
    expect(userState?.lastSourceImageUrl).toBe(userState?.lastPhotoUrl);
    expect(userState?.lastSourceImageUpdatedAt).toEqual(expect.any(Number));
  });

  it("deletes retained face-memory data after confirmation", async () => {
    process.env.ENABLE_FACE_MEMORY = "true";
    const psid = "face-memory-delete-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-delete-photo",
                attachments: [{ type: "image", payload: { url: "https://img.example/source.jpg" } }],
              },
            },
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-delete-yes",
                quick_reply: { payload: "CONSENT_FACE_YES" },
              },
            },
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-delete-command",
                text: "verwijder mijn data",
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      expect.stringContaining("data"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "GDPR_DELETE_CONFIRM" }),
        expect.objectContaining({ payload: "GDPR_DELETE_CANCEL" }),
      ])
    );
    expect(getState(anonymizePsid(psid))?.lastSourceImageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.png$/
    );

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-delete-confirm",
                quick_reply: { payload: "GDPR_DELETE_CONFIRM" },
              },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState).toEqual(
      expect.objectContaining({
        faceMemoryConsent: null,
        lastPhotoUrl: null,
        lastSourceImageUrl: null,
        pendingSourceImageDeleteUrl: expect.stringMatching(
          /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.png$/
        ),
      })
    );
    expect(sendTextMock).toHaveBeenCalledWith(
      psid,
      expect.stringContaining("Je data is verwijderd")
    );
  });

  it("records face-memory consent even when the pending image is gone", async () => {
    process.env.ENABLE_FACE_MEMORY = "true";
    const psid = "face-memory-consent-without-photo-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-consent-without-photo",
                quick_reply: { payload: "CONSENT_FACE_YES" },
              },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.faceMemoryConsent).toEqual(
      expect.objectContaining({ given: true, version: "v1" })
    );
    expect(userState?.lastSourceImageUrl).toBeNull();
  });

  it("ignores stale face-memory consent payloads when the feature is disabled", async () => {
    delete process.env.ENABLE_FACE_MEMORY;
    const psid = "face-memory-disabled-consent-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-face-memory-disabled-yes",
                quick_reply: { payload: "CONSENT_FACE_YES" },
              },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.faceMemoryConsent).toBeNull();
    expect(userState?.lastSourceImageUrl).toBeNull();
    expect(userState?.stage).toBe("IDLE");
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "OPENCLAW_ACTION:new_image" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Pas%20foto%20aan" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Privacy" }),
      ])
    );
  });

  it("shows intro once and keeps prompt-first idle state", async () => {
    const psid = "text-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-hi", text: "Hi" },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.stage).toBe("IDLE");
    expect(userState?.hasSeenIntro).toBe(true);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.any(Array),
    );
  });


  it("keeps later greetings prompt-first with quick actions", async () => {
    const psid = "repeat-hi-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-repeat-1", text: "Hi" },
            },
          ],
        },
      ],
    });

    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-repeat-2", text: "hi" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "OPENCLAW_ACTION:new_image" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Pas%20foto%20aan" }),
        expect.objectContaining({ payload: "OPENCLAW_ACTION:Privacy" }),
      ])
    );
  });

  it("ignores removed legacy style text without re-entering photo-first state", async () => {
    const psid = "guard-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-style", text: "disco" },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.stage).toBe("IDLE");
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      [
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:new_image",
        },
        {
          content_type: "text",
          title: "Pas foto aan",
          payload: "OPENCLAW_ACTION:Pas%20foto%20aan",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ]
    );
  });

  it("ignores unknown DOWNLOAD_HD payload without mutating state", async () => {
    const psid = "download-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              postback: { payload: "DOWNLOAD_HD" },
            },
          ],
        },
      ],
    });

    const userState = getState(anonymizePsid(psid));
    expect(userState?.stage).toBe("IDLE");
    expect(userState?.hasSeenIntro).toBe(false);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith("unknown_payload", expect.any(Object));
  });

  it("returns privacy explanation on privacy action input", async () => {
    const psid = "privacy-user";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-privacy-action",
                quick_reply: { payload: "OPENCLAW_ACTION:Privacy" },
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      psid,
      [
        "Je foto wordt enkel gebruikt om de afbeelding te maken.",
        "Ze wordt daarna niet bewaard.",
        "Privacybeleid: https://leaderbot-fb-image-gen.fly.dev/privacy",
      ].join("\n")
    );
  });

  it("routes free-form user text without photo into prompt-first quick actions", async () => {
    const psid = "about-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-about", text: "Wie zit hierachter?" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      [
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:new_image",
        },
        {
          content_type: "text",
          title: "Pas foto aan",
          payload: "OPENCLAW_ACTION:Pas%20foto%20aan",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ]
    );
  });

  it("uses sender locale when provided and reuses it for later events", async () => {
    const psid = "locale-user";

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid, locale: "en_US" },
              message: { mid: "mid-locale-1", text: "Hi" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.any(Array),
    );

    sendQuickRepliesMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-privacy-action-en",
                quick_reply: { payload: "OPENCLAW_ACTION:Privacy" },
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenLastCalledWith(
      psid,
      [
        "Your photo is only used to make the image.",
        "It is not stored afterwards.",
        "Privacy policy: https://leaderbot-fb-image-gen.fly.dev/privacy",
      ].join("\n")
    );
  });

});
