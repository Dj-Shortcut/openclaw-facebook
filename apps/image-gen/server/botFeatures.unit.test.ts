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
  it("turns a Dutch free-form photo request into a prompt-first source edit", async () => {
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

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "https://img.example/source.jpg",
      expect.stringContaining(
        "User requested transformation: Maak me een Romeinse soldaat"
      ),
      undefined,
      "source_image_edit"
    );
  });

  it("handles natural Dutch make-me requests with a retained photo", async () => {
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

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "https://img.example/source.jpg",
      expect.stringContaining(
        "User requested transformation: Kan je me een samurai maken"
      ),
      undefined,
      "source_image_edit"
    );
  });

  it("generates prompt-first when a make-me request has no source photo", async () => {
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

    expect(result).toEqual({ handled: true });
    expect(setFlowState).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      undefined,
      "Maak me een Romeinse soldaat",
      undefined,
      "text_to_image"
    );
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
      undefined,
      "Kan je een landschap afbeelding genereren?",
      undefined,
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
      undefined,
      "Maak een draak met neonvleugels boven Antwerpen",
      undefined,
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
      undefined,
      "Kan je een draak met neonvleugels maken?",
      undefined,
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

  it("uses an active photo context for visual requests", async () => {
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
      "https://img.example/source.jpg",
      "Maak een stoere poster voor mijn feest",
      undefined,
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
          lastPhotoUrl: "https://img.example/source.jpg",
          lastPhoto: "https://img.example/source.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      undefined,
      "Maak een nieuwe afbeelding van een draak",
      undefined,
      "text_to_image"
    );
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
          directorMode: null,
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
            lastDirectorMode: "midnight_luxury",
            lastStyle: "cinematic",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        undefined,
        "https://img.example/source.jpg",
        "make it disco",
        undefined,
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
          directorMode: null,
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
        undefined,
        "https://img.example/source.jpg",
        "make the background darker",
        undefined,
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

  it("uses the last generated image as the source for follow-up edits", async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({
          shouldEdit: true,
          style: null,
          directorMode: null,
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
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runImageGeneration).toHaveBeenCalledWith(
        undefined,
        "https://img.example/generated.jpg",
        "make it darker",
        undefined,
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
      { id: "new_image", label: "New image", inputText: "New image" },
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
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendActions).toHaveBeenCalledWith(t("en", "assistantQuickActions"), [
      { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
      { id: "new_image", label: "New image", inputText: "New image" },
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

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        lang: "nl",
        normalizedText: "nieuwe afbeelding",
        messageText: "Nieuwe afbeelding",
        hasPhoto: true,
        sendText,
        setFlowState,
        clearImageContext,
        state: makeState({
          lastPhotoUrl: "https://img.example/old.jpg",
          lastPhoto: "https://img.example/old.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(clearImageContext).toHaveBeenCalledOnce();
    expect(setFlowState).toHaveBeenCalledWith("IDLE");
    expect(sendText).toHaveBeenCalledWith(t("nl", "textWithoutPhoto"));
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
      { id: "new_image", label: "Nieuwe afbeelding", inputText: "Nieuwe afbeelding" },
      { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
  });

  it("runs surprise as a prompt-first edit instead of picking a legacy style", async () => {
    const runImageGeneration = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "surprise me",
        messageText: "surprise me",
        hasPhoto: true,
        sendText,
        runImageGeneration,
        state: makeState({
          lastPhotoUrl: "https://img.example/original.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).toHaveBeenCalledWith(t("en", "assistantSurprisePrompt"));
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "https://img.example/original.jpg",
      t("en", "assistantSurprisePrompt"),
      undefined,
      "source_image_edit"
    );
  });

  it("runs surprise on the last generated image when no upload photo is retained", async () => {
    const runImageGeneration = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "surprise me",
        messageText: "surprise me",
        hasPhoto: false,
        sendText,
        runImageGeneration,
        state: makeState({
          lastGeneratedUrl: "https://img.example/generated.jpg",
        }),
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).toHaveBeenCalledWith(t("en", "assistantSurprisePrompt"));
    expect(runImageGeneration).toHaveBeenCalledWith(
      undefined,
      "https://img.example/generated.jpg",
      t("en", "assistantSurprisePrompt"),
      undefined,
      "source_image_edit"
    );
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
      { id: "new_image", label: "New image", inputText: "New image" },
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
