import { mkdtemp, rm } from "node:fs/promises";
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
  reserveMessengerGatewayDailyLeaderbotEventForwardBudget,
  resetMessengerGatewayDailyImageForwardBudgetForTests,
  shouldDeliverMessengerReplyPayload,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldForwardMessengerTextToImageGen,
  shouldProcessMessengerMessageOnce,
  type MessengerWebhookTarget,
} from "./monitor.js";
import { MESSENGER_OPENCLAW_ACTION_PREFIX } from "./presentation.js";
import { clearMessengerRuntime, setMessengerRuntime } from "./runtime.js";
import type { MessengerWebhookMessaging, ResolvedMessengerAccount } from "./types.js";

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
const originalImageGenToken = process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
const originalImageGenUrl = process.env.LEADERBOT_IMAGE_GEN_URL;
const originalGatewayImageForwardCap = process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP;
const originalGatewayAudioTranscriptionCap =
  process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
const originalGatewayLeaderbotEventForwardCap =
  process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP;
let temporaryStateDir: string | null = null;

beforeEach(async () => {
  temporaryStateDir = await mkdtemp(join(tmpdir(), "openclaw-facebook-test-"));
  process.env.OPENCLAW_STATE_DIR = temporaryStateDir;
  delete process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP;
  delete process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
  delete process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP;
});

afterEach(async () => {
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
  if (originalGatewayImageForwardCap === undefined) {
    delete process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP;
  } else {
    process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP = originalGatewayImageForwardCap;
  }
  if (originalGatewayAudioTranscriptionCap === undefined) {
    delete process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP;
  } else {
    process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP =
      originalGatewayAudioTranscriptionCap;
  }
  if (originalGatewayLeaderbotEventForwardCap === undefined) {
    delete process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP;
  } else {
    process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP =
      originalGatewayLeaderbotEventForwardCap;
  }
  resetMessengerGatewayDailyImageForwardBudgetForTests();
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

function messengerTextEvent(mid: string, text = "Hallo"): MessengerWebhookMessaging {
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

function messengerPostbackEvent(mid: string): MessengerWebhookMessaging {
  return {
    sender: { id: `sender-${mid}` },
    recipient: { id: "page-1" },
    timestamp: 1_700_000_000_000,
    postback: {
      payload: "LEGACY_PAYLOAD",
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
          options.upsertPairingRequest ?? vi.fn(async () => ({ code: "PAIR-1", created: true })),
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
  } as never);
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

    expect(resolveMessengerVerificationTarget([first, second], url)).toBe(second);
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
  it("allows a Messenger message id only once inside the dedupe window", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-1",
        messageId: "mid-1",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-1",
        messageId: "mid-1",
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("dedupes the same message id independently per account", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "account-a",
        senderId: "sender-1",
        messageId: "mid-account",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "account-b",
        senderId: "sender-1",
        messageId: "mid-account",
        now: 1_000,
      }),
    ).toBe(true);
  });

  it("falls back to sender and timestamp when Meta omits the message id", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-2",
        timestamp: 123_456,
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-2",
        timestamp: 123_456,
        now: 2_000,
      }),
    ).toBe(false);
  });

  it("allows the same message again after the dedupe window expires", () => {
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
        senderId: "sender-3",
        messageId: "mid-expiring",
        now: 1_000,
      }),
    ).toBe(true);
    expect(
      shouldProcessMessengerMessageOnce({
        accountId: "default",
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
    expect(classifyMessengerFastLaneIntent("Schrijf een korte planning voor morgen")).toBeNull();
    expect(classifyMessengerFastLaneIntent("Wat zie je op deze foto?")).toBeNull();
    expect(classifyMessengerFastLaneIntent("Verbeter de stijl van deze tekst")).toBeNull();
    expect(classifyMessengerFastLaneIntent("Maak een prompt voor een afbeelding")).toBeNull();
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
      })
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
      })
    ).toEqual({
      kind: "edit_source_image",
      confidence: 0.9,
      prompt: "Kan je me een samurai maken",
    });
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "Maak me cyberpunk met neon regen",
      })
    ).toBe("Maak me cyberpunk met neon regen");
  });
});

