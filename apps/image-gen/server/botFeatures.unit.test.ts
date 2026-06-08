import { describe, expect, it, vi } from "vitest";
import { ensureDefaultBotFeaturesRegistered } from "./_core/bot/defaultFeatures";
import { assistantCommandsFeature } from "./_core/bot/features/assistantCommandsFeature";
import { conversationalEditingFeature } from "./_core/bot/features/conversationalEditingFeature";
import { freeformTransformFeature } from "./_core/bot/features/freeformTransformFeature";
import { imageRequestFeature } from "./_core/bot/features/imageRequestFeature";
import { rateLimitFeature } from "./_core/bot/features/rateLimitFeature";
import { statsFeature } from "./_core/bot/features/statsFeature";
import { getBotFeatures } from "./_core/bot/features";
import { t } from "./_core/i18n";
import type { BotTextContext } from "./_core/botContext";
import type { MessengerUserState } from "./_core/messengerState";
import { resetStateStore } from "./_core/messengerState";

function makeState(
  overrides: Partial<MessengerUserState> = {}
): MessengerUserState {
  return {
    psid: "p1",
    userKey: "u1",
    stage: "IDLE",
    state: "IDLE",
    lastPhotoUrl: null,
    lastPhoto: null,
    hasSeenIntro: false,
    lastGeneratedUrl: null,
    quota: { dayKey: "2026-01-01", count: 0 },
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<BotTextContext> = {}): BotTextContext {
  return {
    channel: "messenger",
    capabilities: {
      quickReplies: true,
      richTemplates: true,
    },
    senderId: "p1",
    userId: "u1",
    reqId: "req-1",
    lang: "en",
    state: makeState(),
    messageText: "hello",
    normalizedText: "hello",
    hasPhoto: false,
    sendText: vi.fn(async () => undefined),
    sendImage: vi.fn(async () => undefined),
    sendActions: vi.fn(async () => undefined),
    setFlowState: vi.fn(async () => undefined),
    clearImageContext: vi.fn(async () => undefined),
    runImageGeneration: vi.fn(async () => undefined),
    getRuntimeStats: () => ({
      date: "2026-01-01",
      imagesGeneratedToday: 0,
      activeUsersToday: 0,
      generationKindsUsedToday: 0,
      errorCountToday: 0,
      averageGenerationLatencyMs: null,
    }),
    logger: console,
    ...overrides,
  };
}

describe("default feature registration", () => {
  it("only registers the slim runtime feature set once", () => {
    expect(() => {
      ensureDefaultBotFeaturesRegistered();
      ensureDefaultBotFeaturesRegistered();
    }).not.toThrow();

    expect(getBotFeatures().map(feature => feature.name)).toEqual(
      expect.arrayContaining(["rateLimit", "freeformTransform", "imageRequest"])
    );
  });
});

describe("rateLimitFeature", () => {
  it("resets the in-memory bucket after the 60 second window", async () => {
    resetStateStore();

    const sendText = vi.fn(async () => undefined);
    const baseTime = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(baseTime);
      for (let index = 0; index < 11; index += 1) {
        await rateLimitFeature.onText?.(
          makeContext({
            senderId: "rate-limit-memory-user",
            userId: "u-rate",
            messageText: `hello-${index}`,
            normalizedText: `hello-${index}`,
            sendText,
          })
        );
      }

      expect(sendText).toHaveBeenCalledTimes(1);

      sendText.mockClear();
      nowSpy.mockReturnValue(baseTime + 61_000);

      const result = await rateLimitFeature.onText?.(
        makeContext({
          senderId: "rate-limit-memory-user",
          userId: "u-rate",
          messageText: "fresh-window",
          normalizedText: "fresh-window",
          sendText,
        })
      );

      expect(result).toEqual({ handled: false });
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("freeformTransformFeature", () => {
  it("does not treat ambiguous Dutch make-me create wording as a source edit", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await freeformTransformFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak me een Romeinse soldaat",
        normalizedText: "maak me een romeinse soldaat",
        runImageGeneration,
        state: makeState({
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: false });
    expect(runImageGeneration).not.toHaveBeenCalled();
  });

  it("does not treat natural Dutch make-me create requests as source edits", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await freeformTransformFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Kan je me een samurai maken",
        normalizedText: "kan je me een samurai maken",
        runImageGeneration,
        state: makeState({
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: false });
    expect(runImageGeneration).not.toHaveBeenCalled();
  });

  it("uses the generated result for explicit transform requests when both sources exist", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await freeformTransformFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Verander me in een nog sterkere samurai",
        normalizedText: "verander me in een nog sterkere samurai",
        runImageGeneration,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated.jpg",
          lastPhotoUrl: "https://img.example/original.jpg",
          lastPhoto: "https://img.example/original.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      "https://img.example/generated.jpg",
      expect.stringContaining("User requested transformation: Verander me in een nog sterkere samurai"),
      "source_image_edit"
    );
  });

  it("leaves ambiguous make-me requests without a source photo for image intent", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await freeformTransformFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak me een Romeinse soldaat",
        normalizedText: "maak me een romeinse soldaat",
        sendText,
        setFlowState,
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: false });
    expect(setFlowState).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(runImageGeneration).not.toHaveBeenCalled();
  });
});

