import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMessengerAgentTextForAttachments,
  applyFacebookInboundToolPolicyToConfig,
  classifyMessengerFastLaneIntent,
  downloadMessengerMediaAttachment,
  extractImagePromptFromAssistantReply,
  formatUnmatchedMessengerPageLog,
  getOpenClawActionText,
  hasMessengerImageGenerationIntent,
  hasMessengerSourceImageEditIntent,
  redactMessengerIdentifier,
  resolveMessengerConversationIntent,
  resolveMessengerFastLaneReply,
  resolveFacebookInboundToolPolicy,
  resolveMessengerImagePromptFromUserText,
  resolveMessengerEventTarget,
  resolveMessengerSourceImageGenerationPrompt,
  resolveMessengerVerificationTarget,
  sanitizeMessengerSourceImageUrl,
  normalizeMessengerReplyPayloadForDelivery,
  processMessengerEvent,
  rememberMessengerAssistantPrompt,
  reserveMessengerGatewayDailyAudioTranscriptionBudget,
  resetMessengerGatewayBudgetsForTests,
  shouldDeliverMessengerReplyPayload,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldForwardMessengerTextToImageGen,
  shouldProcessMessengerMessageOnce,
  type MessengerWebhookTarget,
} from "./monitor.js";
import { MESSENGER_OPENCLAW_ACTION_PREFIX } from "./messengerPresentationTypes.js";
import {
  getMemoryMessengerEphemeralStateStore,
  MessengerSharedStateUnavailableError,
  type MessengerEphemeralStateStore,
} from "./messenger-state-store.js";
import { clearMessengerRuntime, setMessengerRuntime } from "./runtime.js";
import type {
  MessengerWebhookMessaging,
  ResolvedMessengerAccount,
} from "./types.js";

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalImageGenToken = process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
const originalImageGenUrl = process.env.LEADERBOT_IMAGE_GEN_URL;
const originalGatewayAudioTranscriptionCap =
  process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
const originalAiAnswerEnforcement =
  process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
const originalPublicGatewayGuard = process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD;
let temporaryStateDir: string | null = null;

beforeEach(async () => {
  temporaryStateDir = await mkdtemp(join(tmpdir(), "openclaw-facebook-test-"));
  process.env.OPENCLAW_STATE_DIR = temporaryStateDir;
  delete process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP;
  delete process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
  delete process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP;
  delete process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
  delete process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (originalImageGenToken === undefined) {
    delete process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
  } else {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = originalImageGenToken;
  }
  if (originalImageGenUrl === undefined) {
    delete process.env.LEADERBOT_IMAGE_GEN_URL;
  } else {
    process.env.LEADERBOT_IMAGE_GEN_URL = originalImageGenUrl;
  }
  delete process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP;
  if (originalGatewayAudioTranscriptionCap === undefined) {
    delete process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
  } else {
    process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP =
      originalGatewayAudioTranscriptionCap;
  }
  delete process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP;
  if (originalAiAnswerEnforcement === undefined) {
    delete process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
  } else {
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED =
      originalAiAnswerEnforcement;
  }
  if (originalPublicGatewayGuard === undefined) {
    delete process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD;
  } else {
    process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD = originalPublicGatewayGuard;
  }
  resetMessengerGatewayBudgetsForTests();
  clearMessengerRuntime();
  if (temporaryStateDir) {
    await rm(temporaryStateDir, { force: true, recursive: true });
    temporaryStateDir = null;
  }
});

function messengerTarget(
  accountId: string,
  pageId: string,
  verifyToken = "verify",
): MessengerWebhookTarget {
  return {
    account: {
      accountId,
      enabled: true,
      pageId,
      pageAccessToken: "token",
      appSecret: "secret",
      verifyToken,
      tokenSource: "config",
      config: {},
    },
    path: "/facebook/webhook",
    runtime: {
      log: () => {},
      error: () => {},
      exit: () => {},
    },
    stateStore: getMemoryMessengerEphemeralStateStore(),
  };
}

function messengerTestConfig(
  configOverrides: Partial<ResolvedMessengerAccount["config"]> = {},
) {
  return {
    channels: {
      facebook: {
        pageId: "page-1",
        pageAccessToken: "page-token",
        appSecret: "app-secret",
        verifyToken: "verify-token",
        dmPolicy: "open",
        allowFrom: ["*"],
        ...configOverrides,
      },
    },
  } as never;
}

function messengerTestAccount(
  configOverrides: Partial<ResolvedMessengerAccount["config"]> = {},
): ResolvedMessengerAccount {
  return {
    accountId: "default",
    enabled: true,
    pageId: "page-1",
    pageAccessToken: "page-token",
    appSecret: "app-secret",
    verifyToken: "verify-token",
    tokenSource: "config",
    config: { dmPolicy: "open", allowFrom: ["*"], ...configOverrides },
  };
}

function messengerImagePromptEvent(mid: string): MessengerWebhookMessaging {
  return {
    sender: { id: `sender-${mid}` },
    recipient: { id: "page-1" },
    timestamp: 1_700_000_000_000,
    message: {
      mid,
      text: "Maak een afbeelding van een robot",
    },
  };
}

function messengerPhotoEvent(mid: string): MessengerWebhookMessaging {
  return {
    sender: { id: `sender-${mid}` },
    recipient: { id: "page-1" },
    timestamp: 1_700_000_000_000,
    message: {
      mid,
      attachments: [
        {
          type: "image",
          payload: { url: `https://lookaside.facebook.com/${mid}.jpg` },
        },
      ],
    },
  };
}

function messengerTextEvent(
  mid: string,
  text = "Hallo",
): MessengerWebhookMessaging {
  return {
    sender: { id: `sender-${mid}` },
    recipient: { id: "page-1" },
    timestamp: 1_700_000_000_000,
    message: {
      mid,
      text,
    },
  };
}

function messengerPostbackEvent(
  mid: string,
  payload = "LEGACY_PAYLOAD",
): MessengerWebhookMessaging {
  return {
    sender: { id: `sender-${mid}` },
    recipient: { id: "page-1" },
    timestamp: 1_700_000_000_000,
    postback: {
      payload,
      title: "Legacy action",
    },
  };
}

function messengerAudioEvent(mid: string): MessengerWebhookMessaging {
  return {
    sender: { id: `sender-${mid}` },
    recipient: { id: "page-1" },
    timestamp: 1_700_000_000_000,
    message: {
      mid,
      attachments: [
        {
          type: "audio",
          payload: { url: "https://cdn.fbsbx.com/voice-message.mp4" },
        },
      ],
    },
  };
}

