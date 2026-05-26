import type { ConversationState } from "./messengerState";
import type { BotResponse } from "./botResponse";

function assertNever(_value: never): void {}

type BotResponseSendOptions = {
  replyState?: ConversationState;
  sendText: (text: string) => Promise<void>;
  sendStateText?: (state: ConversationState, text: string) => Promise<void>;
  sendOptionsPrompt?: (
    prompt: string,
    options: Array<{ id: string; title: string }>,
    fallbackText?: string
  ) => Promise<void>;
  sendImage?: (imageUrl: string, caption?: string) => Promise<void>;
  sendResultCard?: (card: Extract<BotResponse, { kind: "result_card" }>) => Promise<void>;
};

function optionsFallbackText(
  response: Extract<BotResponse, { kind: "options_prompt" }>
): string {
  return (
    response.fallbackText ??
    [response.prompt, ...response.options.map(option => option.title)].join("\n")
  );
}

async function sendTextResponse(
  response: Extract<BotResponse, { kind: "text" }>,
  options: BotResponseSendOptions
): Promise<void> {
  if (options.replyState && options.sendStateText) {
    await options.sendStateText(options.replyState, response.text);
    return;
  }

  await options.sendText(response.text);
}

async function sendOptionsResponse(
  response: Extract<BotResponse, { kind: "options_prompt" }>,
  options: BotResponseSendOptions
): Promise<void> {
  if (options.sendOptionsPrompt) {
    await options.sendOptionsPrompt(
      response.prompt,
      response.options,
      response.fallbackText
    );
    return;
  }

  await options.sendText(optionsFallbackText(response));
}

async function sendResultCardResponse(
  response: Extract<BotResponse, { kind: "result_card" }>,
  options: BotResponseSendOptions
): Promise<void> {
  if (options.sendResultCard) {
    await options.sendResultCard(response);
    return;
  }

  if (response.imageUrl && options.sendImage) {
    await options.sendImage(response.imageUrl, response.title);
  }
  await options.sendText([response.title, response.body].join("\n\n"));
}

async function sendImageResponse(
  response: Extract<BotResponse, { kind: "image" }>,
  options: BotResponseSendOptions
): Promise<void> {
  if (options.sendImage) {
    await options.sendImage(response.imageUrl, response.caption);
    return;
  }

  await options.sendText(response.caption ?? "[Image not available]");
}

async function sendBotResponse(
  response: BotResponse | null,
  options: BotResponseSendOptions
): Promise<void> {
  if (!response) {
    return;
  }

  switch (response.kind) {
    case "text":
      await sendTextResponse(response, options);
      return;
    case "options_prompt":
      await sendOptionsResponse(response, options);
      return;
    case "result_card":
      await sendResultCardResponse(response, options);
      return;
    case "image":
      await sendImageResponse(response, options);
      return;
    case "handoff_state":
      if (response.text) {
        await options.sendText(response.text);
      }
      return;
    case "error":
      await options.sendText(response.text);
      return;
    case "ack":
    case "typing":
      return;
    default:
      assertNever(response);
  }
}

export async function sendMessengerBotResponse(
  response: BotResponse | null,
  options: BotResponseSendOptions & {
    sendStateText: (state: ConversationState, text: string) => Promise<void>;
  }
): Promise<void> {
  await sendBotResponse(response, options);
}

export async function sendWhatsAppBotResponse(
  response: BotResponse | null,
  options: BotResponseSendOptions
): Promise<void> {
  await sendBotResponse(response, options);
}
