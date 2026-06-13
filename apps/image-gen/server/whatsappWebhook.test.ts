import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  downloadWhatsAppMediaMock,
  sendWhatsAppButtonsMock,
  sendWhatsAppImageMock,
  sendWhatsAppTextMock,
} = vi.hoisted(() => ({
  downloadWhatsAppMediaMock: vi.fn(),
  sendWhatsAppButtonsMock: vi.fn(async () => undefined),
  sendWhatsAppImageMock: vi.fn(async () => undefined),
  sendWhatsAppTextMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/whatsappApi", () => ({
  downloadWhatsAppMedia: downloadWhatsAppMediaMock,
  sendWhatsAppButtons: sendWhatsAppButtonsMock,
  sendWhatsAppImage: sendWhatsAppImageMock,
  sendWhatsAppText: sendWhatsAppTextMock,
}));

import { OpenAiImageGenerator } from "./_core/imageService";
import { InvalidSourceImageUrlError } from "./_core/image-generation/sourceImageFetcher";
import {
  processWhatsAppWebhookPayload as processWhatsAppWebhookPayloadBase,
  resetMessengerEventDedupe,
} from "./_core/messengerWebhook";
import { runWhatsAppImageGeneration } from "./_core/whatsappFlows/imageGenerationFlow";
import { t } from "./_core/i18n";
import {
  anonymizePsid,
  getState,
  resetStateStore,
  setFlowState,
} from "./_core/messengerState";
import { processConsentedWhatsAppWebhookPayload } from "./testConsentHelpers";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalAllowedHosts = process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalFreeDailyLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;

const processWhatsAppWebhookPayload = processConsentedWhatsAppWebhookPayload(
  processWhatsAppWebhookPayloadBase
);

