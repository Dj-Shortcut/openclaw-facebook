import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationIdentityConfigurationError,
  getConversationIdentityKey,
  parseConversationIdentityConfig,
  resetConversationIdentityConfigForTests,
  type ConversationIdentityConfigurationErrorCode,
} from "./_core/conversationIdentityConfig";

const VALID_SECRET =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const ENVIRONMENT_KEYS = [
  "CONVERSATION_SCOPE_HMAC_KEY_ID",
  "CONVERSATION_SCOPE_HMAC_SECRET",
  "FB_APP_SECRET",
  "JWT_SECRET",
  "PRIVACY_PEPPER",
  "MESSENGER_GENERATION_PARTITION_SECRET",
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map(name => [name, process.env[name]])
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

function expectConfigurationError(
  callback: () => unknown,
  code: ConversationIdentityConfigurationErrorCode
): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationIdentityConfigurationError);
    expect(error).toMatchObject({
      name: "ConversationIdentityConfigurationError",
      code,
      message: "Conversation identity configuration is invalid",
    });
    return;
  }
  throw new Error(
    `Expected conversation identity configuration error: ${code}`
  );
}

afterEach(() => {
  resetConversationIdentityConfigForTests();
  for (const name of ENVIRONMENT_KEYS) {
    const originalValue = originalEnvironment[name];
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
});

describe("conversation identity configuration", () => {
  it("accepts exactly 32 bytes of lowercase hex and a strict k1 key id", () => {
    const key = parseConversationIdentityConfig({
      CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
      CONVERSATION_SCOPE_HMAC_SECRET: VALID_SECRET,
    });
    const payload = Buffer.from("fixed-payload", "ascii");

    expect(key.keyId).toBe("k1");
    expect(key.sign(payload)).toEqual(
      createHmac("sha256", Buffer.from(VALID_SECRET, "hex"))
        .update(payload)
        .digest()
    );
    expect(Object.isFrozen(key)).toBe(true);
  });

  it.each(["k0", "k01", "K1", "v1", "k1 ", " k1", "k1000000"])(
    "rejects non-canonical key id %j",
    keyId => {
      expectConfigurationError(
        () =>
          parseConversationIdentityConfig({
            CONVERSATION_SCOPE_HMAC_KEY_ID: keyId,
            CONVERSATION_SCOPE_HMAC_SECRET: VALID_SECRET,
          }),
        "key_id_invalid"
      );
    }
  );

  it.each([
    VALID_SECRET.slice(0, -1),
    `${VALID_SECRET}0`,
    VALID_SECRET.toUpperCase(),
    `${VALID_SECRET} `,
    ` ${VALID_SECRET}`,
    "g".repeat(64),
  ])(
    "rejects a secret that is not exactly 64 lowercase hex characters",
    secret => {
      expectConfigurationError(
        () =>
          parseConversationIdentityConfig({
            CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
            CONVERSATION_SCOPE_HMAC_SECRET: secret,
          }),
        "secret_invalid"
      );
    }
  );

  it("distinguishes missing values from malformed values", () => {
    expectConfigurationError(
      () =>
        parseConversationIdentityConfig({
          CONVERSATION_SCOPE_HMAC_SECRET: VALID_SECRET,
        }),
      "key_id_missing"
    );
    expectConfigurationError(
      () =>
        parseConversationIdentityConfig({
          CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
        }),
      "secret_missing"
    );
    expectConfigurationError(
      () =>
        parseConversationIdentityConfig({
          CONVERSATION_SCOPE_HMAC_KEY_ID: " ",
          CONVERSATION_SCOPE_HMAC_SECRET: VALID_SECRET,
        }),
      "key_id_invalid"
    );
    expectConfigurationError(
      () =>
        parseConversationIdentityConfig({
          CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
          CONVERSATION_SCOPE_HMAC_SECRET: " ",
        }),
      "secret_invalid"
    );
  });

  it("never falls back to application, privacy, JWT, or queue secrets", () => {
    process.env.CONVERSATION_SCOPE_HMAC_KEY_ID = "k1";
    delete process.env.CONVERSATION_SCOPE_HMAC_SECRET;
    process.env.FB_APP_SECRET = VALID_SECRET;
    process.env.JWT_SECRET = VALID_SECRET;
    process.env.PRIVACY_PEPPER = VALID_SECRET;
    process.env.MESSENGER_GENERATION_PARTITION_SECRET = VALID_SECRET;
    resetConversationIdentityConfigForTests();

    expectConfigurationError(
      () => getConversationIdentityKey(),
      "secret_missing"
    );
  });
});