function setGatewayRuntime(
  inboundRun = vi.fn(),
  options: {
    readAllowFromStore?: ReturnType<typeof vi.fn>;
    upsertPairingRequest?: ReturnType<typeof vi.fn>;
  } = {},
) {
  setMessengerRuntime({
    channel: {
      pairing: {
        readAllowFromStore: options.readAllowFromStore ?? vi.fn(async () => []),
        upsertPairingRequest:
          options.upsertPairingRequest ??
          vi.fn(async () => ({ code: "PAIR-1", created: true })),
      },
      inbound: {
        run: inboundRun,
      },
      session: {
        recordInboundSession: vi.fn(),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    },
  } as never);
  return inboundRun;
}

async function processGatewayTestEvent(
  event: MessengerWebhookMessaging,
  configOverrides: Partial<ResolvedMessengerAccount["config"]> = {},
  runtimeOverrides: Partial<{
    log: (message: unknown) => void;
    error: (message: unknown) => void;
    exit: () => void;
  }> = {},
  stateStore?: MessengerEphemeralStateStore,
) {
  await processMessengerEvent({
    event,
    cfg: messengerTestConfig(configOverrides),
    account: messengerTestAccount(configOverrides),
    runtime: {
      log: () => {},
      error: () => {},
      exit: () => {},
      ...runtimeOverrides,
    },
    trace: {
      accountId: "default",
      reqId: `req-${event.message?.mid ?? "event"}`,
      senderId: event.sender?.id ?? "",
      messageId: event.message?.mid ?? "",
      createdAt: Date.now(),
    },
    stateStore,
  } as never);
}

function unavailableMessengerStateStore(params: {
  claimUnavailable?: boolean;
  budgetUnavailable?: boolean;
}): MessengerEphemeralStateStore {
  return {
    mode: "redis",
    ensureReady: async () => {},
    claimMessage: async () => {
      if (params.claimUnavailable) {
        throw new MessengerSharedStateUnavailableError(
          "command",
          "state unavailable",
        );
      }
      return true;
    },
    reserveDaily: async () => {
      if (params.budgetUnavailable) {
        throw new MessengerSharedStateUnavailableError(
          "command",
          "state unavailable",
        );
      }
      return { ok: true, count: 1, cap: 1 };
    },
    close: async () => {},
  };
}

describe("resolveMessengerEventTarget", () => {
  it("uses recipient page id to choose between same-path accounts", () => {
    const first = messengerTarget("first", "page-1");
    const second = messengerTarget("second", "page-2");

    expect(
      resolveMessengerEventTarget([first, second], {
        recipient: { id: "page-2" },
      }),
    ).toBe(second);
    expect(
      resolveMessengerEventTarget([first, second], {
        recipient: { id: "page-3" },
      }),
    ).toBeNull();
  });

  it("does not fall back to the only target when recipient page id is present and unmatched", () => {
    const target = messengerTarget("first", "page-1");

    expect(
      resolveMessengerEventTarget([target], {
        recipient: { id: "page-2" },
      }),
    ).toBeNull();
  });
});

describe("resolveMessengerVerificationTarget", () => {
  it("matches GET verification tokens across same-path accounts", () => {
    const first = messengerTarget("first", "page-1", "first-token");
    const second = messengerTarget("second", "page-2", "second-token");
    const url = new URL(
      "https://example.test/facebook/webhook?hub.mode=subscribe&hub.verify_token=second-token&hub.challenge=ok",
    );

    expect(resolveMessengerVerificationTarget([first, second], url)).toBe(
      second,
    );
  });
});

describe("redactMessengerIdentifier", () => {
  it("redacts stable ids without exposing the raw value", () => {
    const redacted = redactMessengerIdentifier("1234567890");

    expect(redacted).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(redacted).not.toContain("1234567890");
    expect(redactMessengerIdentifier("1234567890")).toBe(redacted);
  });
});

describe("formatUnmatchedMessengerPageLog", () => {
  it("does not include raw sender, page, or message text", () => {
    const logLine = formatUnmatchedMessengerPageLog({
      recipient: { id: "page-123456" },
      sender: { id: "sender-987654" },
      message: {
        mid: "mid-sensitive",
        text: "my card number is 4111 1111 1111 1111",
      },
    });

    expect(logLine).toContain("messenger: skipped event for unmatched page");
    expect(logLine).not.toContain("page-123456");
    expect(logLine).not.toContain("sender-987654");
    expect(logLine).not.toContain("card number");
    expect(logLine).not.toContain("4111");
    expect(logLine).not.toContain("mid-sensitive");
  });
});

describe("shouldProcessMessengerMessageOnce", () => {
  it("allows a Messenger message id only once inside the dedupe window", async () => {
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "default",
        pageId: "page-1",
        senderId: "sender-1",
        messageId: "mid-1",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "default",
        pageId: "page-1",
        senderId: "sender-1",
        messageId: "mid-1",
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("dedupes the same message id independently per account", async () => {
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "account-a",
        pageId: "page-a",
        senderId: "sender-1",
        messageId: "mid-account",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "account-b",
        pageId: "page-b",
        senderId: "sender-1",
        messageId: "mid-account",
        now: 1_000,
      }),
    ).toBe(true);
  });

  it("falls back to sender and timestamp when Meta omits the message id", async () => {
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "default",
        pageId: "page-1",
        senderId: "sender-2",
        timestamp: 123_456,
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "default",
        pageId: "page-1",
        senderId: "sender-2",
        timestamp: 123_456,
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("allows the same message again after the dedupe window expires", async () => {
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "default",
        pageId: "page-1",
        senderId: "sender-3",
        messageId: "mid-expiring",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      await shouldProcessMessengerMessageOnce({
        accountId: "default",
        pageId: "page-1",
        senderId: "sender-3",
        messageId: "mid-expiring",
        now: 1_000 + 10 * 60 * 1000 + 1,
      }),
    ).toBe(true);
  });
});

describe("classifyMessengerFastLaneIntent", () => {
  it.each([
    ["hey", "greeting"],
    ["wat kan je?", "help"],
    ["ben je online", "status"],
    ["maak afbeelding van een robot", "image"],
    ["Delete my data aub", "delete_data"],
    ["verwijder mijn data", "delete_data"],
    ["verwijder mijn gegevens a.u.b.", "delete_data"],
  ] as const)("classifies %s as %s", (text, intent) => {
    expect(classifyMessengerFastLaneIntent(text)).toBe(intent);
  });

  it("leaves real assistant prompts for the OpenClaw turn", () => {
    expect(
      classifyMessengerFastLaneIntent("Schrijf een korte planning voor morgen"),
    ).toBeNull();
    expect(
      classifyMessengerFastLaneIntent("Wat zie je op deze foto?"),
    ).toBeNull();
    expect(
      classifyMessengerFastLaneIntent("Verbeter de stijl van deze tekst"),
    ).toBeNull();
    expect(
      classifyMessengerFastLaneIntent("Maak een prompt voor een afbeelding"),
    ).toBeNull();
  });
});

describe("resolveMessengerConversationIntent", () => {
  it.each([
    ["Kan je me een samurai maken", "generate_image"],
    ["samurai-portret maak", "generate_image"],
    ["Maak een futuristische stad bij zonsondergang", "generate_image"],
    ["Restyle deze foto als cinematic poster", "edit_source_image"],
    ["Bewerk deze foto met neon licht", "edit_source_image"],
    ["Ik zie geen samurai bro", "edit_source_image"],
    ["Das mooi, maar geen samurai bro", "edit_source_image"],
    ["Wat zie je op deze foto?", "analyze_image"],
    ["Maak een prompt voor een samurai poster", "write_prompt"],
    ["Schrijf een planning voor morgen", "unknown"],
    ["help", "help"],
  ] as const)("resolves %s as %s", (text, kind) => {
    expect(resolveMessengerConversationIntent({ text }).kind).toBe(kind);
  });

  it("keeps source-image context in the resolved edit prompt", () => {
    expect(
      resolveMessengerConversationIntent({
        text: "  Bewerk deze foto met neon licht  ",
        hasSourceImage: true,
      }),
    ).toEqual({
      kind: "edit_source_image",
      confidence: 0.92,
      prompt: "Bewerk deze foto met neon licht",
    });
  });

  it("uses attached source images for personal transformation requests", () => {
    expect(
      resolveMessengerConversationIntent({
        text: "Kan je me een samurai maken",
        hasSourceImage: true,
      }),
    ).toEqual({
      kind: "edit_source_image",
      confidence: 0.9,
      prompt: "Kan je me een samurai maken",
    });
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "Maak me cyberpunk met neon regen",
      }),
    ).toBe("Maak me cyberpunk met neon regen");
  });
});

describe("Messenger prompt memory", () => {
  const memoryScope = {
    accountId: "prompt-memory-account",
    pageId: "prompt-memory-page",
  };

  it("extracts a generated image prompt from an assistant reply", () => {
    expect(
      extractImagePromptFromAssistantReply(
        [
          "Hier is een sterke samurai-prompt voor je:",
          "",
          "```text",
          "Maak een stoer samurai-portret, intense blik, donkere achtergrond, geen tekst",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      "Maak een stoer samurai-portret, intense blik, donkere achtergrond, geen tekst",
    );
  });

  it("does not treat ordinary assistant text as a reusable image prompt", () => {
    expect(
      extractImagePromptFromAssistantReply(
        "Ik kan je helpen met afbeeldingen.",
      ),
    ).toBeNull();
  });

  it("returns null for reference-only image requests when no remembered prompt exists", () => {
    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-memory-miss",
        text: "Gebruik deze prompt en maak een afbeelding",
        now: 1_000,
      }),
    ).toBeNull();
  });

  it("reuses the latest assistant-written prompt for reference-only image requests", () => {
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "prompt-memory-hit",
      text: [
        "Hier is een prompt:",
        "",
        "```text",
        "Maak een elegante futuristische samurai poster, geen tekst, geen logo",
        "```",
      ].join("\n"),
      now: 2_000,
    });

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-memory-hit",
        text: "Gebruik deze prompt en maak een afbeelding",
        now: 2_500,
      }),
    ).toBe(
      "Maak een elegante futuristische samurai poster, geen tekst, geen logo",
    );
  });

  it("uses the prompt from the exact Messenger message being replied to", () => {
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "prompt-reply-user",
      text: "Prompt: Maak een rustige Japanse tuin bij zonsopgang, filmische belichting",
      now: 3_000,
      messageId: "assistant-mid-1",
    });
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "prompt-reply-user",
      text: "Prompt: Maak een cyberpunk motorhelm met neonreflecties",
      now: 3_100,
      messageId: "assistant-mid-2",
    });

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-reply-user",
        text: "Maak deze afbeelding",
        replyToMessageId: "assistant-mid-1",
        now: 3_200,
      }),
    ).toBe(
      "Maak een rustige Japanse tuin bij zonsopgang, filmische belichting",
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-reply-user",
        text: "go",
        replyToMessageId: "assistant-mid-2",
        now: 3_200,
      }),
    ).toBe("Maak een cyberpunk motorhelm met neonreflecties");
  });

  it("turns a numbered Messenger reply into the selected visual option", () => {
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "prompt-option-user",
      text: [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. samurai-avatar/sticker maak,",
        "3. samurai-illustratie voor een poster maak,",
      ].join("\n"),
      now: 4_000,
      messageId: "assistant-options-mid",
    });

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-option-user",
        text: "Nr 1 go",
        replyToMessageId: "assistant-options-mid",
        now: 4_100,
      }),
    ).toBe("Maak deze afbeelding: samurai-portret");
  });

  it("does not treat a numbered prompt-writing option as an image prompt", () => {
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "prompt-writing-option-user",
      text: [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. of een tekstprompt schrijf",
        "waarmee je hem kunt genereren?",
      ].join("\n"),
      now: 4_200,
      messageId: "assistant-prompt-option-mid",
    });

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-writing-option-user",
        text: "Nr 2 go",
        replyToMessageId: "assistant-prompt-option-mid",
        now: 4_300,
      }),
    ).toBeNull();
  });

  it("strips markdown when resolving a typed numbered visual option", () => {
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "markdown-option-user",
      text: [
        "**Kies een richting:**",
        "",
        "1. **samurai-portret** maak,",
        "2. `samurai-avatar/sticker` maak,",
      ].join("\n"),
      now: 4_400,
      messageId: "assistant-markdown-options-mid",
    });

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "markdown-option-user",
        text: "1",
        replyToMessageId: "assistant-markdown-options-mid",
        now: 4_500,
      }),
    ).toBe("Maak deze afbeelding: samurai-portret");
  });

  it("turns a numbered follow-up into the latest offered visual option without Messenger reply context", () => {
    rememberMessengerAssistantPrompt({
      ...memoryScope,
      senderId: "prompt-option-latest-user",
      text: [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. samurai-avatar/sticker maak,",
        "3. samurai-illustratie voor een poster maak,",
      ].join("\n"),
      now: 4_500,
      messageId: "assistant-options-latest-mid",
    });

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-option-latest-user",
        text: "Nr 2 go",
        now: 4_600,
      }),
    ).toBe("Maak deze afbeelding: samurai-avatar/sticker");

    expect(
      resolveMessengerImagePromptFromUserText({
        ...memoryScope,
        senderId: "prompt-option-latest-user",
        text: "3",
        now: 4_700,
      }),
    ).toBe("Maak deze afbeelding: samurai-illustratie voor een poster");
  });

  it("isolates remembered prompts by account and Page", () => {
    const sharedSenderAndMessage = {
      senderId: "shared-prompt-memory-sender",
      messageId: "shared-prompt-memory-message",
    };
    const scopes = [
      { accountId: "account-a", pageId: "page-a" },
      { accountId: "account-a", pageId: "page-b" },
      { accountId: "account-b", pageId: "page-a" },
    ];

    for (const [index, scope] of scopes.entries()) {
      rememberMessengerAssistantPrompt({
        ...scope,
        ...sharedSenderAndMessage,
        text: `Prompt: Maak tenant-afbeelding nummer ${index + 1} met unieke belichting`,
        now: 5_000 + index,
      });
    }

    for (const [index, scope] of scopes.entries()) {
      expect(
        resolveMessengerImagePromptFromUserText({
          ...scope,
          senderId: sharedSenderAndMessage.senderId,
          text: "Maak deze afbeelding",
          replyToMessageId: sharedSenderAndMessage.messageId,
          now: 5_100,
        }),
      ).toBe(
        `Maak tenant-afbeelding nummer ${index + 1} met unieke belichting`,
      );
    }
  });
});

