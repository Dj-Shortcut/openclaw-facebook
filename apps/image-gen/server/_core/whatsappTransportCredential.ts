import { and, eq } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import { resolveWhatsAppEndpoint } from "./conversationEndpoint";
import { getEnv } from "./env";
import { unsealFacebookPageToken } from "./facebookConnectStore";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  getMessengerRequestChannel,
  isMessengerErasureControlDelivery,
} from "./messengerRequestContext";
import {
  assertMessengerErasureControlDelivery,
  assertMessengerPrivacySubject,
} from "./messengerPrivacySubject";

export class WhatsAppTransportBindingError extends Error {
  constructor() {
    super("WhatsApp transport binding is unavailable");
    this.name = "WhatsAppTransportBindingError";
  }
}

export type WhatsAppTransportCredential = Readonly<{
  accessToken: string;
  phoneNumberId: string | null;
  userKey: string | null;
}>;

/**
 * Resolve a credential only from the immutable inbound ownership tuple.
 * The v1 channel credential envelope is shared with Messenger; the historical
 * Facebook-named unseal function remains byte-compatible with stored WhatsApp
 * channelConnections credentials.
 */
export async function resolveWhatsAppTransportCredential(): Promise<WhatsAppTransportCredential> {
  try {
    return await resolveWhatsAppTransportCredentialInternal();
  } catch (error) {
    if (error instanceof WhatsAppTransportBindingError) {
      throw error;
    }
    throw new WhatsAppTransportBindingError();
  }
}

async function resolveWhatsAppTransportCredentialInternal(): Promise<WhatsAppTransportCredential> {
  const phoneNumberId = getMessengerRequestPageId();
  const requestChannel = getMessengerRequestChannel();
  const ownership = getMessengerRequestOwnership();
  const privacySubject = getMessengerRequestPrivacySubject();
  const hasAnyRequestScope = Boolean(
    phoneNumberId || ownership || privacySubject
  );

  if (
    !phoneNumberId ||
    !ownership ||
    requestChannel !== "whatsapp" ||
    !privacySubject
  ) {
    if (process.env.NODE_ENV === "production" || hasAnyRequestScope) {
      throw new WhatsAppTransportBindingError();
    }
    return resolveLocalLegacyCredential();
  }

  const assertPrivacy = isMessengerErasureControlDelivery()
    ? assertMessengerErasureControlDelivery
    : assertMessengerPrivacySubject;
  await assertPrivacy({
    workspaceId: ownership.workspaceId,
    channelConnectionId: ownership.channelConnectionId,
    userKey: privacySubject.userKey,
    privacyEpoch: privacySubject.privacyEpoch,
  });

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
        eq(channelConnections.id, ownership.channelConnectionId),
        eq(channelConnections.workspaceId, ownership.workspaceId),
        eq(channelConnections.channel, "whatsapp"),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.externalId, phoneNumberId),
        eq(channelConnections.bindingEpoch, ownership.bindingEpoch)
      )
    )
    .limit(2);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row?.encryptedAccessToken ||
    !row.phoneNumberId ||
    !row.wabaId
  ) {
    throw new WhatsAppTransportBindingError();
  }

  resolveWhatsAppEndpoint({
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
  });
  const accessToken = unsealFacebookPageToken(row.encryptedAccessToken).trim();
  if (!accessToken) {
    throw new WhatsAppTransportBindingError();
  }

  return Object.freeze({
    accessToken,
    phoneNumberId: row.phoneNumberId,
    userKey: privacySubject.userKey,
  });
}

function resolveLocalLegacyCredential(): WhatsAppTransportCredential {
  return Object.freeze({
    accessToken: getEnv("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || null,
    userKey: null,
  });
}