describe("Messenger prompt memory", () => {
  it("extracts a generated image prompt from an assistant reply", () => {
    expect(
      extractImagePromptFromAssistantReply(
        [
          "Hier is een sterke samurai-prompt voor je:",
          "",
          "```text",
          "Maak een stoer samurai-portret, intense blik, donkere achtergrond, geen tekst",
          "```",
        ].join("\n")
      )
    ).toBe("Maak een stoer samurai-portret, intense blik, donkere achtergrond, geen tekst");
  });

  it("does not treat ordinary assistant text as a reusable image prompt", () => {
    expect(extractImagePromptFromAssistantReply("Ik kan je helpen met afbeeldingen.")).toBeNull();
  });

  it("returns null for reference-only image requests when no remembered prompt exists", () => {
    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-memory-miss",
        text: "Gebruik deze prompt en maak een afbeelding",
        now: 1_000,
      })
    ).toBeNull();
  });

  it("reuses the latest assistant-written prompt for reference-only image requests", () => {
    rememberMessengerAssistantPrompt(
      "prompt-memory-hit",
      [
        "Hier is een prompt:",
        "",
        "```text",
        "Maak een elegante futuristische samurai poster, geen tekst, geen logo",
        "```",
      ].join("\n"),
      2_000
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-memory-hit",
        text: "Gebruik deze prompt en maak een afbeelding",
        now: 2_500,
      })
    ).toBe("Maak een elegante futuristische samurai poster, geen tekst, geen logo");
  });

  it("uses the prompt from the exact Messenger message being replied to", () => {
    rememberMessengerAssistantPrompt(
      "prompt-reply-user",
      "Prompt: Maak een rustige Japanse tuin bij zonsopgang, filmische belichting",
      3_000,
      "assistant-mid-1"
    );
    rememberMessengerAssistantPrompt(
      "prompt-reply-user",
      "Prompt: Maak een cyberpunk motorhelm met neonreflecties",
      3_100,
      "assistant-mid-2"
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-reply-user",
        text: "Maak deze afbeelding",
        replyToMessageId: "assistant-mid-1",
        now: 3_200,
      })
    ).toBe("Maak een rustige Japanse tuin bij zonsopgang, filmische belichting");

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-reply-user",
        text: "go",
        replyToMessageId: "assistant-mid-2",
        now: 3_200,
      })
    ).toBe("Maak een cyberpunk motorhelm met neonreflecties");
  });

  it("turns a numbered Messenger reply into the selected visual option", () => {
    rememberMessengerAssistantPrompt(
      "prompt-option-user",
      [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. samurai-avatar/sticker maak,",
        "3. samurai-illustratie voor een poster maak,",
      ].join("\n"),
      4_000,
      "assistant-options-mid"
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-option-user",
        text: "Nr 1 go",
        replyToMessageId: "assistant-options-mid",
        now: 4_100,
      })
    ).toBe("Maak deze afbeelding: samurai-portret");
  });

  it("does not treat a numbered prompt-writing option as an image prompt", () => {
    rememberMessengerAssistantPrompt(
      "prompt-writing-option-user",
      [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. of een tekstprompt schrijf",
        "waarmee je hem kunt genereren?",
      ].join("\n"),
      4_200,
      "assistant-prompt-option-mid"
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-writing-option-user",
        text: "Nr 2 go",
        replyToMessageId: "assistant-prompt-option-mid",
        now: 4_300,
      })
    ).toBeNull();
  });

  it("strips markdown when resolving a typed numbered visual option", () => {
    rememberMessengerAssistantPrompt(
      "markdown-option-user",
      [
        "**Kies een richting:**",
        "",
        "1. **samurai-portret** maak,",
        "2. `samurai-avatar/sticker` maak,",
      ].join("\n"),
      4_400,
      "assistant-markdown-options-mid"
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "markdown-option-user",
        text: "1",
        replyToMessageId: "assistant-markdown-options-mid",
        now: 4_500,
      })
    ).toBe("Maak deze afbeelding: samurai-portret");
  });

  it("turns a numbered follow-up into the latest offered visual option without Messenger reply context", () => {
    rememberMessengerAssistantPrompt(
      "prompt-option-latest-user",
      [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. samurai-avatar/sticker maak,",
        "3. samurai-illustratie voor een poster maak,",
      ].join("\n"),
      4_500,
      "assistant-options-latest-mid"
    );

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-option-latest-user",
        text: "Nr 2 go",
        now: 4_600,
      })
    ).toBe("Maak deze afbeelding: samurai-avatar/sticker");

    expect(
      resolveMessengerImagePromptFromUserText({
        senderId: "prompt-option-latest-user",
        text: "3",
        now: 4_700,
      })
    ).toBe("Maak deze afbeelding: samurai-illustratie voor een poster");
  });
});