describe("hasMessengerImageGenerationIntent", () => {
  it("matches explicit generation and restyle prompts", () => {
    expect(hasMessengerImageGenerationIntent("Restyle deze foto")).toBe(true);
    expect(
      hasMessengerImageGenerationIntent("Maak een afbeelding van een robot"),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent(
        "Kan je een afbeelding maken van een robot?",
      ),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent("Ik wil een afbeelding genereren"),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent(
        "Maak een futuristische stad bij zonsondergang",
      ),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent("Maak een draak boven Antwerpen"),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent(
        "Kan je een draak met neonvleugels maken?",
      ),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent("Maak me een romeinse soldaat"),
    ).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak mij een stripheld")).toBe(
      true,
    );
    expect(
      hasMessengerImageGenerationIntent("Kan je me een samurai maken"),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent("Kun je voor mij een samoerai maken?"),
    ).toBe(true);
    expect(
      hasMessengerImageGenerationIntent("samurai-avatar/sticker maak"),
    ).toBe(true);
    expect(hasMessengerImageGenerationIntent("Ik zie geen samurai bro")).toBe(
      true,
    );
    expect(
      hasMessengerImageGenerationIntent("Das mooi, maar geen samurai bro"),
    ).toBe(true);
  });

  it("does not match image analysis or writing-style prompts", () => {
    expect(hasMessengerImageGenerationIntent("Wat zie je op deze foto?")).toBe(
      false,
    );
    expect(
      hasMessengerImageGenerationIntent("Verbeter de stijl van deze tekst"),
    ).toBe(false);
    expect(
      hasMessengerImageGenerationIntent("Maak een prompt voor een afbeelding"),
    ).toBe(false);
    expect(
      hasMessengerImageGenerationIntent("Write an image prompt for a robot"),
    ).toBe(false);
    expect(
      hasMessengerImageGenerationIntent("Maak een planning voor morgen"),
    ).toBe(false);
    expect(
      hasMessengerImageGenerationIntent("Maak me een planning voor morgen"),
    ).toBe(false);
    expect(
      hasMessengerImageGenerationIntent("Kan je een plan voor morgen maken?"),
    ).toBe(false);
    expect(
      hasMessengerImageGenerationIntent(
        "Can you create a booking for tomorrow?",
      ),
    ).toBe(false);
    expect(hasMessengerImageGenerationIntent("Doe maar")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Ok")).toBe(false);
  });

  it("separates source-photo edits from free image generation prompts", () => {
    expect(
      hasMessengerSourceImageEditIntent(
        "Restyle deze foto als cinematic poster",
      ),
    ).toBe(true);
    expect(
      hasMessengerSourceImageEditIntent("Bewerk deze foto met neon licht"),
    ).toBe(true);
    expect(
      hasMessengerSourceImageEditIntent("Maak een futuristische stad"),
    ).toBe(false);
    expect(
      hasMessengerSourceImageEditIntent(
        "Kan je een landschap afbeelding genereren?",
      ),
    ).toBe(false);
  });
});

describe("shouldForwardMessengerTextToImageGen", () => {
  it("forwards explicit text image requests to the Leaderbot conversation layer", () => {
    expect(
      shouldForwardMessengerTextToImageGen("Maak een afbeelding van een robot"),
    ).toBe(true);
    expect(
      shouldForwardMessengerTextToImageGen(
        "Kan je een landschap afbeelding genereren?",
      ),
    ).toBe(true);
    expect(
      shouldForwardMessengerTextToImageGen(
        "Een afbeelding maken een Belgisch landschap in de natuur",
      ),
    ).toBe(true);
    expect(
      shouldForwardMessengerTextToImageGen("Maak me een romeinse soldaat"),
    ).toBe(true);
  });

  it("keeps non-image and prompt-writing requests in the normal OpenClaw turn", () => {
    expect(
      shouldForwardMessengerTextToImageGen(
        "Maak een prompt voor een afbeelding",
      ),
    ).toBe(false);
    expect(
      shouldForwardMessengerTextToImageGen("Schrijf een planning voor morgen"),
    ).toBe(false);
    expect(
      shouldForwardMessengerTextToImageGen("Wat zie je op deze foto?"),
    ).toBe(false);
    expect(
      shouldForwardMessengerTextToImageGen(
        "Hey leaderbot kan jij mij een trucje tonen hoe ik op mijn oude xbox 360 gratis kan gamen",
      ),
    ).toBe(false);
  });
});

