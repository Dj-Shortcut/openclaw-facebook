import { AsyncLocalStorage } from "node:async_hooks";

type MessengerRequestContext = {
  channel?: "facebook_messenger" | "whatsapp";
  pageId?: string;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  userKey?: string;
  privacyEpoch?: number;
  erasureDataPrivacyEpoch?: number;
  operationId?: string;
  erasureControlDelivery?: boolean;
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
    channel?: "facebook_messenger" | "whatsapp";
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
  delete context.erasureDataPrivacyEpoch;
}

/**
 * Marks a retry of an already-started erasure.
 *
 * The database subject has already advanced to `privacyEpoch`, while customer
 * state still belongs to the immediately preceding data epoch. Keeping both
 * values explicit prevents a retry from opening normal state at the erasing
 * epoch or accidentally targeting a later reactivation.
 */
export function setMessengerRequestErasurePrivacySubject(input: {
  userKey: string;
  privacyEpoch: number;
  dataPrivacyEpoch: number;
}): void {
  const context = messengerRequestContext.getStore();
  if (
    !context ||
    !input.userKey.trim() ||
    !Number.isSafeInteger(input.privacyEpoch) ||
    !Number.isSafeInteger(input.dataPrivacyEpoch) ||
    input.dataPrivacyEpoch <= 0 ||
    input.privacyEpoch !== input.dataPrivacyEpoch + 1
  ) {
    throw new Error("Messenger erasure request context is unavailable");
  }
  context.userKey = input.userKey;
  context.privacyEpoch = input.privacyEpoch;
  context.erasureDataPrivacyEpoch = input.dataPrivacyEpoch;
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

export async function runWithMessengerErasureControlDelivery<T>(
  task: () => Promise<T>
): Promise<T> {
  const context = messengerRequestContext.getStore();
  if (!context) {
    throw new Error("Messenger request context is unavailable");
  }
  return await messengerRequestContext.run(
    { ...context, erasureControlDelivery: true },
    task
  );
}

export function isMessengerErasureControlDelivery(): boolean {
  return messengerRequestContext.getStore()?.erasureControlDelivery === true;
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

export function getMessengerRequestErasurePrivacySubject():
  | Readonly<{
      userKey: string;
      privacyEpoch: number;
      dataPrivacyEpoch: number;
    }>
  | undefined {
  const context = messengerRequestContext.getStore();
  if (
    !context?.userKey ||
    !context.privacyEpoch ||
    !context.erasureDataPrivacyEpoch ||
    context.privacyEpoch !== context.erasureDataPrivacyEpoch + 1
  ) {
    return undefined;
  }
  return {
    userKey: context.userKey,
    privacyEpoch: context.privacyEpoch,
    dataPrivacyEpoch: context.erasureDataPrivacyEpoch,
  };
}

export function getMessengerRequestPageId(): string | undefined {
  return messengerRequestContext.getStore()?.pageId;
}

export function getMessengerRequestChannel():
  "facebook_messenger" | "whatsapp" | undefined {
  return messengerRequestContext.getStore()?.channel;
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