function createWhatsAppPayload(message: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

beforeAll(() => {
  process.env.PRIVACY_PEPPER = TEST_PEPPER;
});

afterAll(() => {
  if (originalPrivacyPepper === undefined) {
    delete process.env.PRIVACY_PEPPER;
  } else {
    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  }

  if (originalAppBaseUrl === undefined) {
    delete process.env.APP_BASE_URL;
  } else {
    process.env.APP_BASE_URL = originalAppBaseUrl;
  }

  if (originalAllowedHosts === undefined) {
    delete process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
  } else {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = originalAllowedHosts;
  }

  if (originalOpenAiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiKey;
  }

  if (originalFreeDailyLimit === undefined) {
    delete process.env.MESSENGER_FREE_DAILY_LIMIT;
  } else {
    process.env.MESSENGER_FREE_DAILY_LIMIT = originalFreeDailyLimit;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whatsapp webhook flow", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "leaderbot-fb-image-gen.fly.dev";
    process.env.OPENAI_API_KEY = "dummy-key";
    delete process.env.MESSENGER_FREE_DAILY_LIMIT;
    downloadWhatsAppMediaMock.mockReset();
    sendWhatsAppButtonsMock.mockClear();
    sendWhatsAppImageMock.mockClear();
    sendWhatsAppTextMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });


  it("recovers with a user-facing retry prompt when WhatsApp media download fails", async () => {
    downloadWhatsAppMediaMock.mockRejectedValue(new Error("media fetch failed"));

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-image-fail",
        timestamp: "1710000000",
        type: "image",
        image: { id: "wamid-image-fail" },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-image-fail",
      t("nl", "missingInputImage")
    );
    expect(getState(anonymizePsid("wa-user-image-fail"))?.stage).toBe("AWAITING_PHOTO");
    expect(sendWhatsAppButtonsMock).not.toHaveBeenCalled();
  });










  it("runs shared help commands on WhatsApp with state-aware fallback options", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-6",
        timestamp: "1710000010",
        type: "image",
        image: { id: "wamid-image-6" },
      })
    );

    sendWhatsAppTextMock.mockClear();

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-6",
        timestamp: "1710000011",
        type: "text",
        text: { body: "help" },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-6",
      [
        t("nl", "assistantQuickActions"),
        "",
        "1. Pas aan",
        "2. Andere achtergrond",
        "3. Nieuwe afbeelding",
        "4. Privacy",
      ].join("\n")
    );
  });

  it("routes numbered WhatsApp inputText actions as normal substituted text", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });
    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockResolvedValue({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/surprise.jpg",
      });

    try {
      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-action-input",
          timestamp: "1710000011",
          type: "image",
          image: { id: "wamid-image-action-input" },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-action-input",
          timestamp: "1710000012",
          type: "text",
          text: { body: "help" },
        })
      );
      sendWhatsAppTextMock.mockClear();

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-action-input",
          timestamp: "1710000013",
          type: "text",
          text: { body: "4" },
        })
      );

      expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
        "wa-user-action-input",
        expect.stringContaining("Privacybeleid")
      );
      expect(generateSpy).not.toHaveBeenCalled();
    } finally {
      generateSpy.mockRestore();
    }
  });

  it.each(["Old Money", "DIRECTOR_OLD_MONEY"])(
    "does not treat WhatsApp '%s' as a hidden director generation shortcut",
    async shortcutText => {
      downloadWhatsAppMediaMock.mockResolvedValue({
        buffer: Buffer.alloc(6000, 7),
        contentType: "image/jpeg",
      });
      const generateSpy = vi
        .spyOn(OpenAiImageGenerator.prototype, "generate")
        .mockResolvedValue({
          imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/director-shortcut.jpg",
        });
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({
            shouldEdit: false,
            promptHint: null,
          }),
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      try {
        await processWhatsAppWebhookPayload(
          createWhatsAppPayload({
            from: `wa-director-shortcut-${shortcutText}`,
            timestamp: "1710000014",
            type: "image",
            image: { id: `wamid-director-shortcut-${shortcutText}` },
          })
        );

        sendWhatsAppTextMock.mockClear();

        await processWhatsAppWebhookPayload(
          createWhatsAppPayload({
            from: `wa-director-shortcut-${shortcutText}`,
            timestamp: "1710000015",
            type: "text",
            text: { body: shortcutText },
          })
        );

        expect(generateSpy).not.toHaveBeenCalled();
        expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
          `wa-director-shortcut-${shortcutText}`,
          [
            t("nl", "assistantQuickActions"),
            "",
            "1. Pas aan",
            "2. Andere achtergrond",
            "3. Nieuwe afbeelding",
            "4. Privacy",
          ].join("\n")
        );
      } finally {
        generateSpy.mockRestore();
      }
    }
  );

  it("ignores replayed WhatsApp messages with the same message id", async () => {
    const payload = createWhatsAppPayload({
      id: "wamid-replay-1",
      from: "wa-user-replay",
      timestamp: "1710000012",
      type: "text",
      text: { body: "help" },
    });

    await processWhatsAppWebhookPayload(payload);
    await processWhatsAppWebhookPayload(payload);

    expect(sendWhatsAppTextMock).toHaveBeenCalledTimes(1);
  });

  it("renders prompt-first help actions as a plain-text WhatsApp menu", async () => {
    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-8",
        timestamp: "1710000014",
        type: "text",
        text: { body: "help" },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-8",
      [
        t("nl", "flowExplanation"),
        "",
        "1. Nieuwe afbeelding",
        "2. Pas foto aan",
        "3. Privacy",
      ].join("\n")
    );
  });

  it("maps WhatsApp fallback menu selections back to their advertised privacy action", async () => {
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    setFlowState("wa-user-7", "RESULT_READY");

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-7",
        timestamp: "1710000012",
        type: "text",
        text: { body: "Hey" },
      })
    );
    sendWhatsAppTextMock.mockClear();

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
          from: "wa-user-7",
          timestamp: "1710000013",
          type: "text",
          text: { body: "3" },
        })
      );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-7",
      expect.stringContaining("Privacybeleid: https://leaderbot-fb-image-gen.fly.dev/privacy")
    );
  });

  it("replies clearly when WhatsApp sends an unsupported media type like video", async () => {
    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-video",
        timestamp: "1710000018",
        type: "video",
        video: { id: "wamid-video-1" },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-video",
      "Ik werk voorlopig alleen met foto's. Stuur een foto in plaats van een video of ander bestand."
    );
    expect(sendWhatsAppButtonsMock).not.toHaveBeenCalled();
    expect(downloadWhatsAppMediaMock).not.toHaveBeenCalled();
  });

  it("keeps stale director mode out of WhatsApp success state and follow-up copy", async () => {
    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockResolvedValue({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/whatsapp-prompt-first.jpg",
      });
    const fetchMock = vi.fn(async () => {
      throw new Error("director social copy should not run");
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await runWhatsAppImageGeneration({
        senderId: "wa-stale-director-success",
        userId: "wa-stale-director-success",
        reqId: "req-wa-stale-director-success",
        lang: "nl",
        promptHint: "Maak een krachtige samurai als hoofdonderwerp",
        generationKind: "text_to_image",
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(sendWhatsAppImageMock).toHaveBeenCalledWith(
        "wa-stale-director-success",
        "https://leaderbot-fb-image-gen.fly.dev/generated/whatsapp-prompt-first.jpg"
      );
      expect(getState("wa-stale-director-success")?.lastPrompt).toBe(
        "Maak een krachtige samurai als hoofdonderwerp"
      );
      expect(getState("wa-stale-director-success")?.quota.count).toBe(1);
      expect(
        sendWhatsAppTextMock.mock.calls.some(([, text]) =>
          String(text).includes("Old Money")
        )
      ).toBe(false);
    } finally {
      generateSpy.mockRestore();
    }
  });

  it("counts failed WhatsApp image provider attempts against the free quota", async () => {
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";
    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockImplementation(async input => {
        await input.onProviderAttempt?.();
        throw new Error("provider failed after billable attempt");
      });

    try {
      await runWhatsAppImageGeneration({
        senderId: "wa-provider-attempt-failure",
        userId: "wa-provider-attempt-failure",
        reqId: "req-wa-provider-attempt-failure",
        lang: "nl",
        promptHint: "Maak een testbeeld",
        generationKind: "text_to_image",
      });

      expect(getState("wa-provider-attempt-failure")?.quota.count).toBe(1);
      sendWhatsAppTextMock.mockClear();

      await runWhatsAppImageGeneration({
        senderId: "wa-provider-attempt-failure",
        userId: "wa-provider-attempt-failure",
        reqId: "req-wa-provider-attempt-blocked",
        lang: "nl",
        promptHint: "Maak nog een testbeeld",
        generationKind: "text_to_image",
      });

      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
        "wa-provider-attempt-failure",
        "Je hebt je gratis credits voor vandaag opgebruikt. Kom morgen terug."
      );
    } finally {
      generateSpy.mockRestore();
    }
  });
});

