import {
  getState,
  setConsentState,
  type MessengerUserState,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";

export const TEST_MESSENGER_PAGE_ID = "test-receiving-page";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function collectSenderIds(
  values: unknown[],
  getSenderId: (value: unknown) => unknown
): string[] {
  const ids = new Set<string>();

  for (const value of values) {
    const senderId = getSenderId(value);
    if (typeof senderId === "string") {
      ids.add(senderId);
    }
  }

  return Array.from(ids);
}

function getPayloadEntries(payload: unknown): unknown[] {
  return asArray((payload as { entry?: unknown[] })?.entry);
}

export function withTestMessengerPageId(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const entries = getPayloadEntries(payload);
  return {
    ...payload,
    entry: entries.map(entry => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }

      const pageId = (entry as { id?: unknown }).id;
      return {
        ...entry,
        id:
          typeof pageId === "string" && pageId.trim()
            ? pageId
            : TEST_MESSENGER_PAGE_ID,
      };
    }),
  };
}

export async function runWithTestMessengerPageContext<T>(
  task: () => T | Promise<T>
): Promise<T> {
  return await runWithMessengerRequestContext(TEST_MESSENGER_PAGE_ID, async () =>
    await task()
  );
}

export async function getTestMessengerState(
  psid: string
): Promise<MessengerUserState | null> {
  return await runWithTestMessengerPageContext(() =>
    Promise.resolve(getState(psid))
  );
}

async function grantConsent(senderIds: string[]): Promise<void> {
  await Promise.all(senderIds.map(senderId => setConsentState(senderId, true)));
}

async function grantMessengerConsent(payload: unknown): Promise<void> {
  await Promise.all(
    getPayloadEntries(payload).map(async entry => {
      const pageId = (entry as { id?: unknown })?.id;
      const senderIds = collectSenderIds(
        asArray((entry as { messaging?: unknown[] })?.messaging),
        event => (event as { sender?: { id?: unknown } })?.sender?.id
      );
      await runWithMessengerRequestContext(
        typeof pageId === "string" ? pageId : undefined,
        () => grantConsent(senderIds)
      );
    })
  );
}

type WebhookPayloadProcessor = (payload: unknown) => Promise<void>;

function createConsentedWebhookPayloadProcessor() {
  function processConsentedPayload(
    processPayload: WebhookPayloadProcessor
  ): WebhookPayloadProcessor;
  function processConsentedPayload(
    processPayload: WebhookPayloadProcessor,
    payload: unknown
  ): Promise<void>;
  function processConsentedPayload(
    processPayload: WebhookPayloadProcessor,
    payload?: unknown
  ): Promise<void> | WebhookPayloadProcessor {
    const processWithConsent: WebhookPayloadProcessor = async nextPayload => {
      const scopedPayload = withTestMessengerPageId(nextPayload);
      await grantMessengerConsent(scopedPayload);
      await processPayload(scopedPayload);
    };

    if (payload === undefined) {
      return processWithConsent;
    }

    return processWithConsent(payload);
  }

  return processConsentedPayload;
}

export const processConsentedFacebookWebhookPayload =
  createConsentedWebhookPayloadProcessor();
