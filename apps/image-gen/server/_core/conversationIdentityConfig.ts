import { createHmac } from "node:crypto";

const CONVERSATION_SCOPE_SECRET_HEX_LENGTH = 64;
const CONVERSATION_SCOPE_KEY_ID_PATTERN = /^k[1-9][0-9]{0,5}$/;

declare const conversationScopeKeyIdBrand: unique symbol;

export type ConversationScopeKeyId = string & {
  readonly [conversationScopeKeyIdBrand]: true;
};

export type ConversationIdentityKey = Readonly<{
  keyId: ConversationScopeKeyId;
  sign: (payload: Uint8Array) => Buffer;
}>;

export type ConversationIdentityConfigurationErrorCode =
  "secret_missing" | "secret_invalid" | "key_id_missing" | "key_id_invalid";

export class ConversationIdentityConfigurationError extends Error {
  readonly code: ConversationIdentityConfigurationErrorCode;

  constructor(code: ConversationIdentityConfigurationErrorCode) {
    super("Conversation identity configuration is invalid");
    this.name = "ConversationIdentityConfigurationError";
    this.code = code;
  }
}

type ConversationIdentityEnvironment = Readonly<{
  CONVERSATION_SCOPE_HMAC_KEY_ID?: string;
  CONVERSATION_SCOPE_HMAC_SECRET?: string;
}>;

let cachedRuntimeIdentityKey: ConversationIdentityKey | undefined;

function parseKeyId(value: string | undefined): ConversationScopeKeyId {
  if (value === undefined || value === "") {
    throw new ConversationIdentityConfigurationError("key_id_missing");
  }
  if (!CONVERSATION_SCOPE_KEY_ID_PATTERN.test(value)) {
    throw new ConversationIdentityConfigurationError("key_id_invalid");
  }
  return value as ConversationScopeKeyId;
}

function parseSecret(value: string | undefined): Buffer {
  if (value === undefined || value === "") {
    throw new ConversationIdentityConfigurationError("secret_missing");
  }
  if (
    value.length !== CONVERSATION_SCOPE_SECRET_HEX_LENGTH ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    throw new ConversationIdentityConfigurationError("secret_invalid");
  }
  return Buffer.from(value, "hex");
}

export function parseConversationIdentityConfig(
  environment: ConversationIdentityEnvironment
): ConversationIdentityKey {
  const keyId = parseKeyId(environment.CONVERSATION_SCOPE_HMAC_KEY_ID);
  const secret = parseSecret(environment.CONVERSATION_SCOPE_HMAC_SECRET);

  return Object.freeze({
    keyId,
    sign(payload: Uint8Array): Buffer {
      return createHmac("sha256", secret).update(payload).digest();
    },
  });
}

export function getConversationIdentityKey(): ConversationIdentityKey {
  cachedRuntimeIdentityKey ??= parseConversationIdentityConfig(process.env);
  return cachedRuntimeIdentityKey;
}

export function assertConversationIdentityConfig(): void {
  getConversationIdentityKey();
}

export function resetConversationIdentityConfigForTests(): void {
  cachedRuntimeIdentityKey = undefined;
}
