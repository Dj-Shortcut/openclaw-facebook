import { AsyncLocalStorage } from "node:async_hooks";

type MessengerRequestContext = Readonly<{
  pageId?: string;
}>;

const messengerRequestContext =
  new AsyncLocalStorage<MessengerRequestContext>();

function normalizePageId(pageId: string | undefined): string | undefined {
  const normalized = pageId?.trim();
  return normalized || undefined;
}

/**
 * Keeps the receiving Facebook Page attached to the asynchronous webhook turn.
 * The Page id is transport metadata only; it must never be inferred from a PSID.
 */
export async function runWithMessengerRequestContext<T>(
  pageId: string | undefined,
  task: () => Promise<T>
): Promise<T> {
  return await messengerRequestContext.run(
    Object.freeze({ pageId: normalizePageId(pageId) }),
    task
  );
}

export function getMessengerRequestPageId(): string | undefined {
  return messengerRequestContext.getStore()?.pageId;
}
