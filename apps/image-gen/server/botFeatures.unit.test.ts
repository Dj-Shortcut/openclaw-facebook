import { describe, expect, it, vi } from "vitest";
import { ensureDefaultBotFeaturesRegistered } from "./_core/bot/defaultFeatures";
import { assistantCommandsFeature } from "./_core/bot/features/assistantCommandsFeature";
import { conversationalEditingFeature } from "./_core/bot/features/conversationalEditingFeature";
import { rateLimitFeature } from "./_core/bot/features/rateLimitFeature";
import { statsFeature } from "./_core/bot/features/statsFeature";
import { styleCommandsFeature } from "./_core/bot/features/styleCommandsFeature";
import { getBotFeatures } from "./_core/bot/features";
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
    selectedStyle: null,
    chosenStyle: null,
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
    sendQuickReplies: vi.fn(async () => undefined),
    sendStateQuickReplies: vi.fn(async () => undefined),
    setFlowState: vi.fn(async () => undefined),
    preselectStyle: vi.fn(async () => undefined),
    chooseStyle: vi.fn(async () => undefined),
    runStyleGeneration: vi.fn(async () => undefined),
    getRuntimeStats: () => ({
      date: "2026-01-01",
      imagesGeneratedToday: 0,
      activeUsersToday: 0,
      stylesUsedToday: 0,
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
      expect.arrayContaining(["rateLimit", "styleCommands"])
    );
  });
});

describe("styleCommandsFeature", () => {
  it("accepts style aliases and resolves them to the canonical oil-paint key", async () => {
    const chooseStyle = vi.fn(async () => undefined);
    const context = makeContext({
      state: makeState({
        lastPhotoUrl: "https://img.example/source.jpg",
        lastPhoto: "https://img.example/source.jpg",
      }),
      messageText: "style: oil painting",
      normalizedText: "style: oil painting",
      chooseStyle,
    });

    const handled = await styleCommandsFeature.onText?.(context);

    expect(handled).toEqual({ handled: true });
    expect(chooseStyle).toHaveBeenCalledWith("oil-paint");
  });

  it("accepts /style Norman Blackwell aliases and delegates style selection", async () => {
    const chooseStyle = vi.fn(async () => undefined);
    const context = makeContext({
      state: makeState({
        lastPhotoUrl: "https://img.example/source.jpg",
        lastPhoto: "https://img.example/source.jpg",
      }),
      messageText: "/style norman blackwell",
      normalizedText: "/style norman blackwell",
      chooseStyle,
    });

    const handled = await styleCommandsFeature.onText?.(context);

    expect(handled).toEqual({ handled: true });
    expect(chooseStyle).toHaveBeenCalledWith("norman-blackwell");
  });

  it("accepts /style cyberpunk and delegates style selection", async () => {
    const chooseStyle = vi.fn(async () => undefined);
    const context = makeContext({
      state: makeState({
        lastPhotoUrl: "https://img.example/source.jpg",
        lastPhoto: "https://img.example/source.jpg",
      }),
      messageText: "/style cyberpunk",
      normalizedText: "/style cyberpunk",
      chooseStyle,
    });

    const handled = await styleCommandsFeature.onText?.(context);

    expect(handled).toEqual({ handled: true });
    expect(chooseStyle).toHaveBeenCalledWith("cyberpunk");
  });

  it("confirms style changes when no photo context exists yet", async () => {
    const sendText = vi.fn(async () => undefined);
    const preselectStyle = vi.fn(async () => undefined);
    const chooseStyle = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);
    const context = makeContext({
      messageText: "style: cyberpunk",
      normalizedText: "style: cyberpunk",
      sendText,
      preselectStyle,
      setFlowState,
      chooseStyle,
    });

    await styleCommandsFeature.onText?.(context);

    expect(preselectStyle).toHaveBeenCalledWith("cyberpunk");
    expect(setFlowState).toHaveBeenCalledWith("AWAITING_PHOTO");
    expect(sendText).toHaveBeenCalledWith(
      "✅ Style set to cyberpunk.\n\nSend a photo first, then I can make that style for you."
    );
    expect(chooseStyle).not.toHaveBeenCalled();
  });

  it("falls through on invalid style commands", async () => {
    const chooseStyle = vi.fn(async () => undefined);
    const context = makeContext({
      messageText: "/style vaporwave",
      normalizedText: "/style vaporwave",
      chooseStyle,
    });

    const handled = await styleCommandsFeature.onText?.(context);

    expect(handled).toEqual({ handled: false });
    expect(chooseStyle).not.toHaveBeenCalled();
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

describe("conversationalEditingFeature", () => {
  it("does not reuse the previous director mode when the edit chooses a normal style", async () => {
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

    const runStyleGeneration = vi.fn(async () => undefined);

    try {
      const result = await conversationalEditingFeature.onText?.(
        makeContext({
          messageText: "make it disco",
          normalizedText: "make it disco",
          runStyleGeneration,
          state: makeState({
            lastGeneratedUrl: "https://img.example/generated.jpg",
            lastPhotoUrl: "https://img.example/source.jpg",
            lastDirectorMode: "midnight_luxury",
            selectedStyle: "cinematic",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(runStyleGeneration).toHaveBeenCalledWith(
        "disco",
        "https://img.example/source.jpg",
        "make it disco",
        undefined
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

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "help",
        messageText: "help",
        hasPhoto: false,
        sendText,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText.mock.calls[0]?.[0]).toContain("Feel free to send a photo");
  });

  it("picks a random style and triggers generation for surprise command", async () => {
    const runStyleGeneration = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => undefined);
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      const result = await assistantCommandsFeature.onText?.(
        makeContext({
          normalizedText: "surprise me",
          messageText: "surprise me",
          hasPhoto: true,
          sendText,
          runStyleGeneration,
          state: makeState({
            lastPhotoUrl: "https://img.example/original.jpg",
          }),
        })
      );

      expect(result).toEqual({ handled: true });
      expect(sendText).toHaveBeenCalledWith("🎲 Nice — going with Caricature.");
      expect(runStyleGeneration).toHaveBeenCalledWith(
        "caricature",
        "https://img.example/original.jpg"
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("moves surprise-without-photo users into awaiting photo state", async () => {
    const sendText = vi.fn(async () => undefined);
    const setFlowState = vi.fn(async () => undefined);

    const result = await assistantCommandsFeature.onText?.(
      makeContext({
        normalizedText: "surprise me",
        messageText: "surprise me",
        hasPhoto: false,
        sendText,
        setFlowState,
      })
    );

    expect(result).toEqual({ handled: true });
    expect(setFlowState).toHaveBeenCalledWith("AWAITING_PHOTO");
    expect(sendText).toHaveBeenCalledOnce();
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
            stylesUsedToday: 0,
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
          "Styles used: 0",
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
