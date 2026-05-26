import { createHmac } from "crypto";

function getPrivacyPepper(): string {
  const pepper = process.env.PRIVACY_PEPPER?.trim();

  if (!pepper) {
    throw new Error("PRIVACY_PEPPER is required");
  }

  return pepper;
}

export function assertPrivacyConfig(): void {
  getPrivacyPepper();
}

export function toUserKey(psid: string): string {
  return createHmac("sha256", getPrivacyPepper()).update(psid).digest("hex");
}

export function toLogUser(userKey: string): string {
  return userKey.slice(0, 8);
}
