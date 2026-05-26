import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  downloadWhatsAppMediaMock,
  sendWhatsAppButtonsMock,
  sendWhatsAppImageMock,
  sendWhatsAppListMock,
  sendWhatsAppTextMock,
} = vi.hoisted(() => ({
  downloadWhatsAppMediaMock: vi.fn(),
  sendWhatsAppButtonsMock: vi.fn(async () => undefined),
  sendWhatsAppImageMock: vi.fn(async () => undefined),
  sendWhatsAppListMock: vi.fn(async () => undefined),
  sendWhatsAppTextMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/whatsappApi", () => ({
  downloadWhatsAppMedia: downloadWhatsAppMediaMock,
  sendWhatsAppButtons: sendWhatsAppButtonsMock,
  sendWhatsAppImage: sendWhatsAppImageMock,
  sendWhatsAppList: sendWhatsAppListMock,
  sendWhatsAppText: sendWhatsAppTextMock,
}));

import { OpenAiImageGenerator } from "./_core/imageService";
import { InvalidSourceImageUrlError } from "./_core/image-generation/sourceImageFetcher";
import {
  processWhatsAppWebhookPayload as processWhatsAppWebhookPayloadBase,
  resetMessengerEventDedupe,
} from "./_core/messengerWebhook";
import { t } from "./_core/i18n";
import {
  anonymizePsid,
  getState,
  resetStateStore,
  setFlowState,
} from "./_core/messengerState";
import { buildStateResponseText } from "./_core/stateResponseText";
import { processConsentedWhatsAppWebhookPayload } from "./testConsentHelpers";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalAllowedHosts = process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whatsapp webhook flow", () => {
  beforeEach(() => {
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "leaderbot-fb-image-gen.fly.dev";
    process.env.OPENAI_API_KEY = "dummy-key";
    downloadWhatsAppMediaMock.mockReset();
    sendWhatsAppButtonsMock.mockClear();
    sendWhatsAppImageMock.mockClear();
    sendWhatsAppListMock.mockClear();
    sendWhatsAppTextMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("stores an inbound WhatsApp image and prompts for a style group", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-1",
        timestamp: "1710000000",
        type: "image",
        image: { id: "wamid-image-1" },
      })
    );

    expect(downloadWhatsAppMediaMock).toHaveBeenCalledWith("wamid-image-1");
    expect(getState(anonymizePsid("wa-user-1"))?.lastPhotoUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/.+\.jpg$/
    );
    expect(getState(anonymizePsid("wa-user-1"))?.lastPhotoSource).toBe(
      "stored"
    );
    expect(sendWhatsAppListMock).toHaveBeenCalledWith(
      "wa-user-1",
      expect.stringContaining("stijlgroep"),
      "Kies vibe",
      expect.arrayContaining([
        expect.objectContaining({ id: "WA_ILLUSTRATED", title: "Illustrated" }),
        expect.objectContaining({ id: "WA_DIRECTOR", title: "Director" }),
      ]),
      "Stijlgroepen"
    );
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

  it("accepts a WhatsApp category reply and sends category-specific style options", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-2",
        timestamp: "1710000001",
        type: "image",
        image: { id: "wamid-image-2" },
      })
    );

    sendWhatsAppTextMock.mockClear();

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-2",
        timestamp: "1710000002",
        type: "text",
        text: { body: "3" },
      })
    );

    expect(getState(anonymizePsid("wa-user-2"))?.selectedStyleCategory).toBe(
      "bold"
    );
    expect(sendWhatsAppListMock).toHaveBeenCalledWith(
      "wa-user-2",
      expect.stringContaining("bold"),
      "Kies stijl",
      expect.arrayContaining([
        expect.objectContaining({ id: "STYLE_AFROMAN_AMERICANA", title: "Afroman" }),
        expect.objectContaining({ id: "STYLE_DISCO", title: "Disco" }),
      ]),
      "Bold"
    );
  });

  it("generates and returns a WhatsApp image after the user picks a style", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    const sourceImage = Buffer.alloc(6000, 9);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const resolved = typeof url === "string" ? url : url.toString();

        if (resolved.startsWith("https://leaderbot-fb-image-gen.fly.dev/generated/")) {
          return {
            ok: true,
            headers: new Headers({ "content-type": "image/jpeg" }),
            arrayBuffer: async () => sourceImage,
          } as Response;
        }

        if (resolved === "https://api.openai.com/v1/images/edits") {
          return {
            ok: true,
            json: async () => ({
              data: [{ b64_json: Buffer.from("generated-image").toString("base64") }],
            }),
          } as Response;
        }

        throw new Error(`Unexpected fetch url: ${resolved}`);
      })
    );

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-3",
        timestamp: "1710000003",
        type: "image",
        image: { id: "wamid-image-3" },
      })
    );

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-3",
        timestamp: "1710000004",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "WA_BOLD", title: "Bold" },
        },
      })
    );

    sendWhatsAppTextMock.mockClear();
    sendWhatsAppImageMock.mockClear();

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-3",
        timestamp: "1710000005",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "STYLE_DISCO", title: "Disco" },
        },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-3",
      "Ik maak nu je Disco-stijl."
    );
    expect(sendWhatsAppImageMock).toHaveBeenCalledWith(
      "wa-user-3",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/.+\.jpg$/
      )
    );
    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-3",
      expect.stringContaining("Klaar")
    );
    expect(getState(anonymizePsid("wa-user-3"))?.selectedStyle).toBe("disco");
  });

  it("generates with a director prompt after the user picks a director vibe", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockResolvedValue({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/director.jpg",
        proof: {
          incomingLen: 6000,
          incomingSha256: "abc",
          openaiInputLen: 6000,
          openaiInputSha256: "def",
        },
        metrics: { totalMs: 12 },
      });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"caption":"Raw energy for the night.","hashtags":["#Berlin","#Nightlife"]}',
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director",
          timestamp: "1710000030",
          type: "image",
          image: { id: "wamid-image-director" },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director",
          timestamp: "1710000031",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "WA_DIRECTOR", title: "Director" },
          },
        })
      );

      expect(getState(anonymizePsid("wa-user-director"))?.selectedStyleCategory).toBe(
        "director"
      );
      expect(sendWhatsAppListMock).toHaveBeenCalledWith(
        "wa-user-director",
        "Kies een director-vibe.",
        "Kies vibe",
        expect.arrayContaining([
          expect.objectContaining({
            id: "DIRECTOR_BERLIN_UNDERGROUND",
            title: "Berlin Underground",
          }),
        ]),
        "Director"
      );

      sendWhatsAppTextMock.mockClear();
      sendWhatsAppImageMock.mockClear();

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director",
          timestamp: "1710000032",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: {
              id: "DIRECTOR_BERLIN_UNDERGROUND",
              title: "Berlin Underground",
            },
          },
        })
      );

      expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
        "wa-user-director",
        "Ik maak nu je Berlin Underground-stijl."
      );
      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          style: "cinematic",
          directorMode: "berlin_underground",
        })
      );
      expect(sendWhatsAppImageMock).toHaveBeenCalledWith(
        "wa-user-director",
        "https://leaderbot-fb-image-gen.fly.dev/generated/director.jpg"
      );
      expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
        "wa-user-director",
        "Raw energy for the night.\n#Berlin #Nightlife"
      );
      expect(getState(anonymizePsid("wa-user-director"))?.selectedStyle).toBe(
        "cinematic"
      );
    } finally {
      generateSpy.mockRestore();
    }
  });

  it("refines the latest director result with conversational text", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });
    process.env.OPENAI_API_KEY = "dummy-key";

    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockResolvedValueOnce({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/director-first.jpg",
        proof: {
          incomingLen: 6000,
          incomingSha256: "abc",
          openaiInputLen: 6000,
          openaiInputSha256: "def",
        },
        metrics: { totalMs: 12 },
      })
      .mockResolvedValueOnce({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/director-refined.jpg",
        proof: {
          incomingLen: 6000,
          incomingSha256: "abc",
          openaiInputLen: 6000,
          openaiInputSha256: "def",
        },
        metrics: { totalMs: 12 },
      });

    const fetchMock = vi.fn<typeof fetch>(async () => {
      const request = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
      const body = JSON.parse(String(request?.body)) as {
        input?: Array<{ content?: string }>;
      };
      const systemPrompt = body.input?.[0]?.content ?? "";
      const outputText = systemPrompt.includes("social copy")
        ? '{"caption":"Raw energy for the night.","hashtags":["#Berlin"]}'
        : '{"shouldEdit":true,"style":null,"directorMode":"berlin_underground","promptHint":"make it less fake and keep the face closer to the original"}';

      return new Response(JSON.stringify({ output_text: outputText }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-refine",
          timestamp: "1710000040",
          type: "image",
          image: { id: "wamid-image-director-refine" },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-refine",
          timestamp: "1710000041",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "WA_DIRECTOR", title: "Director" },
          },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-refine",
          timestamp: "1710000042",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: {
              id: "DIRECTOR_BERLIN_UNDERGROUND",
              title: "Berlin Underground",
            },
          },
        })
      );

      sendWhatsAppTextMock.mockClear();
      sendWhatsAppImageMock.mockClear();

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-refine",
          timestamp: "1710000043",
          type: "text",
          text: { body: "make it less fake and keep my face closer" },
        })
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(generateSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          style: "cinematic",
          directorMode: "berlin_underground",
          promptHint:
            "Berlin Underground | make it less fake and keep the face closer to the original",
        })
      );
      expect(sendWhatsAppImageMock).toHaveBeenCalledWith(
        "wa-user-director-refine",
        "https://leaderbot-fb-image-gen.fly.dev/generated/director-refined.jpg"
      );
      expect(getState(anonymizePsid("wa-user-director-refine"))?.lastDirectorMode).toBe(
        "berlin_underground"
      );
    } finally {
      generateSpy.mockRestore();
    }
  });

  it("keeps director image delivery successful when social copy generation fails", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockResolvedValue({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/director-no-copy.jpg",
        proof: {
          incomingLen: 6000,
          incomingSha256: "abc",
          openaiInputLen: 6000,
          openaiInputSha256: "def",
        },
        metrics: { totalMs: 12 },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status: 500 }))
    );

    try {
      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-copy-fail",
          timestamp: "1710000050",
          type: "image",
          image: { id: "wamid-image-director-copy-fail" },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-copy-fail",
          timestamp: "1710000051",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "WA_DIRECTOR", title: "Director" },
          },
        })
      );

      sendWhatsAppTextMock.mockClear();
      sendWhatsAppImageMock.mockClear();

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-director-copy-fail",
          timestamp: "1710000052",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: {
              id: "DIRECTOR_MIDNIGHT_LUXURY",
              title: "Midnight Luxury",
            },
          },
        })
      );

      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ directorMode: "midnight_luxury" })
      );
      expect(sendWhatsAppImageMock).toHaveBeenCalledWith(
        "wa-user-director-copy-fail",
        "https://leaderbot-fb-image-gen.fly.dev/generated/director-no-copy.jpg"
      );
      expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
        "wa-user-director-copy-fail",
        expect.stringContaining("Klaar")
      );
    } finally {
      generateSpy.mockRestore();
    }
  });

  it("treats persisted WhatsApp source images as trusted during later style generation", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockResolvedValue({
        imageUrl: "https://leaderbot-fb-image-gen.fly.dev/generated/fake.jpg",
        proof: {
          incomingLen: 6000,
          incomingSha256: "abc",
          openaiInputLen: 6000,
          openaiInputSha256: "def",
        },
        metrics: { totalMs: 12 },
      });

    try {
      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-trusted",
          timestamp: "1710000015",
          type: "image",
          image: { id: "wamid-image-trusted" },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-trusted",
          timestamp: "1710000016",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "WA_BOLD", title: "Bold" },
          },
        })
      );

      sendWhatsAppTextMock.mockClear();
      sendWhatsAppImageMock.mockClear();

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-trusted",
          timestamp: "1710000017",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "STYLE_DISCO", title: "Disco" },
          },
        })
      );

      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceImageUrl: expect.stringMatching(
            /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/.+\.jpg$/
          ),
          trustedSourceImageUrl: true,
          sourceImageProvenance: "storeInbound",
        })
      );
    } finally {
      generateSpy.mockRestore();
    }
  });

  it("clears a rejected stored WhatsApp photo when the trusted source URL is invalid", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    const generateSpy = vi
      .spyOn(OpenAiImageGenerator.prototype, "generate")
      .mockRejectedValue(
        new InvalidSourceImageUrlError("sourceImageUrl is not allowed")
      );

    try {
      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-invalid-source",
          timestamp: "1710000020",
          type: "image",
          image: { id: "wamid-image-invalid-source" },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-invalid-source",
          timestamp: "1710000021",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "WA_BOLD", title: "Bold" },
          },
        })
      );

      await processWhatsAppWebhookPayload(
        createWhatsAppPayload({
          from: "wa-user-invalid-source",
          timestamp: "1710000022",
          type: "interactive",
          interactive: {
            type: "list_reply",
            list_reply: { id: "STYLE_DISCO", title: "Disco" },
          },
        })
      );

      const nextState = getState(anonymizePsid("wa-user-invalid-source"));
      expect(nextState?.lastPhotoUrl).toBeNull();
      expect(nextState?.lastPhotoSource).toBeNull();
      expect(nextState?.stage).toBe("AWAITING_PHOTO");
    } finally {
      generateSpy.mockRestore();
    }
  });

  it("reopens the WhatsApp category picker when the user asks for a new style", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-4",
        timestamp: "1710000006",
        type: "image",
        image: { id: "wamid-image-4" },
      })
    );

    sendWhatsAppTextMock.mockClear();

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-4",
        timestamp: "1710000007",
        type: "text",
        text: { body: "nieuwe stijl" },
      })
    );

    expect(sendWhatsAppListMock).toHaveBeenCalledWith(
      "wa-user-4",
      expect.any(String),
      "Kies vibe",
      expect.arrayContaining([
        expect.objectContaining({ id: "WA_ILLUSTRATED" }),
      ]),
      "Stijlgroepen"
    );
    expect(getState(anonymizePsid("wa-user-4"))?.stage).toBe("AWAITING_STYLE");
  });

  it("supports /style commands on WhatsApp before the user uploads a photo", async () => {
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.alloc(6000, 7),
      contentType: "image/jpeg",
    });

    const sourceImage = Buffer.alloc(6000, 9);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const resolved = typeof url === "string" ? url : url.toString();

        if (resolved.startsWith("https://leaderbot-fb-image-gen.fly.dev/generated/")) {
          return {
            ok: true,
            headers: new Headers({ "content-type": "image/jpeg" }),
            arrayBuffer: async () => sourceImage,
          } as Response;
        }

        if (resolved === "https://api.openai.com/v1/images/edits") {
          return {
            ok: true,
            json: async () => ({
              data: [{ b64_json: Buffer.from("generated-image-2").toString("base64") }],
            }),
          } as Response;
        }

        throw new Error(`Unexpected fetch url: ${resolved}`);
      })
    );

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-5",
        timestamp: "1710000008",
        type: "text",
        text: { body: "/style cyberpunk" },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-5",
      "✅ Stijl ingesteld op cyberpunk.\n\nStuur eerst een foto, dan maak ik die stijl voor je."
    );
    expect(getState(anonymizePsid("wa-user-5"))?.preselectedStyle).toBe(
      "cyberpunk"
    );

    sendWhatsAppTextMock.mockClear();
    sendWhatsAppImageMock.mockClear();

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-5",
        timestamp: "1710000009",
        type: "image",
        image: { id: "wamid-image-5" },
      })
    );

    expect(sendWhatsAppTextMock).toHaveBeenCalledWith(
      "wa-user-5",
      "Ik maak nu je Cyberpunk-stijl."
    );
    expect(sendWhatsAppImageMock).toHaveBeenCalledWith(
      "wa-user-5",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/.+\.jpg$/
      )
    );
    expect(getState(anonymizePsid("wa-user-5"))?.preselectedStyle).toBeNull();
    expect(getState(anonymizePsid("wa-user-5"))?.selectedStyle).toBe(
      "cyberpunk"
    );
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
      buildStateResponseText(
        "AWAITING_STYLE",
        t("nl", "assistantQuickActions"),
        "nl"
      )
    );
  });

  it("adds a plain-text selection hint for WhatsApp help before a photo is uploaded", async () => {
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
      [t("nl", "textWithoutPhoto"), t("nl", "assistantPhotoTip")].join("\n\n")
    );
  });

  it("maps WhatsApp fallback menu selections back to their advertised actions", async () => {
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    setFlowState("wa-user-7", "RESULT_READY");

    await processWhatsAppWebhookPayload(
      createWhatsAppPayload({
        from: "wa-user-7",
        timestamp: "1710000013",
        type: "text",
        text: { body: "2" },
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
});

