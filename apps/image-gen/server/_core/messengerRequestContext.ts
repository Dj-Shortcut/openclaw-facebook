import { AsyncLocalStorage } from "node:async_hooks";

type MessengerRequestContext = {
  pageId?: string;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  userKey?: string;
  privacyEpoch?: number;
  operationId?: string;
};

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
  task: () => Promise<T>,
  ownership?: {
    workspaceId: number;
    channelConnectionId: number;
    bindingEpoch: number;
    userKey?: string;
    privacyEpoch?: number;
  }
): Promise<T> {
  return await messengerRequestContext.run(
    { pageId: normalizePageId(pageId), ...ownership },
    task
  );
}

export function setMessengerRequestPrivacySubject(input: {
  userKey: string;
  privacyEpoch: number;
}): void {
  const context = messengerRequestContext.getStore();
  if (!context) {
    throw new Error("Messenger request context is unavailable");
  }
  context.userKey = input.userKey;
  context.privacyEpoch = input.privacyEpoch;
}

export function setMessengerRequestOperationId(operationId: string): void {
  const context = messengerRequestContext.getStore();
  const normalized = operationId.trim();
  if (!context || !normalized) {
    throw new Error("Messenger request context is unavailable");
  }
  context.operationId = normalized;
}

export function getMessengerRequestOperationId(): string | undefined {
  return messengerRequestContext.getStore()?.operationId;
}

export function getMessengerRequestPrivacySubject():
  | Readonly<{
      userKey: string;
      privacyEpoch: number;
    }>
  | undefined {
  const context = messengerRequestContext.getStore();
  if (!context?.userKey || !context.privacyEpoch) return undefined;
  return { userKey: context.userKey, privacyEpoch: context.privacyEpoch };
}

export function getMessengerRequestPageId(): string | undefined {
  return messengerRequestContext.getStore()?.pageId;
}

export function getMessengerRequestOwnership():
  | Readonly<{
      workspaceId: number;
      channelConnectionId: number;
      bindingEpoch: number;
    }>
  | undefined {
  const context = messengerRequestContext.getStore();
  if (
    !context?.workspaceId ||
    !context.channelConnectionId ||
    !context.bindingEpoch
  ) {
    return undefined;
  }
  return {
    workspaceId: context.workspaceId,
    channelConnectionId: context.channelConnectionId,
    bindingEpoch: context.bindingEpoch,
  };
}
