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
        replyState: "AWAITING_STYLE",
        sendText,
        sendStateText,
      }
    );

    expect(sendStateText).toHaveBeenCalledWith("AWAITING_STYLE", "hello");
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

  it("maps Messenger options prompts to the dedicated sender when available", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});
    const sendOptionsPrompt = vi.fn(async () => {});

    await sendMessengerBotResponse(
      {
        kind: "options_prompt",
        prompt: "Choose",
        options: [
          { id: "ONE", title: "One" },
          { id: "TWO", title: "Two" },
        ],
        selectionMode: "single",
        fallbackText: "Choose: One or Two",
      },
      {
        sendText,
        sendStateText,
        sendOptionsPrompt,
      }
    );

    expect(sendOptionsPrompt).toHaveBeenCalledWith(
      "Choose",
      [
        { id: "ONE", title: "One" },
        { id: "TWO", title: "Two" },
      ],
      "Choose: One or Two"
    );
    expect(sendText).not.toHaveBeenCalled();
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

  it("passes through handoff_state text without failing on unsupported channel handling", async () => {
    const sendText = vi.fn(async () => {});
    const sendStateText = vi.fn(async () => {});

    await sendMessengerBotResponse(
      {
        kind: "handoff_state",
        state: "identity_game_waiting",
        text: "Handing off",
      },
      {
        sendText,
        sendStateText,
      }
    );

    expect(sendText).toHaveBeenCalledWith("Handing off");
    expect(sendStateText).not.toHaveBeenCalled();
  });
});
