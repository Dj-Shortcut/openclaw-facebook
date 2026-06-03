import { describe, expect, it, vi } from "vitest";
import {
  sendMessengerBotResponse,
  sendWhatsAppBotResponse,
} from "./_core/botResponseAdapters";

describe("botResponseAdapters", () => {
  it("maps a Messenger text response with replyState to state text sending", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});

    await sendMessengerBotResponse(
      { kind: "text", text: "hello" },
      {
        replyState: "IDLE",
        sendText,
        sendStateText,
      }
    );

    expect(sendStateText).toHaveBeenCalledWith("IDLE", "hello");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("ignores non-text Messenger intents until channel support is added", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});

    await sendMessengerBotResponse(
      { kind: "typing" },
      {
        replyState: "IDLE",
        sendText,
        sendStateText,
      }
    );

    expect(sendStateText).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("maps a WhatsApp text response to plain text sending", async () => {
    const sendText = vi.fn(async () => {});

    await sendWhatsAppBotResponse(
      { kind: "text", text: "hello" },
      {
        sendText,
      }
    );

    expect(sendText).toHaveBeenCalledWith("hello");
  });

  it("maps a WhatsApp text response with replyState to state text sending", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});

    await sendWhatsAppBotResponse(
      { kind: "text", text: "hello" },
      {
        replyState: "AWAITING_EDIT_PROMPT",
        sendText,
        sendStateText,
      }
    );

    expect(sendStateText).toHaveBeenCalledWith("AWAITING_EDIT_PROMPT", "hello");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("ignores non-text WhatsApp intents until channel support is added", async () => {
    const sendText = vi.fn(async () => {});

    await sendWhatsAppBotResponse(
      { kind: "ack" },
      {
        sendText,
      }
    );

    expect(sendText).not.toHaveBeenCalled();
  });

  it("maps channel-neutral actions to the dedicated Messenger action sender", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});

    await sendMessengerBotResponse(
      {
        text: "What next?",
        actions: [
          { id: "restyle", label: "Restyle photo" },
          { id: "retry", label: "Try again" },
        ],
      },
      {
        sendText,
        sendStateText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).toHaveBeenCalledWith("What next?", [
      { id: "restyle", label: "Restyle photo" },
      { id: "retry", label: "Try again" },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("infers Messenger actions from clear numbered choices", async () => {
    const sendText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});
    const text = [
      "Ja. Wil je dat ik een:",
      "",
      "1. samurai-portret maak,",
      "2. samurai-avatar/sticker maak,",
      "3. samurai-illustratie voor een poster maak,",
      "4. of een tekstprompt schrijf",
      "waarmee je hem kunt genereren?",
    ].join("\n");

    await sendMessengerBotResponse(
      {
        text,
      },
      {
        sendText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).toHaveBeenCalledWith("Ja. Wil je dat ik een:", [
      {
        id: "choice_1",
        label: "samurai-portret",
        inputText: "Maak me een samurai-portret",
      },
      {
        id: "choice_2",
        label: "samurai-avatar/sticker",
        inputText: "Maak me een samurai-avatar/sticker",
      },
      {
        id: "choice_3",
        label: "samurai-illustratie voor een poster",
        inputText: "Maak me een samurai-illustratie voor een poster",
      },
      {
        id: "choice_4",
        label: "tekstprompt",
        inputText: "Schrijf een tekstprompt",
      },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("keeps explicit actions like Privacy next to inferred numbered choices", async () => {
    const sendText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});
    const text = [
      "Ja. Wil je dat ik een:",
      "",
      "1. samurai-portret maak,",
      "2. samurai-avatar/sticker maak,",
    ].join("\n");

    await sendMessengerBotResponse(
      {
        text,
        actions: [{ id: "privacy", label: "Privacy", inputText: "Privacy" }],
      },
      {
        sendText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).toHaveBeenCalledWith("Ja. Wil je dat ik een:", [
      {
        id: "choice_1",
        label: "samurai-portret",
        inputText: "Maak me een samurai-portret",
      },
      {
        id: "choice_2",
        label: "samurai-avatar/sticker",
        inputText: "Maak me een samurai-avatar/sticker",
      },
      { id: "privacy", label: "Privacy", inputText: "Privacy" },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("keeps non-choice follow-up text when stripping inferred choices", async () => {
    const sendText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});
    const text = [
      "Ja. Wil je dat ik een:",
      "",
      "1. samurai-portret maak,",
      "2. samurai-avatar/sticker maak,",
      "",
      "Als je wilt, kan ik meteen een stoere versie maken.",
    ].join("\n");

    await sendMessengerBotResponse(
      { text },
      {
        sendText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).toHaveBeenCalledWith(
      "Ja. Wil je dat ik een:\n\nAls je wilt, kan ik meteen een stoere versie maken.",
      [
        {
          id: "choice_1",
          label: "samurai-portret",
          inputText: "Maak me een samurai-portret",
        },
        {
          id: "choice_2",
          label: "samurai-avatar/sticker",
          inputText: "Maak me een samurai-avatar/sticker",
        },
      ]
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not infer numbered choice actions from prompt code blocks", async () => {
    const sendText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});
    const text = [
      "Hier is een prompt:",
      "",
      "```text",
      "1. cinematic portrait",
      "2. poster style",
      "```",
    ].join("\n");

    await sendMessengerBotResponse(
      {
        text,
      },
      {
        sendText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).toHaveBeenCalledWith(text, [
      {
        id: "generate_prompt",
        label: "Maak deze afbeelding",
        inputText:
          "Gebruik deze prompt en maak een afbeelding: 1. cinematic portrait 2. poster style",
      },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("offers a prompt-to-image action for assistant-written image prompts", async () => {
    const sendText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});
    const text = [
      "Hier is een sterke prompt voor je:",
      "",
      "```text",
      "Prompt: Maak een krachtige Romeinse gladiator als hoofdonderwerp in een arena, realistische details, warm licht",
      "```",
    ].join("\n");

    await sendMessengerBotResponse(
      {
        text,
      },
      {
        sendText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).toHaveBeenCalledWith(text, [
      {
        id: "generate_prompt",
        label: "Maak deze afbeelding",
        inputText:
          "Gebruik deze prompt en maak een afbeelding: Maak een krachtige Romeinse gladiator als hoofdonderwerp in een arena, realistische details, warm licht",
      },
    ]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not offer prompt-to-image actions for ordinary code examples", async () => {
    const sendText = vi.fn(async () => {});
    const sendActionPrompt = vi.fn(async () => {});
    const text = [
      "Hier is de functie:",
      "",
      "```ts",
      "const value = createThing();",
      "```",
    ].join("\n");

    await sendMessengerBotResponse(
      {
        text,
      },
      {
        sendText,
        sendActionPrompt,
      }
    );

    expect(sendActionPrompt).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(text);
  });

  it("falls back to plain text when neutral actions have no channel renderer", async () => {
    const sendText = vi.fn(async () => {});

    await sendWhatsAppBotResponse(
      {
        text: "What next?",
        actions: [
          { id: "restyle", label: "Restyle photo" },
          { id: "retry", label: "Try again" },
        ],
      },
      {
        sendText,
      }
    );

    expect(sendText).toHaveBeenCalledWith("What next?\nRestyle photo\nTry again");
  });

  it("maps WhatsApp error responses to plain text", async () => {
    const sendText = vi.fn(async () => {});

    await sendWhatsAppBotResponse(
      {
        kind: "error",
        text: "Something broke",
      },
      {
        sendText,
      }
    );

    expect(sendText).toHaveBeenCalledWith("Something broke");
  });

  it("falls back to a placeholder when an image intent has no channel image sender", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});

    await sendMessengerBotResponse(
      {
        kind: "image",
        imageUrl: "https://cdn.example/result.jpg",
      },
      {
        sendText,
        sendStateText,
      }
    );

    expect(sendText).toHaveBeenCalledWith("[Image not available]");
  });

});
