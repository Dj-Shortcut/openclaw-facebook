import { normalizeLang, t, type Lang } from "./i18n";
import { createWebhookHandlers } from "./webhookHandlers";
import { resetWebhookReplayProtection } from "./webhookReplayProtection";
export { processWhatsAppWebhookPayload } from "./whatsappWebhook";

const PRIVACY_POLICY_URL = process.env.PRIVACY_POLICY_URL?.trim() || "<link>";
const DEFAULT_LANG = normalizeLang(process.env.DEFAULT_MESSENGER_LANG);

const handlers = createWebhookHandlers({
  defaultLang: DEFAULT_LANG,
  privacyPolicyUrl: PRIVACY_POLICY_URL,
});

export function resetMessengerEventDedupe(): void {
  resetWebhookReplayProtection();
}

export async function processFacebookWebhookPayload(
  payload: unknown
): Promise<void> {
  await handlers.processFacebookWebhookPayload(payload);
}

export async function processInternalMessengerImageRequest(input: {
  psid: string;
  prompt: string;
  reqId: string;
  lang?: Lang;
  timestamp?: number;
}): Promise<void> {
  await handlers.processInternalMessengerImageRequest(input);
}
