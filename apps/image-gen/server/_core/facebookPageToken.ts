import crypto from "node:crypto";

import { assertAuthConfig, getConfiguredJwtSecret } from "./env";

/**
 * Page delivery decrypts a persisted credential with JWT_SECRET. Keep this
 * production startup guard even though browser-session authentication has been
 * retired from the owner-operated Messenger runtime.
 */
export function assertFacebookPageTokenConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  assertAuthConfig();
}

/** Encrypt the owner Page token before it is persisted in the channel binding. */
export function sealFacebookPageToken(token: string): string {
  const secret = getConfiguredJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required to store Facebook page tokens");
  }

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function unsealFacebookPageToken(sealedToken: string): string {
  const secret = getConfiguredJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required to read Facebook page tokens");
  }

  const [version, ivValue, tagValue, encryptedValue, extra] =
    sealedToken.split(":");
  if (
    version !== "v1" ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    extra !== undefined
  ) {
    throw new Error("Facebook page token envelope is invalid");
  }

  try {
    const key = crypto.createHash("sha256").update(secret).digest();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivValue, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Facebook page token envelope could not be opened");
  }
}