describe("imageRequestFeature", () => {
  it("generates direct prompt-first image requests from Messenger text", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Kan je een landschap afbeelding genereren?",
        normalizedText: "kan je een landschap afbeelding genereren?",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Kan je een landschap afbeelding genereren?",
      "text_to_image"
    );
  });

  it("generates arbitrary explicit create requests without requiring known subjects", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een draak met neonvleugels boven Antwerpen",
        normalizedText: "maak een draak met neonvleugels boven antwerpen",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Maak een draak met neonvleugels boven Antwerpen",
      "text_to_image"
    );
  });

  it("generates arbitrary can-you-make visual requests without known subjects", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Kan je een draak met neonvleugels maken?",
        normalizedText: "kan je een draak met neonvleugels maken?",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Kan je een draak met neonvleugels maken?",
      "text_to_image"
    );
  });

  it("does not steal prompt-writing requests from the assistant", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Schrijf een prompt voor een landschap",
        normalizedText: "schrijf een prompt voor een landschap",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: false });
    expect(runImageGeneration).not.toHaveBeenCalled();
  });

  it("does not steal non-image creation requests from the assistant", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een plan voor morgen",
        normalizedText: "maak een plan voor morgen",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: false });
    expect(runImageGeneration).not.toHaveBeenCalled();
  });

  it("does not steal can-you-make non-image requests from the assistant", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Kan je een plan voor morgen maken?",
        normalizedText: "kan je een plan voor morgen maken?",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: false });
    expect(runImageGeneration).not.toHaveBeenCalled();
  });

  it("does not treat vague improvement requests as image generation", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Kan je dit niet beter maken?",
        normalizedText: "kan je dit niet beter maken?",
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: false });
    expect(runImageGeneration).not.toHaveBeenCalled();
  });

  it("keeps ordinary visual requests prompt-first even with active photo context", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een stoere poster voor mijn feest",
        normalizedText: "maak een stoere poster voor mijn feest",
        hasPhoto: true,
        runImageGeneration,
        state: makeState({
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Maak een stoere poster voor mijn feest",
      "text_to_image"
    );
  });

  it("uses the current image for create-shaped text while awaiting an edit prompt", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een strand bij zonsondergang",
        normalizedText: "maak een strand bij zonsondergang",
        hasPhoto: false,
        runImageGeneration,
        state: makeState({
          stage: "AWAITING_EDIT_PROMPT",
          state: "AWAITING_EDIT_PROMPT",
          pendingEditIntent: "change_background",
          lastGeneratedUrl: "https://img.example/generated.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      "https://img.example/generated.jpg",
      "Change the background to: Maak een strand bij zonsondergang",
      "source_image_edit"
    );
  });

  it("keeps ambiguous make-me visual requests prompt-first with generated context", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak me een samurai aub",
        normalizedText: "maak me een samurai aub",
        hasPhoto: true,
        runImageGeneration,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated-landscape.jpg",
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Maak me een samurai aub",
      "text_to_image"
    );
  });

  it("uses the generated result for explicit source-referenced visual follow-ups", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een stoere poster van dit resultaat",
        normalizedText: "maak een stoere poster van dit resultaat",
        hasPhoto: true,
        runImageGeneration,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated.jpg",
          lastPhotoUrl: "https://img.example/original.jpg",
          lastPhoto: "https://img.example/original.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      "https://img.example/generated.jpg",
      "Maak een stoere poster van dit resultaat",
      "source_image_edit"
    );
  });

  it("keeps explicit fresh image requests source-less even with photo context", async () => {
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een nieuwe afbeelding van een draak",
        normalizedText: "maak een nieuwe afbeelding van een draak",
        hasPhoto: true,
        runImageGeneration,
        state: makeState({
          stage: "AWAITING_EDIT_PROMPT",
          state: "AWAITING_EDIT_PROMPT",
          pendingEditIntent: "change_background",
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Maak een nieuwe afbeelding van een draak",
      "text_to_image"
    );
  });

  it("does not reuse source image for background intent when not in edit-prompt flow", async () => {
    const runImageGeneration = vi.fn(async () => undefined);
    const setPendingEditIntent = vi.fn(async () => undefined);

    const result = await imageRequestFeature.onText?.(
      makeContext({
        lang: "nl",
        messageText: "Maak een nieuwe avatar van een draak",
        normalizedText: "maak een nieuwe avatar van een draak",
        hasPhoto: true,
        runImageGeneration,
        setPendingEditIntent,
        state: makeState({
          pendingEditIntent: "change_background",
          lastGeneratedUrl: "https://img.example/generated.jpg",
          lastPhotoUrl: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "Maak een nieuwe avatar van een draak",
      "text_to_image"
    );
    expect(setPendingEditIntent).toHaveBeenCalledWith(null);
  });
});

describe("conversationalEditingFeature", () => {
  it("treats legacy style words as prompt-first edits instead of preset restyles", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: "disco",
          promptHint: "make it disco",
        }),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "make it disco",
          normalizedText: "make it disco",
          runImageGeneration,
          state: makeState({
            lastGeneratedUrl: "https://img.example/generated.jpg",
            lastPhotoUrl: "https://img.example/source.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "make it disco",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("uses a prompt-first edit fallback instead of opening the style picker", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: null,
          promptHint: "make the background darker",
        }),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "make the background darker",
          normalizedText: "make the background darker",
          runImageGeneration,
          state: makeState({
            lastGeneratedUrl: "https://img.example/generated.jpg",
            lastPhotoUrl: "https://img.example/source.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "make the background darker",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("allows the first natural edit prompt immediately after photo upload", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: null,
          promptHint: "add sunglasses",
        }),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "add sunglasses",
          normalizedText: "add sunglasses",
          hasPhoto: true,
          runImageGeneration,
          state: makeState({
            lastPhotoUrl: "https://img.example/source.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/source.jpg",
        "add sunglasses",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("uses awaited edit-prompt text as a deterministic source edit", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          lang: "nl",
          messageText: "een strand bij zonsondergang",
          normalizedText: "een strand bij zonsondergang",
          runImageGeneration,
          state: makeState({
            stage: "AWAITING_EDIT_PROMPT",
            state: "AWAITING_EDIT_PROMPT",
            pendingEditIntent: "change_background",
            lastGeneratedUrl: "https://img.example/generated.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "Change the background to: een strand bij zonsondergang",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("leaves help commands for assistant handling while awaiting an edit prompt", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "help",
          normalizedText: "help",
          runImageGeneration,
          state: makeState({
            stage: "AWAITING_EDIT_PROMPT",
            state: "AWAITING_EDIT_PROMPT",
            lastGeneratedUrl: "https://img.example/generated.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: false });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runImageGeneration).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("uses the last generated image as the source for follow-up edits", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: null,
          promptHint: "make it darker",
        }),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "make it darker",
          normalizedText: "make it darker",
          runImageGeneration,
          state: makeState({
            lastGeneratedUrl: "https://img.example/generated.jpg",
            lastPhotoUrl: "https://img.example/original-upload.jpg",
            lastPhoto: "https://img.example/original-upload.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "make it darker",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("routes missing-subject complaints as follow-up corrections", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: null,
          promptHint: "make the samurai clearly visible as the main subject",
        }),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "Ik zie geen samurai bro",
          normalizedText: "ik zie geen samurai bro",
          runImageGeneration,
          state: makeState({
            lastPrompt: "Maak een samurai op een paard",
            lastGeneratedUrl: "https://img.example/generated.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "make the samurai clearly visible as the main subject",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("routes clear visual corrections even when the edit interpreter is unavailable", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "Das mooi, maar geen samurai bro",
          normalizedText: "das mooi, maar geen samurai bro",
          runImageGeneration,
          state: makeState({
            lastPrompt: "Maak een samurai op een paard",
            lastGeneratedUrl: "https://img.example/generated.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "Das mooi, maar geen samurai bro",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("does not treat casual no-subject chat as deterministic corrections", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "No man, thanks",
          normalizedText: "no man, thanks",
          runImageGeneration,
          state: makeState({
            lastGeneratedUrl: "https://img.example/generated.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: false });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(runImageGeneration).not.toHaveBeenCalled();
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });

  it("does not prepend the previous prompt to follow-up edit instructions", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: null,
          promptHint: "add a clear samurai as the central subject",
        }),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const runImageGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "Er mist een samurai",
          normalizedText: "er mist een samurai",
          runImageGeneration,
          state: makeState({
            lastPrompt: "Maak een rustig landschap met een windmolen",
            lastGeneratedUrl: "https://img.example/generated.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        "https://img.example/generated.jpg",
        "add a clear samurai as the central subject",
        "source_image_edit"
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
      vi.unstubAllGlobals();
    }
  });
});

describe("assistantCommandsFeature", () => {
  it("shows contextual help when user has not uploaded a photo yet", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "help",
        messageText: "help",
        hasPhoto: false,
        sendText,
        sendActions,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendActions).toHaveBeenCalledWith(t("en", "flowExplanation"), [
      { id: "new_image", label: "New image", inputText: "new_image" },
      { id: "edit_photo", label: "Edit photo", inputText: "Edit photo" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("shows photo help as channel-neutral conversation actions", async () => {
    const sendActions = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "help",
        messageText: "help",
        hasPhoto: true,
        sendActions,
        state: makeState({
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendActions).toHaveBeenCalledWith(t("en", "assistantQuickActions"), [
      { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
      {
        id: "change_background",
        label: "Different background",
        inputText: "change_background",
      },
      { id: "new_image", label: "New image", inputText: "new_image" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("does not show edit actions when the image flag is stale without an editable image", async () => {
    const sendActions = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "help",
        messageText: "help",
        hasPhoto: true,
        sendActions,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendActions).toHaveBeenCalledWith(t("en", "flowExplanation"), [
      { id: "new_image", label: "New image", inputText: "new_image" },
      { id: "edit_photo", label: "Edit photo", inputText: "Edit photo" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("turns edit-photo action input into a direct edit prompt", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "pas foto aan",
        messageText: "Pas foto aan",
        hasPhoto: true,
        sendText,
        setFlowState,
        state: makeState({
          lastPhotoUrl: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setFlowState).toHaveBeenCalledWith("AWAITING_EDIT_PROMPT");
    expect(sendText).toHaveBeenCalledWith(t("nl", "editImagePrompt"));
  });

  it("turns edit-image action input into an edit prompt for the last generated image", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "pas aan",
        messageText: "Pas aan",
        hasPhoto: false,
        sendText,
        setFlowState,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setFlowState).toHaveBeenCalledWith("AWAITING_EDIT_PROMPT");
    expect(sendText).toHaveBeenCalledWith(t("nl", "editImagePrompt"));
  });

  it("turns new-image action input into a fresh prompt-first start", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);
    const clearImageContext = vi.fn(async () => undefined);
    const setPendingEditIntent = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "nieuwe afbeelding",
        messageText: "Nieuwe afbeelding",
        hasPhoto: true,
        sendText,
        setFlowState,
        clearImageContext,
        setPendingEditIntent,
        state: makeState({
          lastPhotoUrl: "https://img.example/old.jpg",
          lastPhoto: "https://img.example/old.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setPendingEditIntent).toHaveBeenCalledWith(null);
    expect(clearImageContext).toHaveBeenCalledOnce();
    expect(setFlowState).toHaveBeenCalledWith("IDLE");
    expect(sendText).toHaveBeenCalledWith(t("nl", "newImagePrompt"));
  });

  it("turns stable background action input into the background-edit prompt", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);
    const setPendingEditIntent = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "change_background",
        messageText: "change_background",
        hasPhoto: false,
        sendText,
        setFlowState,
        setPendingEditIntent,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setFlowState).toHaveBeenCalledWith("AWAITING_EDIT_PROMPT");
    expect(setPendingEditIntent).toHaveBeenCalledWith("change_background");
    expect(sendText).toHaveBeenCalledWith(t("nl", "changeBackgroundPrompt"));
  });

  it("maps the Dutch background pill label as explicit UI intent", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);
    const setPendingEditIntent = vi.fn(async () => undefined);
    const runImageGeneration = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "andere achtergrond",
        messageText: "Andere achtergrond",
        hasPhoto: false,
        sendText,
        setFlowState,
        setPendingEditIntent,
        runImageGeneration,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setFlowState).toHaveBeenCalledWith("AWAITING_PHOTO");
    expect(setPendingEditIntent).toHaveBeenCalledWith(null);
    expect(runImageGeneration).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      t("nl", "changeBackgroundRequiresPhoto")
    );
  });

  it("treats Dutch casual help requests as help commands", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "help eens",
        messageText: "Help eens",
        hasPhoto: false,
        sendText,
        sendActions,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).not.toHaveBeenCalled();
    expect(sendActions).toHaveBeenCalledWith(t("nl", "flowExplanation"), [
      { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
      { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("turns surprise with a photo into explicit choices instead of auto-generating", async () => {
    const runImageGeneration = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "surprise me",
        messageText: "surprise me",
        hasPhoto: true,
        sendText,
        sendActions,
        runImageGeneration,
        state: makeState({
          lastPhotoUrl: "https://img.example/original.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).not.toHaveBeenCalled();
    expect(runImageGeneration).not.toHaveBeenCalled();
    expect(sendActions).toHaveBeenCalledWith(t("en", "assistantQuickActions"), [
      { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
      {
        id: "change_background",
        label: "Different background",
        inputText: "change_background",
      },
      { id: "new_image", label: "New image", inputText: "new_image" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("turns surprise on the last generated image into explicit choices", async () => {
    const runImageGeneration = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "surprise me",
        messageText: "surprise me",
        hasPhoto: false,
        sendText,
        sendActions,
        runImageGeneration,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).not.toHaveBeenCalled();
    expect(runImageGeneration).not.toHaveBeenCalled();
    expect(sendActions).toHaveBeenCalledWith(t("en", "assistantQuickActions"), [
      { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
      {
        id: "change_background",
        label: "Different background",
        inputText: "change_background",
      },
      { id: "new_image", label: "New image", inputText: "new_image" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("keeps surprise-without-photo users in prompt-first choices", async () => {
    const sendText = vi.fn(async () => undefined);
    const sendActions = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "surprise me",
        messageText: "surprise me",
        hasPhoto: false,
        sendText,
        sendActions,
        setFlowState,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setFlowState).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendActions).toHaveBeenCalledWith(t("en", "flowExplanation"), [
      { id: "new_image", label: "New image", inputText: "new_image" },
      { id: "edit_photo", label: "Edit photo", inputText: "Edit photo" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });
});

describe("statsFeature", () => {
  it("returns a readable admin-only stats block", async () => {
    process.env.MESSENGER_ADMIN_IDS = "p1";
    const sendText = vi.fn(async () => undefined);
    const uptimeSpy = vi
      .spyOn(process, "uptime")
      .mockReturnValue(3 * 3600 + 12 * 60);

    try {
      const result = await statsFeature.onText?.(
        makeContext({
          messageText: "/stats",
          normalizedText: "/stats",
          sendText,
          getRuntimeStats: () => ({
            date: "2026-03-16",
            imagesGeneratedToday: 0,
            activeUsersToday: 0,
            generationKindsUsedToday: 0,
            errorCountToday: 0,
            averageGenerationLatencyMs: null,
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(sendText).toHaveBeenCalledWith(
        [
          "Leaderbot Stats",
          "",
          "Images generated: 0",
          "Users: 0",
          "Generation types: 0",
          "Errors: 0",
          "Avg latency: 0ms",
          "",
          "Bot uptime: 3h 12m",
          "",
          "Node-local stats for 2026-03-16",
        ].join("\n")
      );
    } finally {
      uptimeSpy.mockRestore();
      delete process.env.MESSENGER_ADMIN_IDS;
    }
  });

  it("falls through for non-admin users", async () => {
    process.env.MESSENGER_ADMIN_IDS = "someone-else";
    const sendText = vi.fn(async () => undefined);

    try {
      const result = await statsFeature.onText?.(
        makeContext({
          messageText: "/stats",
          normalizedText: "/stats",
          sendText,
        })
      );

      expect(result).toEqual({ handled: false });
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      delete process.env.MESSENGER_ADMIN_IDS;
    }
  });
});
