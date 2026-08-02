const META_IDENTIFIER_PATTERN = /^[1-9][0-9]{0,31}$/;

declare const messengerPageIdBrand: unique symbol;
declare const whatsappBusinessAccountIdBrand: unique symbol;
declare const whatsappPhoneNumberIdBrand: unique symbol;
declare const conversationSenderIdBrand: unique symbol;

export type MessengerPageId = string & {
  readonly [messengerPageIdBrand]: true;
};
export type WhatsAppBusinessAccountId = string & {
  readonly [whatsappBusinessAccountIdBrand]: true;
};
export type WhatsAppPhoneNumberId = string & {
  readonly [whatsappPhoneNumberIdBrand]: true;
};
export type ConversationSenderId = string & {
  readonly [conversationSenderIdBrand]: true;
};

export type MessengerEndpoint = Readonly<{
  channel: "messenger";
  pageId: MessengerPageId;
}>;

export type WhatsAppEndpoint = Readonly<{
  channel: "whatsapp";
  wabaId: WhatsAppBusinessAccountId;
  phoneNumberId: WhatsAppPhoneNumberId;
}>;

export type ConversationEndpoint = MessengerEndpoint | WhatsAppEndpoint;

export type ConversationIdentityErrorCode =
  | "invalid_input"
  | "unsupported_channel"
  | "endpoint_context_mismatch"
  | "binding_not_found"
  | "binding_ambiguous"
  | "binding_inactive"
  | "binding_lookup_failed";

export class ConversationIdentityError extends Error {
  readonly code: ConversationIdentityErrorCode;
  readonly retryable: boolean;

  constructor(code: ConversationIdentityErrorCode, retryable = false) {
    super("Conversation identity is unavailable");
    this.name = "ConversationIdentityError";
    this.code = code;
    this.retryable = retryable;
  }
}

function parseMetaIdentifier(value: unknown): string {
  if (typeof value !== "string" || !META_IDENTIFIER_PATTERN.test(value)) {
    throw new ConversationIdentityError("invalid_input");
  }
  return value;
}

export function resolveMessengerEndpoint(input: {
  entryId?: unknown;
  recipientId?: unknown;
}): MessengerEndpoint {
  const entryId =
    input.entryId === undefined
      ? undefined
      : (parseMetaIdentifier(input.entryId) as MessengerPageId);
  const recipientId =
    input.recipientId === undefined
      ? undefined
      : (parseMetaIdentifier(input.recipientId) as MessengerPageId);

  if (entryId && recipientId && entryId !== recipientId) {
    throw new ConversationIdentityError("endpoint_context_mismatch");
  }

  const pageId = entryId ?? recipientId;
  if (!pageId) {
    throw new ConversationIdentityError("invalid_input");
  }

  return Object.freeze({ channel: "messenger", pageId });
}

export function resolveMessengerWebhookEndpoint(input: {
  entryId?: unknown;
  recipientId?: unknown;
}): MessengerEndpoint {
  const entryId = parseMetaIdentifier(input.entryId) as MessengerPageId;
  const recipientId = parseMetaIdentifier(input.recipientId) as MessengerPageId;

  if (entryId !== recipientId) {
    throw new ConversationIdentityError("endpoint_context_mismatch");
  }

  return Object.freeze({ channel: "messenger", pageId: entryId });
}

export function resolveWhatsAppEndpoint(input: {
  wabaId?: unknown;
  phoneNumberId?: unknown;
}): WhatsAppEndpoint {
  const wabaId = parseMetaIdentifier(input.wabaId) as WhatsAppBusinessAccountId;
  const phoneNumberId = parseMetaIdentifier(
    input.phoneNumberId
  ) as WhatsAppPhoneNumberId;

  return Object.freeze({ channel: "whatsapp", wabaId, phoneNumberId });
}

export function resolveConversationSenderId(
  value: unknown
): ConversationSenderId {
  return parseMetaIdentifier(value) as ConversationSenderId;
}

export function revalidateConversationEndpoint(
  endpoint: ConversationEndpoint
): ConversationEndpoint {
  if (endpoint?.channel === "messenger") {
    return resolveMessengerEndpoint({ entryId: endpoint.pageId });
  }
  if (endpoint?.channel === "whatsapp") {
    return resolveWhatsAppEndpoint({
      wabaId: endpoint.wabaId,
      phoneNumberId: endpoint.phoneNumberId,
    });
  }
  throw new ConversationIdentityError("unsupported_channel");
}
