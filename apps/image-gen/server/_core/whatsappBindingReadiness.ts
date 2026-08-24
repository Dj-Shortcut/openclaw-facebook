import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import { resolveWhatsAppEndpoint } from "./conversationEndpoint";
import { getEnv } from "./env";
import { unsealFacebookPageToken } from "./facebookConnectStore";

export class WhatsAppBindingReadinessError extends Error {
  constructor() {
    super("WhatsApp tenant binding is not ready");
    this.name = "WhatsAppBindingReadinessError";
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

  try {
    const phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID");
    const expectedWabaId = getEnv("WHATSAPP_BUSINESS_ACCOUNT_ID");
    const expectedAccessToken = getEnv("WHATSAPP_ACCESS_TOKEN");
    const database = await getDatabaseOrThrow();
    const rows = await database
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

    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row?.encryptedAccessToken ||
      !row.phoneNumberId ||
      !row.wabaId ||
      row.wabaId !== expectedWabaId
    ) {
      throw new WhatsAppBindingReadinessError();
    }

    resolveWhatsAppEndpoint({
      wabaId: row.wabaId,
      phoneNumberId: row.phoneNumberId,
    });
    const storedAccessToken = unsealFacebookPageToken(
      row.encryptedAccessToken
    ).trim();
    if (
      !storedAccessToken ||
      !timingSafeEqual(
        credentialDigest(storedAccessToken),
        credentialDigest(expectedAccessToken)
      )
    ) {
      throw new WhatsAppBindingReadinessError();
    }
  } catch (error) {
    if (error instanceof WhatsAppBindingReadinessError) {
      throw error;
    }
    throw new WhatsAppBindingReadinessError();
  }
}
