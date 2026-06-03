import { normalizeLang, type Lang } from "./i18n";
import { createWebhookHandlers } from "./webhookHandlers";
import { resetWebhookReplayProtection } from "./webhookReplayProtection";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import type { MessengerSendOutcome } from "./messengerApi";
export { processWhatsAppWebhookPayload } from "./whatsappWebhook";

const DEFAULT_LANG = normalizeLang(process.env.DEFAULT_MESSENGER_LANG);

const handlers = createWebhookHandlers({
  defaultLang: DEFAULT_LANG,
});

export function resetMessengerEventDedupe(): void {
  resetWebhookReplayProtection();
}

export async function processFacebookWebhookPayload(
  payload: unknown
): Promise<void> {
  await handlers.processFacebookWebhookPayload(payload);
}

export async function acceptInternalMessengerImageRequest(input: {
  psid: string;
  prompt: string;
  reqId: string;
  lang?: Lang;
  timestamp?: number;
  sourceImageUrl?: string;
}): Promise<MessengerSendOutcome> {
  return await handlers.acceptInternalMessengerImageRequest(input);
}

export async function processInternalMessengerImageRequest(input: {
  psid: string;
  prompt: string;
  reqId: string;
  lang?: Lang;
  timestamp?: number;
  sourceImageUrl?: string;
}): Promise<MessengerSendOutcome> {
  return await handlers.processInternalMessengerImageRequest(input);
}

export async function processMessengerGenerationJob(
  input: MessengerGenerationJob
): Promise<void> {
  await handlers.processMessengerGenerationJob(input);
}

export async function processMessengerGenerationJobDeadLetter(
  input: MessengerGenerationJob
): Promise<void> {
  await handlers.processMessengerGenerationJobDeadLetter(input);
}
