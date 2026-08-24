import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import { resolveWhatsAppEndpoint } from "./conversationEndpoint";
import { getEnv } from "./env";
import { unsealFacebookPageToken } from "./facebookConnectStore";

export type WhatsAppBindingReadinessReason =
  | "configuration_invalid"
  | "database_unavailable"
  | "binding_invalid"
  | "credential_unseal_failed"
  | "credential_mismatch";

export class WhatsAppBindingReadinessError extends Error {
  readonly reason: WhatsAppBindingReadinessReason;

  constructor(reason: WhatsAppBindingReadinessReason, cause?: unknown) {
    super(
      "WhatsApp tenant binding is not ready",
      cause === undefined ? undefined : { cause }
    );
    this.name = "WhatsAppBindingReadinessError";
    this.reason = reason;
  }
}

function credentialDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Production transport is tenant-bound. Legacy global env credentials remain
 * bootstrap inputs only and must not make readiness green by themselves.
 */
export async function assertWhatsAppTenantBindingReadiness(): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  let phoneNumberId: string;
  let expectedAccessToken: string;
  let expectedEndpoint: ReturnType<typeof resolveWhatsAppEndpoint>;
  try {
    phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID");
    const expectedWabaId = getEnv("WHATSAPP_BUSINESS_ACCOUNT_ID");
    expectedAccessToken = getEnv("WHATSAPP_ACCESS_TOKEN");
    expectedEndpoint = resolveWhatsAppEndpoint({
      wabaId: expectedWabaId,
      phoneNumberId,
    });
  } catch (error) {
    throw new WhatsAppBindingReadinessError("configuration_invalid", error);
  }

  let rows: Array<{
    encryptedAccessToken: string | null;
    phoneNumberId: string | null;
    wabaId: string | null;
  }>;
  try {
    const database = await getDatabaseOrThrow();
    rows = await database
      .select({
        encryptedAccessToken: channelConnections.encryptedAccessToken,
        phoneNumberId: channelConnections.externalId,
        wabaId: channelConnections.providerAccountExternalId,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, "whatsapp"),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.externalId, phoneNumberId)
        )
      )
      .limit(2);
  } catch (error) {
    throw new WhatsAppBindingReadinessError("database_unavailable", error);
  }

  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row?.encryptedAccessToken ||
    !row.phoneNumberId ||
    !row.wabaId ||
    row.wabaId !== expectedEndpoint.wabaId
  ) {
    throw new WhatsAppBindingReadinessError("binding_invalid");
  }

  try {
    resolveWhatsAppEndpoint({
      wabaId: row.wabaId,
      phoneNumberId: row.phoneNumberId,
    });
  } catch (error) {
    throw new WhatsAppBindingReadinessError("binding_invalid", error);
  }

  let storedAccessToken: string;
  try {
    storedAccessToken = unsealFacebookPageToken(
      row.encryptedAccessToken
    ).trim();
  } catch (error) {
    throw new WhatsAppBindingReadinessError("credential_unseal_failed", error);
  }
  if (
    !storedAccessToken ||
    !timingSafeEqual(
      credentialDigest(storedAccessToken),
      credentialDigest(expectedAccessToken)
    )
  ) {
    throw new WhatsAppBindingReadinessError("credential_mismatch");
  }
}