describe("hasMessengerImageGenerationIntent", () => {
  it("matches explicit generation and restyle prompts", () => {
    expect(hasMessengerImageGenerationIntent("Restyle deze foto")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak een afbeelding van een robot")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Kan je een afbeelding maken van een robot?")).toBe(
      true,
    );
    expect(hasMessengerImageGenerationIntent("Ik wil een afbeelding genereren")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak een futuristische stad bij zonsondergang")).toBe(
      true,
    );
    expect(hasMessengerImageGenerationIntent("Maak een draak boven Antwerpen")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Kan je een draak met neonvleugels maken?")).toBe(
      true,
    );
    expect(hasMessengerImageGenerationIntent("Maak me een romeinse soldaat")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Maak mij een stripheld")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Kan je me een samurai maken")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Kun je voor mij een samoerai maken?")).toBe(true);
    expect(hasMessengerImageGenerationIntent("samurai-avatar/sticker maak")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Ik zie geen samurai bro")).toBe(true);
    expect(hasMessengerImageGenerationIntent("Das mooi, maar geen samurai bro")).toBe(true);
  });

  it("does not match image analysis or writing-style prompts", () => {
    expect(hasMessengerImageGenerationIntent("Wat zie je op deze foto?")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Verbeter de stijl van deze tekst")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Maak een prompt voor een afbeelding")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Write an image prompt for a robot")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Maak een planning voor morgen")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Maak me een planning voor morgen")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Kan je een plan voor morgen maken?")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Can you create a booking for tomorrow?")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Doe maar")).toBe(false);
    expect(hasMessengerImageGenerationIntent("Ok")).toBe(false);
  });

  it("separates source-photo edits from free image generation prompts", () => {
    expect(hasMessengerSourceImageEditIntent("Restyle deze foto als cinematic poster")).toBe(true);
    expect(hasMessengerSourceImageEditIntent("Bewerk deze foto met neon licht")).toBe(true);
    expect(hasMessengerSourceImageEditIntent("Maak een futuristische stad")).toBe(false);
    expect(hasMessengerSourceImageEditIntent("Kan je een landschap afbeelding genereren?")).toBe(
      false,
    );
  });
});

describe("shouldForwardMessengerTextToImageGen", () => {
  it("forwards explicit text image requests to the Leaderbot conversation layer", () => {
    expect(shouldForwardMessengerTextToImageGen("Maak een afbeelding van een robot")).toBe(true);
    expect(shouldForwardMessengerTextToImageGen("Kan je een landschap afbeelding genereren?")).toBe(
      true,
    );
    expect(
      shouldForwardMessengerTextToImageGen(
        "Een afbeelding maken een Belgisch landschap in de natuur",
      ),
    ).toBe(true);
    expect(shouldForwardMessengerTextToImageGen("Maak me een romeinse soldaat")).toBe(true);
  });

  it("keeps non-image and prompt-writing requests in the normal OpenClaw turn", () => {
    expect(shouldForwardMessengerTextToImageGen("Maak een prompt voor een afbeelding")).toBe(false);
    expect(shouldForwardMessengerTextToImageGen("Schrijf een planning voor morgen")).toBe(false);
    expect(shouldForwardMessengerTextToImageGen("Wat zie je op deze foto?")).toBe(false);
    expect(
      shouldForwardMessengerTextToImageGen(
        "Hey leaderbot kan jij mij een trucje tonen hoe ik op mijn oude xbox 360 gratis kan gamen",
      ),
    ).toBe(false);
  });
});

