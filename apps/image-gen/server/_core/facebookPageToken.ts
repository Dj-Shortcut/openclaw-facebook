import crypto from "node:crypto";

import { getConfiguredJwtSecret } from "./env";

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
