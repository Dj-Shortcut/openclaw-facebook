import { createHmac } from "node:crypto";

import type { SupportedUiLang } from "./i18n";
import type { GenerationKind } from "./image-generation/generationTypes";

const MESSENGER_GENERATION_TENANT_PARTITION_PATTERN = /^page-v1-[a-f0-9]{64}$/;

export function createMessengerGenerationTenantPartition(
  pageId: string,
  secret: string
): string {
  const digest = createHmac("sha256", secret)
    .update(pageId.trim())
    .digest("hex");
  return `page-v1-${digest}`;
}

export function isMessengerGenerationTenantPartition(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    MESSENGER_GENERATION_TENANT_PARTITION_PATTERN.test(value)
  );
}

export type MessengerGenerationJob = {
  /** Work type is explicit so a tenant queue cannot route video work through the image worker. */
  operation?: "image" | "video";
  psid: string;
  userId: string;
  /** Facebook Page receiving the message; used only for workspace resolution. */
  pageId?: string;
  /** Opaque Page-derived boundary used only for tenant-partitioned queue storage. */
  tenantPartition?: string;
  generationKind?: GenerationKind;
  reqId: string;
  lang: SupportedUiLang;
  sourceImageUrl?: string;
  promptHint?: string;
  attempts?: number;
};
