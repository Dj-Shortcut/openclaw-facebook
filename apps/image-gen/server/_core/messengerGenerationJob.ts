import { createHmac } from "node:crypto";

import type { SupportedUiLang } from "./i18n";
import type { GenerationKind } from "./image-generation/generationTypes";

const MESSENGER_GENERATION_TENANT_PARTITION_PATTERN = /^page-v1-[a-f0-9]{64}$/;
const MESSENGER_GENERATION_OWNERSHIP_PARTITION_PATTERN =
  /^workspace-v1-[a-f0-9]{64}$/;

export function createMessengerGenerationTenantPartition(
  pageId: string,
  secret: string
): string {
  const digest = createHmac("sha256", secret)
    .update(pageId.trim())
    .digest("hex");
  return `page-v1-${digest}`;
}

export function createMessengerGenerationOwnershipPartition(
  input: {
    workspaceId: number;
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
    pageId: string;
  },
  secret: string
): string {
  const digest = createHmac("sha256", secret)
    .update(String(input.workspaceId))
    .update("\0")
    .update(String(input.channelConnectionId))
    .update("\0")
    .update(String(input.bindingEpoch))
    .update("\0")
    .update(String(input.privacyEpoch))
    .update("\0")
    .update(input.pageId.trim())
    .digest("hex");
  return `workspace-v1-${digest}`;
}

export function isMessengerGenerationTenantPartition(
  value: unknown
): value is string {
  return (
    typeof value === "string" &&
    (MESSENGER_GENERATION_TENANT_PARTITION_PATTERN.test(value) ||
      MESSENGER_GENERATION_OWNERSHIP_PARTITION_PATTERN.test(value))
  );
}

export type MessengerGenerationJob = {
  /** Work type is explicit so a tenant queue cannot route video work through the image worker. */
  operation?: "image" | "video";
  psid: string;
  userId: string;
  /** Facebook Page receiving the message; used only for workspace resolution. */
  pageId?: string;
  /** Immutable enqueue-time owner; required whenever paid enforcement is on. */
  workspaceId?: number;
  /** Immutable enqueue-time Page connection; revalidated before provider use. */
  channelConnectionId?: number;
  /** Monotonic connection generation; token replacement/reconnect bumps it. */
  bindingEpoch?: number;
  /** Monotonic subject generation; erasure invalidates all older work. */
  privacyEpoch?: number;
  /** Immutable content-retention boundary; retries never extend it. */
  createdAt?: number;
  expiresAt?: number;
  /** Opaque Page-derived boundary used only for tenant-partitioned queue storage. */
  tenantPartition?: string;
  generationKind?: GenerationKind;
  reqId: string;
  lang: SupportedUiLang;
  sourceImageUrl?: string;
  sourceImageUrls?: string[];
  promptHint?: string;
  attempts?: number;
};