describe("processMessengerEvent unknown sender access policy", () => {
  it.each([
    {
      lang: "nl" as const,
      expected: "toegang is nog niet goedgekeurd",
      codeLabel: "Koppelcode",
    },
    {
      lang: "en" as const,
      expected: "access has not been approved yet",
      codeLabel: "Pairing code",
    },
  ])(
    "localizes private pairing for $lang accounts",
    async ({ lang, expected, codeLabel }) => {
      const mid = `mid-private-pairing-${lang}`;
      const inboundRun = vi.fn(async () => ({ dispatched: false }));
      const upsertPairingRequest = vi.fn(async () => ({
        code: "PAIR-1",
        created: true,
      }));
      setGatewayRuntime(inboundRun, { upsertPairingRequest });
      const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
        expect(String(url)).toBe(
          "https://graph.facebook.com/v20.0/page-1/messages",
        );
        return new Response(
          JSON.stringify({
            message_id: "pairing-message",
            recipient_id: `sender-${mid}`,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await processGatewayTestEvent(messengerTextEvent(mid), {
        dmPolicy: "pairing",
        allowFrom: undefined,
        defaultLang: lang,
      });

      expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sendBody = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
      );
      expect(sendBody.recipient).toEqual({ id: `sender-${mid}` });
      expect(String(sendBody.message?.text ?? "")).toContain(expected);
      expect(String(sendBody.message?.text ?? "")).toContain(
        `${codeLabel}: PAIR-1`,
      );
      expect(String(sendBody.message?.text ?? "")).toContain(
        "openclaw pairing approve facebook PAIR-1",
      );
      expect(inboundRun).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary unknown-sender free-tier text in the OpenClaw turn", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    const upsertPairingRequest = vi.fn(async () => ({
      code: "PAIR-1",
      created: true,
    }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({ recipient_id: "sender-mid-free-tier" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-free-tier", "Wie ben jij?"),
      {
        dmPolicy: "pairing",
        allowFrom: undefined,
        unknownSenderMode: "leaderbot_free_tier",
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        (call) =>
          JSON.parse(String((call[1] as RequestInit).body)).sender_action,
      ),
    ).toEqual(["typing_on", "typing_off"]);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary smoke-test questions in OpenClaw instead of the Leaderbot bridge", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({ recipient_id: "sender-mid-free-tier-xbox" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-free-tier-xbox",
        "Hey leaderbot kan jij mij een trucje tonen hoe ik op mijn oude xbox 360 gratis kan gamen",
      ),
      {
        dmPolicy: "pairing",
        allowFrom: undefined,
        unknownSenderMode: "leaderbot_free_tier",
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        (call) =>
          JSON.parse(String((call[1] as RequestInit).body)).sender_action,
      ),
    ).toEqual(["typing_on", "typing_off"]);
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown senders in pairing when the Leaderbot bridge is not enabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn();
    const upsertPairingRequest = vi.fn(async () => ({
      code: "PAIR-1",
      created: true,
    }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({
          message_id: "pairing-message",
          recipient_id: "sender-mid-free-tier-disabled",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-free-tier-disabled", "Hi"),
      {
        dmPolicy: "pairing",
        allowFrom: undefined,
        unknownSenderMode: "leaderbot_free_tier",
      },
    );

    expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("forwards each unknown sender's first photo despite the stale retired event cap", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP = "1";
    const inboundRun = vi.fn();
    const upsertPairingRequest = vi.fn(async () => ({
      code: "PAIR-1",
      created: true,
    }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const freeTierAccount = {
      dmPolicy: "pairing",
      allowFrom: undefined,
      unknownSenderMode: "leaderbot_free_tier",
      leaderbotBridgeEnabled: true,
      defaultLang: "en",
    } as const;
    await processGatewayTestEvent(
      messengerPhotoEvent("mid-free-tier-photo-a"),
      freeTierAccount,
    );
    await processGatewayTestEvent(
      messengerPhotoEvent("mid-free-tier-photo-b"),
      freeTierAccount,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://image-gen.example.test/internal/messenger/webhook-event",
      "https://image-gen.example.test/internal/messenger/webhook-event",
    ]);
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("logs and returns when free-tier bridge and fallback send both fail", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const runtimeError = vi.fn();
    const inboundRun = vi.fn();
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = String(url);
      if (
        href ===
        "https://image-gen.example.test/internal/messenger/webhook-event"
      ) {
        return new Response(JSON.stringify({ error: "unavailable" }), {
          headers: { "content-type": "application/json" },
          status: 503,
        });
      }
      if (href === "https://graph.facebook.com/v20.0/page-1/messages") {
        return new Response(
          JSON.stringify({ error: { message: "send failed", code: 10 } }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      processGatewayTestEvent(
        messengerImagePromptEvent("mid-free-tier-fallback-failure"),
        {
          dmPolicy: "pairing",
          allowFrom: undefined,
          unknownSenderMode: "leaderbot_free_tier",
          leaderbotBridgeEnabled: true,
        },
        { error: runtimeError },
      ),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeError).toHaveBeenCalledTimes(1);
    expect(String(runtimeError.mock.calls[0]?.[0])).toContain(
      "messenger image generator fallback failed",
    );
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("ignores free-tier attachment-only messages when payload.url is missing", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async () => {
      throw new Error("image generator should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      {
        sender: { id: "sender-mid-free-tier-missing-attachment" },
        recipient: { id: "page-1" },
        timestamp: 1_700_000_000_001,
        message: {
          mid: "mid-free-tier-missing-attachment",
          attachments: [{ type: "image", payload: {} }],
        },
      },
      {
        dmPolicy: "pairing",
        allowFrom: undefined,
        unknownSenderMode: "leaderbot_free_tier",
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(inboundRun).not.toHaveBeenCalled();
  });
});

describe("processMessengerEvent image intents", () => {
  it("fails closed with localized retry copy when shared dedupe is unavailable", async () => {
    const inboundRun = setGatewayRuntime();
    const runtimeLog = vi.fn();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({
          message_id: "state-unavailable-reply",
          recipient_id: "sender-mid-state-unavailable",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-state-unavailable", "Hello"),
      { defaultLang: "en" },
      { log: runtimeLog },
      unavailableMessengerStateStore({ claimUnavailable: true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(sendBody.message.text).toBe(
      "I cannot reliably check the safety limit right now. Please try again shortly.",
    );
    expect(inboundRun).not.toHaveBeenCalled();
    expect(JSON.stringify(runtimeLog.mock.calls)).not.toContain(
      "sender-mid-state-unavailable",
    );
    expect(JSON.stringify(runtimeLog.mock.calls)).not.toContain("Hello");
  });

  it("keeps delete-my-data available when shared dedupe is unavailable", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-delete-state-unavailable", "Delete my data aub"),
      { leaderbotBridgeEnabled: true },
      {},
      unavailableMessengerStateStore({ claimUnavailable: true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("does not consult shared daily-budget state before forwarding an image", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP = "1";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerImagePromptEvent("mid-budget-state-unavailable"),
      { leaderbotBridgeEnabled: true, defaultLang: "en" },
      {},
      unavailableMessengerStateStore({ budgetUnavailable: true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("forwards delete-data smoke requests to the Leaderbot Messenger handler when enabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-delete-data-bridge", "Delete my data aub"),
      {
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("forwards delete-data requests with attachments to the privacy handler when enabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const event = messengerTextEvent(
      "mid-delete-data-attachment",
      "Delete my data aub",
    );
    event.message = {
      ...event.message,
      attachments: [
        {
          type: "image",
          payload: {
            url: "https://lookaside.facebook.com/delete-data-proof.jpg",
          },
        },
      ],
    };

    await processGatewayTestEvent(event, {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("handles delete-data smoke requests before the OpenClaw inbound turn", async () => {
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({
          message_id: "delete-data-reply",
          recipient_id: "sender-mid-delete-data",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-delete-data", "Delete my data aub"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(sendBody.message.text).toContain("privacy@leaderbot.live");
    expect(sendBody.message.text).not.toContain("sender-mid-delete-data");
    expect(sendBody.message.text).not.toContain("facebook:");
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("forwards Messenger text-to-image prompts without entering OpenClaw inbound", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerImagePromptEvent("mid-image-forward"),
      {
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("ignores the retired gateway image-forward cap for every customer", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP = "1";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = String(url);
      if (
        href ===
        "https://image-gen.example.test/internal/messenger/webhook-event"
      ) {
        return new Response(JSON.stringify({ status: "queued" }), {
          headers: { "content-type": "application/json" },
          status: 202,
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerImagePromptEvent("mid-image-forward-cap-a"),
      {
        leaderbotBridgeEnabled: true,
      },
    );
    await processGatewayTestEvent(
      messengerImagePromptEvent("mid-image-forward-cap-b"),
      {
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/webhook-event",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/webhook-event",
    );
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("blocks audio transcription at the gateway daily cap before downloading media", async () => {
    process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP = "1";
    expect(
      await reserveMessengerGatewayDailyAudioTranscriptionBudget({
        accountId: "default",
        pageId: "page-1",
      }),
    ).toMatchObject({ ok: true, count: 1, cap: 1 });
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({
          message_id: "audio-budget-reply",
          recipient_id: "sender-mid-audio-cap",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerAudioEvent("mid-audio-cap"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(sendBody).toMatchObject({
      messaging_type: "RESPONSE",
      message: {
        text: "Even pauze, ons dagbudget voor voiceberichten is bereikt. Typ je bericht even uit, dan help ik meteen verder.",
      },
      recipient: { id: "sender-mid-audio-cap" },
    });
    expect(JSON.stringify(sendBody)).not.toContain(
      "https://cdn.fbsbx.com/voice-message.mp4",
    );
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("does not forward Messenger image prompts when the Leaderbot bridge is disabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(
        JSON.stringify({
          message_id: "typing-message",
          recipient_id: "sender-mid-image-forward-disabled",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerImagePromptEvent("mid-image-forward-disabled"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        (call) =>
          JSON.parse(String((call[1] as RequestInit).body)).sender_action,
      ),
    ).toEqual(["typing_on", "typing_off"]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
      Array(2).fill("https://graph.facebook.com/v20.0/page-1/messages"),
    );
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("sends only the image-generator-unavailable message when forwarding fails", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = String(url);
      if (
        href ===
        "https://image-gen.example.test/internal/messenger/webhook-event"
      ) {
        return new Response(JSON.stringify({ error: "unavailable" }), {
          headers: { "content-type": "application/json" },
          status: 503,
        });
      }
      if (href === "https://graph.facebook.com/v20.0/page-1/messages") {
        return new Response(
          JSON.stringify({
            message_id: "fallback-message",
            recipient_id: "sender-mid-image-forward-failure",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerImagePromptEvent("mid-image-forward-failure"),
      {
        leaderbotBridgeEnabled: true,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    const sendBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    );
    expect(sendBody).toMatchObject({
      messaging_type: "RESPONSE",
      message: {
        text: "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
      },
      recipient: { id: "sender-mid-image-forward-failure" },
    });
    expect(inboundRun).not.toHaveBeenCalled();
  });
});

describe("processMessengerEvent interactive payloads", () => {
  it("forwards interactive image actions despite the stale retired event cap", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP = "1";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://image-gen.example.test/internal/messenger/webhook-event",
      );
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerPostbackEvent("mid-combine-action", "combine_photos"),
      { leaderbotBridgeEnabled: true },
    );
    await processGatewayTestEvent(
      messengerPostbackEvent("mid-new-image-action", "new_image"),
      { leaderbotBridgeEnabled: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("does not create an empty OpenClaw turn for disabled bridge postbacks", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async () => {
      throw new Error("postback should not be sent anywhere");
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerPostbackEvent("mid-postback-disabled"),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(inboundRun).not.toHaveBeenCalled();
  });
});

describe("resolveMessengerSourceImageGenerationPrompt", () => {
  it("does not auto-restyle a photo-only upload", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "",
      }),
    ).toBeNull();
  });

  it("does not auto-restyle a whitespace-only upload", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "   ",
      }),
    ).toBeNull();
  });

  it("does not treat image analysis questions as generation prompts", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "What do you see in this photo?",
      }),
    ).toBeNull();
  });

  it("returns the trimmed prompt only for an explicit source-image edit", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "  Restyle deze foto als cinematic poster  ",
      }),
    ).toBe("Restyle deze foto als cinematic poster");
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "Maak een futuristische stad bij zonsondergang",
      }),
    ).toBeNull();
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: false,
        text: "Restyle deze foto",
      }),
    ).toBeNull();
  });
});

describe("shouldForwardMessengerImageOnlyEventToImageGen", () => {
  it("forwards photo-only uploads so image-gen can store the source image", () => {
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: true,
        text: "",
      }),
    ).toBe(true);
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: true,
        text: "   ",
      }),
    ).toBe(true);
  });

  it("keeps captioned images in the existing gateway routing unless explicitly generated", () => {
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: true,
        text: "What do you see in this photo?",
      }),
    ).toBe(false);
    expect(
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: false,
        text: "",
      }),
    ).toBe(false);
  });
});

describe("sanitizeMessengerSourceImageUrl", () => {
  it("allows https Messenger media hosts", () => {
    expect(
      sanitizeMessengerSourceImageUrl("https://cdn.fbcdn.net/photo.jpg"),
    ).toBe("https://cdn.fbcdn.net/photo.jpg");
    expect(
      sanitizeMessengerSourceImageUrl("https://lookaside.fbsbx.com/photo.jpg"),
    ).toBe("https://lookaside.fbsbx.com/photo.jpg");
  });

  it("rejects non-https or non-Messenger media hosts", () => {
    expect(
      sanitizeMessengerSourceImageUrl("http://cdn.fbcdn.net/photo.jpg"),
    ).toBeNull();
    expect(
      sanitizeMessengerSourceImageUrl("https://example.test/photo.jpg"),
    ).toBeNull();
    expect(sanitizeMessengerSourceImageUrl("not a url")).toBeNull();
  });
});

describe("resolveMessengerFastLaneReply", () => {
  it("returns a direct reply for simple Messenger intents", () => {
    const result = resolveMessengerFastLaneReply("help");

    expect(result?.intent).toBe("help");
    expect(result?.reply).toContain("korte vragen");
  });

  it("returns localized English replies when configured", () => {
    const result = resolveMessengerFastLaneReply("help", "en");

    expect(result?.intent).toBe("help");
    expect(result?.reply).toContain("answer short questions");
    expect(result?.reply).not.toContain("korte vragen");
  });

  it("does not create a separate text reply for image intents", () => {
    expect(
      resolveMessengerFastLaneReply("maak afbeelding van een robot"),
    ).toBeNull();
  });

  it("returns a direct privacy-safe reply for delete-data requests", () => {
    const result = resolveMessengerFastLaneReply("Delete my data aub");

    expect(result?.intent).toBe("delete_data");
    expect(result?.reply).toContain("privacy@leaderbot.live");
  });
});

describe("shouldDeliverMessengerReplyPayload", () => {
  it("delivers normal assistant text", () => {
    expect(
      shouldDeliverMessengerReplyPayload({ text: "Normaal antwoord" }),
    ).toBe(true);
  });

  it("delivers status feedback but suppresses hidden internal notices", () => {
    expect(
      shouldDeliverMessengerReplyPayload({
        text: 'search "pill flow" failed',
        isStatusNotice: true,
      }),
    ).toBe(true);
    expect(
      shouldDeliverMessengerReplyPayload({
        text: "Model fallback...",
        isFallbackNotice: true,
      }),
    ).toBe(false);
    expect(
      shouldDeliverMessengerReplyPayload({
        text: "Thinking...",
        isReasoning: true,
      }),
    ).toBe(false);
  });
});

describe("normalizeMessengerReplyPayloadForDelivery", () => {
  it("formats tool feedback into a readable Messenger bubble", () => {
    expect(
      normalizeMessengerReplyPayloadForDelivery({
        text: 'search "26100858686271223|sender_id|facebook:26100858686271223" failed',
        isStatusNotice: true,
      })?.text,
    ).toBe(
      "Ik kon een interne actie niet uitvoeren. Probeer het zo meteen opnieuw.",
    );

    expect(
      normalizeMessengerReplyPayloadForDelivery({
        text: "Gewone statusupdate",
        isStatusNotice: true,
      })?.text,
    ).toBe("Gewone statusupdate");
  });

  it("renders generic conversation actions as Messenger quick replies", () => {
    const payload = normalizeMessengerReplyPayloadForDelivery({
      text: "Wat wil je doen?",
      actions: [
        { id: "scope", label: "Scope bepalen", inputText: "Scope bepalen" },
        { id: "rules", label: "Regels maken", inputText: "Regels maken" },
      ],
    } as never);

    expect(payload?.channelData?.facebook).toEqual({
      quickReplies: [
        {
          content_type: "text",
          title: "Scope bepalen",
          payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Scope bepalen`,
        },
        {
          content_type: "text",
          title: "Regels maken",
          payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Regels maken`,
        },
      ],
    });
  });

  it("keeps inferred numbered choices visible next to Privacy for delivery", () => {
    const payload = normalizeMessengerReplyPayloadForDelivery({
      text:
        "Ja. Wil je dat ik een:\n\n" +
        "1. samurai-portret maak,\n" +
        "2. samurai-avatar/sticker maak,",
      actions: [{ id: "privacy", label: "Privacy", inputText: "Privacy" }],
    } as never);

    expect(payload?.text).toBe("Ja. Wil je dat ik een:");
    expect(payload?.channelData?.facebook).toEqual({
      quickReplies: [
        {
          content_type: "text",
          title: "samurai-portret",
          payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-portret`,
        },
        {
          content_type: "text",
          title: "samurai-avatar/stick",
          payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-avatar/sticker`,
        },
        {
          content_type: "text",
          title: "Privacy",
          payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Privacy`,
        },
      ],
    });
  });
});

describe("resolveFacebookInboundToolPolicy", () => {
  it("allows only current-session status and denies cross-context tools", () => {
    const policy = resolveFacebookInboundToolPolicy({
      commandAuthorized: false,
    });

    expect(policy).toMatchObject({
      source: "facebook_untrusted_default",
      tools: {
        allow: ["session_status"],
        deny: expect.arrayContaining([
          "image_generate",
          "video_generate",
          "music_generate",
          "exec",
          "memory_search",
          "memory_get",
          "group:memory",
          "write",
          "apply_patch",
          "group:fs",
          "group:runtime",
          "group:messaging",
          "group:automation",
          "group:nodes",
          "group:plugins",
          "bundle-mcp",
          "sessions_history",
          "sessions_search",
          "conversations_send",
          "sessions_send",
          "sessions_spawn",
        ]),
      },
    });
  });

  it("does not add a deny policy for command-authorized turns", () => {
    expect(
      resolveFacebookInboundToolPolicy({ commandAuthorized: true }),
    ).toBeNull();
  });

  it("replaces every persisted widening with a positive minimal policy", () => {
    const policy = resolveFacebookInboundToolPolicy({
      commandAuthorized: false,
    });
    const hardened = applyFacebookInboundToolPolicyToConfig(
      {
        tools: {
          profile: "full",
          allow: ["safe_tool"],
          alsoAllow: ["sessions_history", "bundle-mcp"],
          byProvider: { openai: { allow: ["group:sessions"] } },
          codeMode: true,
        },
      } as never,
      policy,
    ) as {
      tools: {
        profile: string;
        allow: string[];
        deny: string[];
        codeMode: boolean;
        alsoAllow?: string[];
        byProvider?: unknown;
      };
    };

    expect(hardened.tools).toMatchObject({
      profile: "minimal",
      allow: ["session_status"],
      codeMode: false,
    });
    expect(hardened.tools.alsoAllow).toBeUndefined();
    expect(hardened.tools.byProvider).toBeUndefined();
    expect(hardened.tools.deny).toEqual(
      expect.arrayContaining([
        "image_generate",
        "exec",
        "group:fs",
        "sessions_history",
        "conversations_send",
        "group:messaging",
        "group:automation",
        "group:nodes",
        "group:plugins",
      ]),
    );
  });
});

describe("processMessengerEvent typing lifecycle", () => {
  it("turns typing off after delivering a visible final reply", async () => {
    const events: string[] = [];
    const inboundRun = vi.fn(
      async (input: {
        adapter: { resolveTurn: () => { delivery: { deliver: Function } } };
      }) => {
        const turn = input.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Zichtbaar AI-antwoord" },
          { kind: "final" },
        );
        return {
          dispatched: true,
          dispatchResult: { counts: { tool: 0, block: 0, final: 1 } },
        };
      },
    );
    setGatewayRuntime(inboundRun);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          message?: { text?: string };
          sender_action?: string;
        };
        if (body.sender_action) {
          events.push(body.sender_action);
        } else if (body.message?.text) {
          events.push("message");
        }
        return new Response(
          JSON.stringify({
            message_id: "visible-final",
            recipient_id: "sender-mid-typing-success",
          }),
          { status: 200 },
        );
      }),
    );

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-typing-success",
        "Schrijf een planning voor morgen",
      ),
    );

    expect(events).toEqual(["typing_on", "message", "typing_off"]);
  });

  it("turns typing off when OpenClaw produces no visible reply", async () => {
    setGatewayRuntime(vi.fn(async () => ({ dispatched: false })));
    const senderActions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sender_action?: string;
        };
        if (body.sender_action) {
          senderActions.push(body.sender_action);
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-typing-empty",
        "Schrijf een planning voor morgen",
      ),
    );

    expect(senderActions).toEqual(["typing_on", "typing_off"]);
  });

  it("keeps typing active until overlapping turns for the same sender finish", async () => {
    let finishFirstTurn!: () => void;
    let finishSecondTurn!: () => void;
    const firstTurn = new Promise<{ dispatched: false }>((resolve) => {
      finishFirstTurn = () => resolve({ dispatched: false });
    });
    const secondTurn = new Promise<{ dispatched: false }>((resolve) => {
      finishSecondTurn = () => resolve({ dispatched: false });
    });
    const inboundRun = vi.fn((input: { raw: MessengerWebhookMessaging }) =>
      input.raw.message?.mid === "mid-typing-overlap-first"
        ? firstTurn
        : secondTurn,
    );
    setGatewayRuntime(inboundRun);
    const senderActions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sender_action?: string;
        };
        if (body.sender_action) {
          senderActions.push(body.sender_action);
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    const firstEvent = messengerTextEvent(
      "mid-typing-overlap-first",
      "Schrijf een planning voor morgen",
    );
    const secondEvent = messengerTextEvent(
      "mid-typing-overlap-second",
      "Schrijf een andere planning voor morgen",
    );
    firstEvent.sender = { id: "shared-overlap-sender" };
    secondEvent.sender = { id: "shared-overlap-sender" };

    const firstRequest = processGatewayTestEvent(firstEvent);
    await vi.waitFor(() => expect(inboundRun).toHaveBeenCalledTimes(1));
    const secondRequest = processGatewayTestEvent(secondEvent);
    await vi.waitFor(() => expect(inboundRun).toHaveBeenCalledTimes(2));

    finishFirstTurn();
    await firstRequest;
    const actionsAfterFirstTurn = [...senderActions];
    finishSecondTurn();
    await secondRequest;

    expect(actionsAfterFirstTurn).toEqual(["typing_on", "typing_on"]);
    expect(senderActions).toEqual(["typing_on", "typing_on", "typing_off"]);
  });

  it("turns typing off and preserves the original OpenClaw error", async () => {
    setGatewayRuntime(
      vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    );
    const senderActions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sender_action?: string;
        };
        if (body.sender_action) {
          senderActions.push(body.sender_action);
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent(
          "mid-typing-error",
          "Schrijf een planning voor morgen",
        ),
      ),
    ).rejects.toThrow("model unavailable");
    expect(senderActions).toEqual(["typing_on", "typing_off"]);
  });

  it("still attempts typing_off when typing_on fails ambiguously", async () => {
    setGatewayRuntime(vi.fn(async () => ({ dispatched: false })));
    const senderActions: string[] = [];
    const runtimeError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sender_action?: string;
        };
        if (body.sender_action) {
          senderActions.push(body.sender_action);
        }
        if (body.sender_action === "typing_on") {
          throw new Error("request outcome unknown");
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-typing-on-error",
        "Schrijf een planning voor morgen",
      ),
      {},
      { error: runtimeError },
    );

    expect(senderActions).toEqual(["typing_on", "typing_off"]);
    expect(runtimeError).toHaveBeenCalledTimes(1);
    expect(String(runtimeError.mock.calls[0]?.[0])).toContain(
      "typing_on failed",
    );
  });

  it("does not fail the turn when typing_off fails", async () => {
    setGatewayRuntime(vi.fn(async () => ({ dispatched: false })));
    const runtimeError = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo | string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          sender_action?: string;
        };
        if (body.sender_action === "typing_off") {
          return new Response(
            JSON.stringify({ error: { message: "off failed" } }),
            {
              status: 500,
            },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent(
          "mid-typing-off-error",
          "Schrijf een planning voor morgen",
        ),
        {},
        { error: runtimeError },
      ),
    ).resolves.toBeUndefined();
    expect(runtimeError).toHaveBeenCalledTimes(1);
    expect(String(runtimeError.mock.calls[0]?.[0])).toContain(
      "typing_off failed",
    );
    expect(String(runtimeError.mock.calls[0]?.[0])).not.toContain(
      "sender-mid-typing-off-error",
    );
  });
});

describe("processMessengerEvent plan AI-answer quota", () => {
  const reservationId = "16be1d70-9ed5-4b32-80cc-98be433581dc";

  beforeEach(() => {
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED = "true";
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
  });

  it("keeps legacy OpenClaw turns independent from quota while the flag is off", async () => {
    delete process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-ai-quota-off",
        "Schrijf een planning voor morgen",
      ),
    );

    expect(inboundRun).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/ai-answer-quota/"),
      ),
    ).toBe(false);
  });

  it("drops an in-flight duplicate without invoking OpenClaw or Messenger", async () => {
    const inboundRun = vi.fn();
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toContain("/ai-answer-quota/reserve");
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-ai-quota-duplicate",
        "Schrijf een planning voor morgen",
      ),
    );

    expect(inboundRun).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { lang: "nl" as const, expected: "huidige plan" },
    { lang: "en" as const, expected: "current plan" },
  ])(
    "blocks OpenClaw with generic $lang copy when exhausted",
    async ({ lang, expected }) => {
      const inboundRun = vi.fn();
      setGatewayRuntime(inboundRun);
      const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
        if (String(url).includes("/ai-answer-quota/reserve")) {
          return new Response(JSON.stringify({ status: "exhausted" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            message_id: "quota-cta",
            recipient_id: "sender-mid-ai-quota-exhausted",
          }),
          {
            status: 200,
          },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await processGatewayTestEvent(
        messengerTextEvent(
          `mid-ai-quota-exhausted-${lang}`,
          "Schrijf een planning voor morgen",
        ),
        { defaultLang: lang },
      );

      expect(inboundRun).not.toHaveBeenCalled();
      const graphCall = fetchMock.mock.calls.find((call) => {
        if (!String(call[0]).includes("graph.facebook.com")) return false;
        const body = JSON.parse(String((call[1] as RequestInit).body));
        return typeof body.message?.text === "string";
      });
      const body = JSON.parse(String((graphCall?.[1] as RequestInit).body));
      expect(body.message.text).toContain(expected);
      expect(body.message.text).not.toContain("Startpilot");
      expect(body.message.text).not.toContain("300");
      expect(body.message.text).not.toContain("upgrade=startpilot");
      expect(body.message.text).toContain("https://leaderbot.live/");
    },
  );

  it("fails closed with localized English copy when quota status is unavailable", async () => {
    const inboundRun = vi.fn();
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      if (String(url).includes("/ai-answer-quota/reserve")) {
        return new Response(JSON.stringify({ status: "unavailable" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          message_id: "quota-unavailable",
          recipient_id: "sender-mid-ai-quota-unavailable-en",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-ai-quota-unavailable-en",
        "Write a plan for tomorrow",
      ),
      { defaultLang: "en" },
    );

    expect(inboundRun).not.toHaveBeenCalled();
    const graphCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("graph.facebook.com"),
    );
    const body = JSON.parse(String((graphCall?.[1] as RequestInit).body));
    expect(body.message.text).toContain("cannot safely check your credit");
  });

  it("fences and commits the first visible block reply before Graph transport", async () => {
    const inboundRun = vi.fn(
      async (input: {
        adapter: { resolveTurn: () => { delivery: { deliver: Function } } };
      }) => {
        const turn = input.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Zichtbaar AI-antwoord" },
          { kind: "block" },
        );
        return {
          dispatched: true,
          dispatchResult: { counts: { tool: 0, block: 1, final: 0 } },
        };
      },
    );
    setGatewayRuntime(inboundRun);
    const protocolCalls: Array<{
      operation: string;
      body: Record<string, unknown>;
    }> = [];
    const fetchMock = vi.fn(
      async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/ai-answer-quota/reserve")) {
          protocolCalls.push({
            operation: "reserve",
            body: JSON.parse(String(init?.body)),
          });
          return new Response(
            JSON.stringify({ status: "reserved", reservationId }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/heartbeat")) {
          protocolCalls.push({
            operation: "heartbeat",
            body: JSON.parse(String(init?.body)),
          });
          return new Response(JSON.stringify({ status: "lease_renewed" }), {
            status: 200,
          });
        }
        if (requestUrl.includes("/ai-answer-quota/delivery-started")) {
          protocolCalls.push({
            operation: "delivery-started",
            body: JSON.parse(String(init?.body)),
          });
          return new Response(
            JSON.stringify({ status: "delivery_started" }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/finalize")) {
          protocolCalls.push({
            operation: "finalize",
            body: JSON.parse(String(init?.body)),
          });
          return new Response(JSON.stringify({ status: "finalized" }), {
            status: 200,
          });
        }
        const graphBody = JSON.parse(String(init?.body));
        protocolCalls.push({
          operation: graphBody.message ? "graph-message" : "graph-action",
          body: graphBody,
        });
        return new Response(
          JSON.stringify({
            message_id: "visible-final",
            recipient_id: "sender-mid-ai-quota-commit",
          }),
          {
            status: 200,
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-ai-quota-commit",
        "Schrijf een planning voor morgen",
      ),
    );

    expect(protocolCalls.map(({ operation }) => operation)).toEqual([
      "reserve",
      "graph-action",
      "heartbeat",
      "delivery-started",
      "graph-message",
      "graph-action",
      "finalize",
    ]);
    const reserveBody = protocolCalls[0]?.body;
    const heartbeatBody = protocolCalls[2]?.body;
    const deliveryBody = protocolCalls[3]?.body;
    const finalizeBody = protocolCalls[6]?.body;
    expect(reserveBody?.ownerToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    expect(heartbeatBody).toEqual({
      reservationId,
      ownerToken: reserveBody?.ownerToken,
    });
    expect(deliveryBody).toEqual({
      reservationId,
      ownerToken: reserveBody?.ownerToken,
      pageId: "page-1",
      deliveryAttemptToken: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
      ),
    });
    expect(finalizeBody).toEqual({
      pageId: "page-1",
      reservationId,
      ownerToken: reserveBody?.ownerToken,
      outcome: "committed",
    });
  });

  it("releases when OpenClaw produces no visible final reply", async () => {
    setGatewayRuntime(vi.fn(async () => ({ dispatched: false })));
    const quotaBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/ai-answer-quota/reserve")) {
          quotaBodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({ status: "reserved", reservationId }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/finalize")) {
          quotaBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ status: "finalized" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-ai-quota-release",
        "Schrijf een planning voor morgen",
      ),
    );

    expect(quotaBodies).toHaveLength(2);
    expect(quotaBodies[1]).toEqual({
      pageId: "page-1",
      reservationId,
      ownerToken: quotaBodies[0]?.ownerToken,
      outcome: "released",
    });
  });

  it("releases when OpenClaw fails before a final reply", async () => {
    setGatewayRuntime(
      vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    );
    const quotaBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/ai-answer-quota/reserve")) {
          quotaBodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({ status: "reserved", reservationId }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/finalize")) {
          quotaBodies.push(JSON.parse(String(init?.body)));
          throw new Error("quota finalization offline");
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent(
          "mid-ai-quota-error",
          "Schrijf een planning voor morgen",
        ),
      ),
    ).rejects.toThrow("model unavailable");
    expect(quotaBodies).toHaveLength(2);
    expect(quotaBodies[1]).toEqual({
      pageId: "page-1",
      reservationId,
      ownerToken: quotaBodies[0]?.ownerToken,
      outcome: "released",
    });
  });

  it("records a definitive Graph rejection before releasing the reservation", async () => {
    const inboundRun = vi.fn(
      async (input: {
        adapter: { resolveTurn: () => { delivery: { deliver: Function } } };
      }) => {
        const turn = input.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Rejected AI answer" },
          { kind: "final" },
        );
        return { dispatched: false };
      },
    );
    setGatewayRuntime(inboundRun);
    const operations: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        const body = JSON.parse(String(init?.body));
        if (requestUrl.includes("/ai-answer-quota/")) {
          const operation = requestUrl.split("/").at(-1) ?? "";
          operations.push(operation);
          bodies.push(body);
          const status = {
            reserve: "reserved",
            heartbeat: "lease_renewed",
            "delivery-started": "delivery_started",
            "delivery-known-rejected": "delivery_known_rejected",
            finalize: "finalized",
          }[operation];
          return new Response(
            JSON.stringify({ status, ...(operation === "reserve" ? { reservationId } : {}) }),
            { status: 200 },
          );
        }
        if (body.message) {
          operations.push("graph-message");
          return new Response(
            JSON.stringify({
              error: {
                code: 10,
                error_subcode: 2534022,
                message: "outside allowed window",
              },
            }),
            { status: 400 },
          );
        }
        operations.push("graph-action");
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent(
          "mid-ai-quota-known-reject",
          "Schrijf een planning voor morgen",
        ),
      ),
    ).rejects.toThrow("24-hour response window");

    expect(operations).toEqual([
      "reserve",
      "graph-action",
      "heartbeat",
      "delivery-started",
      "graph-message",
      "delivery-known-rejected",
      "graph-action",
      "finalize",
    ]);
    const reserveBody = bodies[0];
    const deliveryBody = bodies[2];
    expect(bodies[3]).toEqual(deliveryBody);
    expect(bodies.at(-1)).toEqual({
      pageId: "page-1",
      reservationId,
      ownerToken: reserveBody?.ownerToken,
      outcome: "released",
    });
  });

  it("commits an ambiguous Graph attempt and never retries it", async () => {
    const inboundRun = vi.fn(
      async (input: {
        adapter: { resolveTurn: () => { delivery: { deliver: Function } } };
      }) => {
        const turn = input.adapter.resolveTurn();
        await turn.delivery
          .deliver(
            { text: "Ambiguous AI answer" },
            { kind: "block" },
          )
          .catch(() => undefined);
        await turn.delivery.deliver(
          { text: "Must not retry" },
          { kind: "final" },
        );
        return { dispatched: false };
      },
    );
    setGatewayRuntime(inboundRun);
    const operations: string[] = [];
    const quotaBodies: Array<Record<string, unknown>> = [];
    let graphMessageCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        const body = JSON.parse(String(init?.body));
        if (requestUrl.includes("/ai-answer-quota/")) {
          const operation = requestUrl.split("/").at(-1) ?? "";
          operations.push(operation);
          quotaBodies.push(body);
          const status = {
            reserve: "reserved",
            heartbeat: "lease_renewed",
            "delivery-started": "delivery_started",
            finalize: "finalized",
          }[operation];
          return new Response(
            JSON.stringify({ status, ...(operation === "reserve" ? { reservationId } : {}) }),
            { status: 200 },
          );
        }
        if (body.message) {
          graphMessageCalls += 1;
          throw new Error("socket reset after POST");
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent(
          "mid-ai-quota-ambiguous",
          "Schrijf een planning voor morgen",
        ),
      ),
    ).rejects.toThrow("cannot be retried safely");

    expect(graphMessageCalls).toBe(1);
    expect(operations).not.toContain("delivery-known-rejected");
    expect(quotaBodies.at(-1)).toEqual({
      pageId: "page-1",
      reservationId,
      ownerToken: quotaBodies[0]?.ownerToken,
      outcome: "committed",
    });
  });

  it("heartbeats a long-running reservation periodically before transport", async () => {
    vi.useFakeTimers();
    let releaseGeneration!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      setGatewayRuntime(
        vi.fn(
          async (input: {
            adapter: {
              resolveTurn: () => { delivery: { deliver: Function } };
            };
          }) => {
            resolve();
            await new Promise<void>((release) => {
              releaseGeneration = release;
            });
            const turn = input.adapter.resolveTurn();
            await turn.delivery.deliver(
              { text: "Delayed AI answer" },
              { kind: "final" },
            );
            return {
              dispatched: true,
              dispatchResult: { counts: { tool: 0, block: 0, final: 1 } },
            };
          },
        ),
      );
    });
    let heartbeatCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/ai-answer-quota/reserve")) {
          return new Response(
            JSON.stringify({ status: "reserved", reservationId }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/heartbeat")) {
          heartbeatCalls += 1;
          return new Response(JSON.stringify({ status: "lease_renewed" }), {
            status: 200,
          });
        }
        if (requestUrl.includes("/ai-answer-quota/delivery-started")) {
          return new Response(
            JSON.stringify({ status: "delivery_started" }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/finalize")) {
          return new Response(JSON.stringify({ status: "finalized" }), {
            status: 200,
          });
        }
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify(
            body.message
              ? { message_id: "delayed-answer", recipient_id: "sender" }
              : {},
          ),
          { status: 200 },
        );
      }),
    );

    const processing = processGatewayTestEvent(
      messengerTextEvent(
        "mid-ai-quota-heartbeat",
        "Schrijf een planning voor morgen",
      ),
    );
    await generationStarted;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatCalls).toBe(1);
    releaseGeneration();
    await processing;
    expect(heartbeatCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeatCalls).toBe(2);
  });

  it("blocks Graph transport when the final lease heartbeat fails", async () => {
    const inboundRun = vi.fn(
      async (input: {
        adapter: { resolveTurn: () => { delivery: { deliver: Function } } };
      }) => {
        const turn = input.adapter.resolveTurn();
        await turn.delivery.deliver(
          { text: "Must not be sent" },
          { kind: "final" },
        );
        return { dispatched: false };
      },
    );
    setGatewayRuntime(inboundRun);
    let graphMessageCalls = 0;
    const quotaBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const requestUrl = String(url);
        const body = JSON.parse(String(init?.body));
        if (requestUrl.includes("/ai-answer-quota/reserve")) {
          quotaBodies.push(body);
          return new Response(
            JSON.stringify({ status: "reserved", reservationId }),
            { status: 200 },
          );
        }
        if (requestUrl.includes("/ai-answer-quota/heartbeat")) {
          return new Response(JSON.stringify({ error: "lease lost" }), {
            status: 503,
          });
        }
        if (requestUrl.includes("/ai-answer-quota/finalize")) {
          quotaBodies.push(body);
          return new Response(JSON.stringify({ status: "finalized" }), {
            status: 200,
          });
        }
        if (body.message) graphMessageCalls += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent(
          "mid-ai-quota-heartbeat-failed",
          "Schrijf een planning voor morgen",
        ),
      ),
    ).rejects.toThrow("quota lease is unavailable");

    expect(graphMessageCalls).toBe(0);
    expect(quotaBodies.at(-1)).toEqual({
      pageId: "page-1",
      reservationId,
      ownerToken: quotaBodies[0]?.ownerToken,
      outcome: "released",
    });
  });
});

describe("processMessengerEvent tool policy", () => {
  it("stamps a closed minimal policy onto untrusted Facebook inbound turns", async () => {
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe(
        "https://graph.facebook.com/v20.0/page-1/messages",
      );
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent(
        "mid-tool-policy",
        "Schrijf een korte planning voor morgen",
      ),
    );

    expect(inboundRun).toHaveBeenCalledTimes(1);
    const runArg = inboundRun.mock.calls[0]?.[0] as {
      adapter: {
        resolveTurn: () => {
          cfg: {
            tools?: {
              profile?: string;
              allow?: string[];
              deny?: string[];
              codeMode?: boolean;
            };
          };
          ctxPayload: Record<string, unknown>;
        };
      };
    };
    const resolvedTurn = runArg.adapter.resolveTurn();
    const ctxPayload = resolvedTurn.ctxPayload;

    expect(ctxPayload.CommandAuthorized).toBe(false);
    expect(resolvedTurn.cfg.tools).toMatchObject({
      profile: "minimal",
      allow: ["session_status"],
      codeMode: false,
    });
    expect(resolvedTurn.cfg.tools?.deny).toEqual(
      expect.arrayContaining([
        "image_generate",
        "video_generate",
        "exec",
        "group:fs",
        "group:messaging",
        "group:automation",
        "group:nodes",
        "group:plugins",
        "bundle-mcp",
        "sessions_history",
        "sessions_search",
        "conversations_send",
        "sessions_send",
        "sessions_spawn",
      ]),
    );
    expect(ctxPayload.ToolPolicy).toMatchObject({
      source: "facebook_untrusted_default",
      tools: {
        allow: ["session_status"],
        deny: expect.arrayContaining([
          "image_generate",
          "video_generate",
          "exec",
          "write",
          "group:fs",
          "sessions_history",
          "conversations_send",
        ]),
      },
    });
    expect(ctxPayload.Tools).toEqual(
      (ctxPayload.ToolPolicy as { tools: unknown }).tools,
    );
    expect(ctxPayload.ToolPolicySource).toBe("facebook_untrusted_default");
    expect(JSON.stringify(ctxPayload.ToolPolicy)).not.toContain(
      "sender-mid-tool-policy",
    );
  });

  it("keeps command-shaped public messages untrusted", async () => {
    process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD = "1";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
      ),
    );

    const event = messengerTextEvent("mid-public-command-policy", "/models");
    await processMessengerEvent({
      event,
      cfg: {
        ...messengerTestConfig(),
        session: { dmScope: "per-account-channel-peer" },
      } as never,
      account: messengerTestAccount(),
      runtime: { log: () => {}, error: () => {}, exit: () => {} },
      trace: {
        accountId: "default",
        reqId: "req-mid-public-command-policy",
        senderId: event.sender?.id ?? "",
        messageId: event.message?.mid ?? "",
        createdAt: Date.now(),
      },
    } as never);

    expect(inboundRun).toHaveBeenCalledTimes(1);
    const turn = (
      inboundRun.mock.calls[0]?.[0] as {
        adapter: {
          resolveTurn: () => {
            cfg: {
              tools?: {
                allow?: string[];
                deny?: string[];
                profile?: string;
                codeMode?: boolean;
              };
            };
            ctxPayload: Record<string, unknown>;
          };
        };
      }
    ).adapter.resolveTurn();
    expect(turn.ctxPayload.CommandAuthorized).toBe(false);
    expect(turn.cfg.tools).toMatchObject({
      allow: ["session_status"],
      profile: "minimal",
      codeMode: false,
    });
    expect(turn.cfg.tools?.deny).toEqual(
      expect.arrayContaining([
        "exec",
        "group:fs",
        "memory_search",
        "memory_get",
        "group:memory",
        "sessions_history",
        "conversations_send",
        "group:messaging",
        "group:automation",
        "group:nodes",
        "group:plugins",
      ]),
    );
  });
});

describe("getOpenClawActionText", () => {
  it("maps OpenClaw quick reply clicks back to normal user input", () => {
    expect(
      getOpenClawActionText({
        message: {
          quick_reply: {
            payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Scope bepalen`,
          },
        },
      }),
    ).toBe("Scope bepalen");
  });

  it("leaves legacy Messenger payloads for channel-specific handlers", () => {
    expect(
      getOpenClawActionText({
        message: {
          quick_reply: {
            payload: "RETRY_STYLE_gold",
          },
        },
      }),
    ).toBeNull();
  });
});

describe("buildMessengerAgentTextForAttachments", () => {
  it("injects voice transcripts into the agent-facing text", () => {
    expect(
      buildMessengerAgentTextForAttachments({
        text: "",
        attachments: [
          {
            type: "audio",
            kind: "audio",
            url: "https://lookaside.facebook.com/voice.mp4",
          },
        ],
        audioTranscripts: [{ mediaIndex: 0, text: "ja, gebruik de fallback" }],
      }),
    ).toBe("Transcriptie voicebericht:\nja, gebruik de fallback");
  });

  it("keeps typed text together with a voice transcript", () => {
    expect(
      buildMessengerAgentTextForAttachments({
        text: "extra context",
        attachments: [
          {
            type: "audio",
            kind: "audio",
            url: "https://lookaside.facebook.com/voice.mp4",
          },
        ],
        audioTranscripts: [
          { mediaIndex: 0, text: "maak de afbeelding opnieuw" },
        ],
      }),
    ).toBe(
      "extra context\n\nTranscriptie voicebericht:\nmaak de afbeelding opnieuw",
    );
  });

  it("falls back to an audio attachment instruction when no transcript exists", () => {
    expect(
      buildMessengerAgentTextForAttachments({
        text: "",
        attachments: [
          {
            type: "audio",
            kind: "audio",
            url: "https://lookaside.facebook.com/voice.mp4",
          },
        ],
      }),
    ).toContain("voice/audio-bericht");
  });

  it("uses English model context for attachment-only turns", () => {
    expect(
      buildMessengerAgentTextForAttachments({
        text: "",
        attachments: [
          {
            type: "image",
            kind: "image",
            url: "https://lookaside.facebook.com/photo.jpg",
          },
        ],
        lang: "en",
      }),
    ).toContain("The user sent an image");
    expect(
      buildMessengerAgentTextForAttachments({
        text: "",
        attachments: [
          {
            type: "audio",
            kind: "audio",
            url: "https://lookaside.facebook.com/voice.mp4",
          },
        ],
        audioTranscripts: [{ mediaIndex: 0, text: "please retry" }],
        lang: "en",
      }),
    ).toBe("Voice-message transcript:\nplease retry");
  });
});

describe("processMessengerEvent attachment cleanup", () => {
  function imageContextEvent(mid: string): MessengerWebhookMessaging {
    const event = messengerTextEvent(mid, "Wat staat er op deze foto?");
    event.message!.attachments = [
      {
        type: "image",
        payload: { url: "https://lookaside.facebook.com/private-photo.png" },
      },
    ];
    return event;
  }

  function installMediaAndGraphFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | RequestInfo | string) => {
        if (String(url).startsWith("https://lookaside.facebook.com/")) {
          return new Response(Buffer.from("private-image-bytes"), {
            headers: { "content-type": "image/png" },
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            message_id: "attachment-cleanup-action",
            recipient_id: "attachment-sender",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      }),
    );
  }

  it("removes downloaded media after a successful OpenClaw turn", async () => {
    let mediaPath = "";
    setGatewayRuntime(
      vi.fn(
        async (input: {
          adapter: {
            resolveTurn: () => { ctxPayload: { MediaPaths?: string[] } };
          };
        }) => {
          const turn = input.adapter.resolveTurn();
          mediaPath = String(turn.ctxPayload.MediaPaths?.[0] ?? "");
          expect(mediaPath).not.toBe("");
          await expect(access(mediaPath)).resolves.toBeUndefined();
          return { dispatched: false };
        },
      ),
    );
    installMediaAndGraphFetch();

    await processGatewayTestEvent(imageContextEvent("media-cleanup-success"));

    await expect(access(mediaPath)).rejects.toThrow();
  });

  it("removes downloaded media when the OpenClaw turn fails", async () => {
    let mediaPath = "";
    setGatewayRuntime(
      vi.fn(
        async (input: {
          adapter: {
            resolveTurn: () => { ctxPayload: { MediaPaths?: string[] } };
          };
        }) => {
          const turn = input.adapter.resolveTurn();
          mediaPath = String(turn.ctxPayload.MediaPaths?.[0] ?? "");
          expect(mediaPath).not.toBe("");
          await expect(access(mediaPath)).resolves.toBeUndefined();
          throw new Error("simulated OpenClaw failure");
        },
      ),
    );
    installMediaAndGraphFetch();

    await expect(
      processGatewayTestEvent(imageContextEvent("media-cleanup-failure")),
    ).rejects.toThrow("simulated OpenClaw failure");

    await expect(access(mediaPath)).rejects.toThrow();
  });
});

describe("processMessengerEvent public session isolation", () => {
  it("fails before transcript dispatch when the effective public DM scope is unsafe", async () => {
    process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD = "1";
    const inboundRun = setGatewayRuntime(
      vi.fn(async () => ({ dispatched: false })),
    );

    await expect(
      processGatewayTestEvent(
        messengerTextEvent("unsafe-public-session", "Vertel me iets"),
      ),
    ).rejects.toThrow("Public Messenger session isolation is unavailable");

    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("fails before transcript dispatch when a public Page routes to another shared agent", async () => {
    process.env.OPENCLAW_PUBLIC_GATEWAY_GUARD = "1";
    const inboundRun = setGatewayRuntime(
      vi.fn(async () => ({ dispatched: false })),
    );
    const event = messengerTextEvent("unsafe-public-agent", "Vertel me iets");

    await expect(
      processMessengerEvent({
        event,
        cfg: {
          ...messengerTestConfig(),
          session: { dmScope: "per-account-channel-peer" },
          bindings: [
            {
              agentId: "support",
              match: { channel: "facebook", accountId: "default" },
            },
          ],
        } as never,
        account: messengerTestAccount(),
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
        trace: {
          accountId: "default",
          reqId: "req-unsafe-public-agent",
          senderId: event.sender?.id ?? "",
          messageId: event.message?.mid ?? "",
          createdAt: Date.now(),
        },
      } as never),
    ).rejects.toThrow("Public Messenger agent isolation is unavailable");

    expect(inboundRun).not.toHaveBeenCalled();
  });
});

describe("downloadMessengerMediaAttachment redirects", () => {
  function attachment(
    url = "https://lookaside.facebook.com/start",
  ): Parameters<typeof downloadMessengerMediaAttachment>[0]["attachment"] {
    return { kind: "image", url };
  }

  function okImageResponse(): Response {
    return new Response(Buffer.from("fake-image"), {
      headers: {
        "content-length": "10",
        "content-type": "image/png",
      },
      status: 200,
    });
  }

  it("allows a manual redirect to https fbcdn.net media", async () => {
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = url instanceof URL ? url.href : String(url);
      if (href === "https://lookaside.facebook.com/start") {
        return new Response(null, {
          headers: { location: "https://cdn.fbcdn.net/photo.png" },
          status: 302,
        });
      }
      if (href === "https://cdn.fbcdn.net/photo.png") {
        return okImageResponse();
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const media = await downloadMessengerMediaAttachment({
      attachment: attachment(),
      index: 0,
      reqId: "msg_redirect_allowed",
    });

    expect(media).toMatchObject({
      contentType: "image/png",
      kind: "image",
      url: "https://lookaside.facebook.com/start",
    });
    expect(media?.path).toMatch(/messenger-[a-f0-9]{32}\.png$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(
      new URL("https://cdn.fbcdn.net/photo.png"),
    );
  });

  it("rejects a redirect to http media", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          headers: { location: "http://cdn.fbcdn.net/photo.png" },
          status: 302,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadMessengerMediaAttachment({
        attachment: attachment(),
        index: 0,
        reqId: "msg_redirect_http",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a non-Facebook media host", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          headers: { location: "https://example.test/photo.png" },
          status: 302,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadMessengerMediaAttachment({
        attachment: attachment(),
        index: 0,
        reqId: "msg_redirect_host",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirect loops once the redirect limit is reached", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          headers: { location: "https://lookaside.facebook.com/start" },
          status: 302,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadMessengerMediaAttachment({
        attachment: attachment(),
        index: 0,
        reqId: "msg_redirect_loop",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
