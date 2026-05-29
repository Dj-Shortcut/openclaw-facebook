import { createHash } from "node:crypto";

export function summarizeSensitiveUrl(url: string): { host: string; shortHash: string } {
  const shortHash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  try {
    return { host: new URL(url).host || "invalid-url", shortHash };
  } catch {
    return { host: "invalid-url", shortHash };
  }
}
