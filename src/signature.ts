import { createHmac, timingSafeEqual } from "node:crypto";

export function validateMessengerSignature(
  rawBody: string,
  signatureHeader: string,
  appSecret: string,
): boolean {
  const signature = signatureHeader.trim();
  const secret = appSecret.trim();
  if (!rawBody || !signature || !secret || !signature.startsWith("sha256=")) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