describe("processMessengerEvent unknown sender access policy", () => {
  it("keeps private pairing mode unchanged for unknown senders", async () => {
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
      return new Response(
        JSON.stringify({
          message_id: "pairing-message",
          recipient_id: "sender-mid-private-pairing",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerTextEvent("mid-private-pairing"), {
      dmPolicy: "pairing",
      allowFrom: undefined,
    });

    expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sendBody.recipient).toEqual({ id: "sender-mid-private-pairing" });
    expect(String(sendBody.message?.text ?? "")).toContain("pairing");
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("keeps ordinary unknown-sender free-tier text in the OpenClaw turn", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
      return new Response(JSON.stringify({ recipient_id: "sender-mid-free-tier" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerTextEvent("mid-free-tier", "Wie ben jij?"), {
      dmPolicy: "pairing",
      allowFrom: undefined,
      unknownSenderMode: "leaderbot_free_tier",
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sendBody.sender_action).toBe("typing_on");
    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary smoke-test questions in OpenClaw instead of the Leaderbot bridge", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
      return new Response(JSON.stringify({ recipient_id: "sender-mid-free-tier-xbox" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown senders in pairing when the Leaderbot bridge is not enabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn();
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
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

    await processGatewayTestEvent(messengerTextEvent("mid-free-tier-disabled", "Hi"), {
      dmPolicy: "pairing",
      allowFrom: undefined,
      unknownSenderMode: "leaderbot_free_tier",
    });

    expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("blocks free-tier Leaderbot event forwards at the gateway daily cap", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP = "1";
    expect(
      reserveMessengerGatewayDailyLeaderbotEventForwardBudget({ accountId: "default" }),
    ).toMatchObject({ ok: true, count: 1, cap: 1 });
    const inboundRun = vi.fn();
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR-1", created: true }));
    setGatewayRuntime(inboundRun, { upsertPairingRequest });
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
      return new Response(
        JSON.stringify({
          message_id: "event-budget-reply",
          recipient_id: "sender-mid-free-tier-cap",
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerImagePromptEvent("mid-free-tier-cap"), {
      dmPolicy: "pairing",
      allowFrom: undefined,
      unknownSenderMode: "leaderbot_free_tier",
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sendBody).toMatchObject({
      messaging_type: "RESPONSE",
      message: { text: "Even pauze, ons dagbudget is bereikt. Probeer later opnieuw." },
      recipient: { id: "sender-mid-free-tier-cap" },
    });
    expect(sendBody.message.text).not.toContain("Hi");
    expect(sendBody.message.text).not.toContain("mid-free-tier-cap");
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
      if (href === "https://image-gen.example.test/internal/messenger/webhook-event") {
        return new Response(JSON.stringify({ error: "unavailable" }), {
          headers: { "content-type": "application/json" },
          status: 503,
        });
      }
      if (href === "https://graph.facebook.com/v20.0/page-1/messages") {
        return new Response(JSON.stringify({ error: { message: "send failed", code: 10 } }), {
          headers: { "content-type": "application/json" },
          status: 500,
        });
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
  it("forwards delete-data smoke requests to the Leaderbot Messenger handler when enabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://image-gen.example.test/internal/messenger/webhook-event");
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerTextEvent("mid-delete-data-bridge", "Delete my data aub"), {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("forwards delete-data requests with attachments to the privacy handler when enabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://image-gen.example.test/internal/messenger/webhook-event");
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const event = messengerTextEvent("mid-delete-data-attachment", "Delete my data aub");
    event.message = {
      ...event.message,
      attachments: [
        {
          type: "image",
          payload: { url: "https://lookaside.facebook.com/delete-data-proof.jpg" },
        },
      ],
    };

    await processGatewayTestEvent(event, {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("does not budget-block delete-data forwards", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP = "1";
    expect(
      reserveMessengerGatewayDailyLeaderbotEventForwardBudget({ accountId: "default" }),
    ).toMatchObject({ ok: true, count: 1, cap: 1 });
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://image-gen.example.test/internal/messenger/webhook-event");
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerTextEvent("mid-delete-data-budget", "Delete my data aub"), {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const bridgeBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(bridgeBody).toMatchObject({
      event: {
        sender: { id: "sender-mid-delete-data-budget" },
        message: { mid: "mid-delete-data-budget", text: "Delete my data aub" },
      },
    });
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("handles delete-data smoke requests before the OpenClaw inbound turn", async () => {
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
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

    await processGatewayTestEvent(messengerTextEvent("mid-delete-data", "Delete my data aub"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sendBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
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
      expect(String(url)).toBe("https://image-gen.example.test/internal/messenger/webhook-event");
      return new Response(JSON.stringify({ status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerImagePromptEvent("mid-image-forward"), {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("blocks image prompt forwarding at the gateway daily cap before calling Leaderbot", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP = "1";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = String(url);
      if (href === "https://image-gen.example.test/internal/messenger/webhook-event") {
        return new Response(JSON.stringify({ status: "queued" }), {
          headers: { "content-type": "application/json" },
          status: 202,
        });
      }
      if (href === "https://graph.facebook.com/v20.0/page-1/messages") {
        return new Response(
          JSON.stringify({
            message_id: "gateway-budget-reply",
            recipient_id: "sender-mid-image-forward-cap-b",
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

    await processGatewayTestEvent(messengerImagePromptEvent("mid-image-forward-cap-a"), {
      leaderbotBridgeEnabled: true,
    });
    await processGatewayTestEvent(messengerImagePromptEvent("mid-image-forward-cap-b"), {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/webhook-event",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://graph.facebook.com/v20.0/page-1/messages",
    );
    const sendBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(sendBody).toMatchObject({
      messaging_type: "RESPONSE",
      message: {
        text: "Even pauze, ons dagbudget voor afbeeldingen is bereikt. Probeer later opnieuw.",
      },
      recipient: { id: "sender-mid-image-forward-cap-b" },
    });
    expect(JSON.stringify(sendBody)).not.toContain("mid-image-forward-cap-a");
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("blocks audio transcription at the gateway daily cap before downloading media", async () => {
    process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP = "1";
    expect(
      reserveMessengerGatewayDailyAudioTranscriptionBudget({ accountId: "default" }),
    ).toMatchObject({ ok: true, count: 1, cap: 1 });
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
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
    const sendBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sendBody).toMatchObject({
      messaging_type: "RESPONSE",
      message: {
        text: "Even pauze, ons dagbudget voor voiceberichten is bereikt. Typ je bericht even uit, dan help ik meteen verder.",
      },
      recipient: { id: "sender-mid-audio-cap" },
    });
    expect(JSON.stringify(sendBody)).not.toContain("https://cdn.fbsbx.com/voice-message.mp4");
    expect(inboundRun).not.toHaveBeenCalled();
  });

  it("does not forward Messenger image prompts when the Leaderbot bridge is disabled", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
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

    await processGatewayTestEvent(messengerImagePromptEvent("mid-image-forward-disabled"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://graph.facebook.com/v20.0/page-1/messages",
    );
    expect(inboundRun).toHaveBeenCalledTimes(1);
  });

  it("sends only the image-generator-unavailable message when forwarding fails", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      const href = String(url);
      if (href === "https://image-gen.example.test/internal/messenger/webhook-event") {
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

    await processGatewayTestEvent(messengerImagePromptEvent("mid-image-forward-failure"), {
      leaderbotBridgeEnabled: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    const sendBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
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
  it("does not create an empty OpenClaw turn for disabled bridge postbacks", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const inboundRun = setGatewayRuntime();
    const fetchMock = vi.fn(async () => {
      throw new Error("postback should not be sent anywhere");
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(messengerPostbackEvent("mid-postback-disabled"));

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
    expect(sanitizeMessengerSourceImageUrl("https://cdn.fbcdn.net/photo.jpg")).toBe(
      "https://cdn.fbcdn.net/photo.jpg",
    );
    expect(sanitizeMessengerSourceImageUrl("https://lookaside.fbsbx.com/photo.jpg")).toBe(
      "https://lookaside.fbsbx.com/photo.jpg",
    );
  });

  it("rejects non-https or non-Messenger media hosts", () => {
    expect(sanitizeMessengerSourceImageUrl("http://cdn.fbcdn.net/photo.jpg")).toBeNull();
    expect(sanitizeMessengerSourceImageUrl("https://example.test/photo.jpg")).toBeNull();
    expect(sanitizeMessengerSourceImageUrl("not a url")).toBeNull();
  });
});

describe("resolveMessengerFastLaneReply", () => {
  it("returns a direct reply for simple Messenger intents", () => {
    const result = resolveMessengerFastLaneReply("help");

    expect(result?.intent).toBe("help");
    expect(result?.reply).toContain("korte vragen");
  });

  it("does not create a separate text reply for image intents", () => {
    expect(resolveMessengerFastLaneReply("maak afbeelding van een robot")).toBeNull();
  });

  it("returns a direct privacy-safe reply for delete-data requests", () => {
    const result = resolveMessengerFastLaneReply("Delete my data aub");

    expect(result?.intent).toBe("delete_data");
    expect(result?.reply).toContain("privacy@leaderbot.live");
  });
});

describe("shouldDeliverMessengerReplyPayload", () => {
  it("delivers normal assistant text", () => {
    expect(shouldDeliverMessengerReplyPayload({ text: "Normaal antwoord" })).toBe(true);
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
    ).toBe("Ik kon een interne actie niet uitvoeren. Probeer het zo meteen opnieuw.");

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
  it("denies high-cost and runtime tools for untrusted Facebook turns", () => {
    const policy = resolveFacebookInboundToolPolicy({ commandAuthorized: false });

    expect(policy).toMatchObject({
      source: "facebook_untrusted_default",
      tools: {
        deny: expect.arrayContaining([
          "image_generate",
          "video_generate",
          "music_generate",
          "exec",
          "write",
          "apply_patch",
          "group:fs",
          "group:runtime",
        ]),
      },
    });
  });

  it("does not add a deny policy for command-authorized turns", () => {
    expect(resolveFacebookInboundToolPolicy({ commandAuthorized: true })).toBeNull();
  });

  it("merges the default deny policy into OpenClaw runtime config", () => {
    const policy = resolveFacebookInboundToolPolicy({ commandAuthorized: false });
    const hardened = applyFacebookInboundToolPolicyToConfig(
      {
        tools: { deny: ["existing_tool"], allow: ["safe_tool"] },
      } as never,
      policy
    ) as { tools: { deny: string[]; allow: string[] } };

    expect(hardened.tools.allow).toEqual(["safe_tool"]);
    expect(hardened.tools.deny).toEqual(
      expect.arrayContaining(["existing_tool", "image_generate", "exec", "group:fs"])
    );
  });
});

describe("processMessengerEvent tool policy", () => {
  it("stamps default-deny policy onto untrusted Facebook inbound turns", async () => {
    const inboundRun = vi.fn(async () => ({ dispatched: false }));
    setGatewayRuntime(inboundRun);
    const fetchMock = vi.fn(async (url: URL | RequestInfo | string) => {
      expect(String(url)).toBe("https://graph.facebook.com/v20.0/page-1/messages");
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await processGatewayTestEvent(
      messengerTextEvent("mid-tool-policy", "Schrijf een korte planning voor morgen"),
    );

    expect(inboundRun).toHaveBeenCalledTimes(1);
    const runArg = inboundRun.mock.calls[0]?.[0] as {
      adapter: {
        resolveTurn: () => {
          cfg: { tools?: { deny?: string[] } };
          ctxPayload: Record<string, unknown>;
        };
      };
    };
    const resolvedTurn = runArg.adapter.resolveTurn();
    const ctxPayload = resolvedTurn.ctxPayload;

    expect(ctxPayload.CommandAuthorized).toBe(false);
    expect(resolvedTurn.cfg.tools?.deny).toEqual(
      expect.arrayContaining(["image_generate", "video_generate", "exec", "group:fs"])
    );
    expect(ctxPayload.ToolPolicy).toMatchObject({
      source: "facebook_untrusted_default",
      tools: {
        deny: expect.arrayContaining([
          "image_generate",
          "video_generate",
          "exec",
          "write",
          "group:fs",
        ]),
      },
    });
    expect(ctxPayload.Tools).toEqual((ctxPayload.ToolPolicy as { tools: unknown }).tools);
    expect(ctxPayload.ToolPolicySource).toBe("facebook_untrusted_default");
    expect(JSON.stringify(ctxPayload.ToolPolicy)).not.toContain("sender-mid-tool-policy");
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
          { type: "audio", kind: "audio", url: "https://lookaside.facebook.com/voice.mp4" },
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
          { type: "audio", kind: "audio", url: "https://lookaside.facebook.com/voice.mp4" },
        ],
        audioTranscripts: [{ mediaIndex: 0, text: "maak de afbeelding opnieuw" }],
      }),
    ).toBe("extra context\n\nTranscriptie voicebericht:\nmaak de afbeelding opnieuw");
  });

  it("falls back to an audio attachment instruction when no transcript exists", () => {
    expect(
      buildMessengerAgentTextForAttachments({
        text: "",
        attachments: [
          { type: "audio", kind: "audio", url: "https://lookaside.facebook.com/voice.mp4" },
        ],
      }),
    ).toContain("voice/audio-bericht");
  });
});

describe("downloadMessengerMediaAttachment redirects", () => {
  function attachment(url = "https://lookaside.facebook.com/start"): Parameters<
    typeof downloadMessengerMediaAttachment
  >[0]["attachment"] {
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
    expect(fetchMock.mock.calls[1]?.[0]).toEqual(new URL("https://cdn.fbcdn.net/photo.png"));
  });

  it("rejects a redirect to http media", async () => {
    const fetchMock = vi.fn(async () =>
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
    const fetchMock = vi.fn(async () =>
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
    const fetchMock = vi.fn(async () =>
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
