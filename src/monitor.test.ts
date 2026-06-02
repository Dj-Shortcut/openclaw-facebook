import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  resolveMessengerImagePromptFromUserText,
  resolveMessengerEventTarget,
  resolveMessengerSourceImageGenerationPrompt,
  resolveMessengerVerificationTarget,
  sanitizeMessengerSourceImageUrl,
  normalizeMessengerReplyPayloadForDelivery,
  rememberMessengerAssistantPrompt,
  shouldDeliverMessengerReplyPayload,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldForwardMessengerTextToImageGen,
  shouldProcessMessengerMessageOnce,
  type MessengerWebhookTarget,
} from "./monitor.js";
import { MESSENGER_OPENCLAW_ACTION_PREFIX } from "./presentation.js";

const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
let temporaryStateDir: string | null = null;

beforeEach(async () => {
  temporaryStateDir = await mkdtemp(join(tmpdir(), "openclaw-facebook-test-"));
  process.env.OPENCLAW_STATE_DIR = temporaryStateDir;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
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
        text: 'search "pill flow" in !**/node_modules/** (workspace) failed',
        isStatusNotice: true,
      })?.text,
    ).toBe('Toolfeedback: search "pill flow" in !**/node_modules/** (workspace) is mislukt');

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
