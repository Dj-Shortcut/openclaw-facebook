import * as db from "../db";
import { sendText } from "./messengerApi";
import {
  findStateByUserKey,
  hasOpenPaidHandoffWindow,
  type MessengerUserState,
} from "./messengerState";
import {
  createPortalHandoffToken,
  type PortalHandoffTokenResult,
} from "./portalHandoff";
import { toLogUser } from "./privacy";
import { safeLog } from "./logger";
import { getActiveMessengerPrivacySubjectEpoch } from "./messengerPrivacySubject";

export type SendPortalHandoffInput = {
  workspaceId: number;
  messengerSenderUserKey: string;
  expectedFacebookPageId?: string | null;
  createdByUserId?: number | null;
  baseUrl?: string;
  now?: Date;
  ttlMs?: number;
  deliveryIdempotencyKey?: string | null;
  beforeCapabilityCreate?: () => Promise<boolean>;
  beforeTransport?: () => Promise<boolean>;
  messageVariant?: "onboarding" | "portal_reentry" | "admin_onboarding";
};

export type SendPortalHandoffResult =
  | {
      ok: true;
      sent: true;
      expiresAt: Date;
    }
  | {
      ok: false;
      reason:
        | "messenger_user_not_found"
        | "response_window_closed"
        | "page_binding_unavailable"
        | "send_failed"
        | (string & {});
    };

function getPortalBaseUrl(baseUrl?: string): string {
  const rawBaseUrl =
    baseUrl?.trim() ||
    process.env.PORTAL_BASE_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    "https://leaderbot.live";
  const parsed = new URL(rawBaseUrl);

  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("portal handoff base URL must use HTTPS in production");
  }

  return parsed.origin;
}

export function buildPortalHandoffUrl(token: string, baseUrl?: string): string {
  return new URL(
    `/handoff/${encodeURIComponent(token)}`,
    getPortalBaseUrl(baseUrl)
  ).toString();
}

function buildPortalHandoffMessage(
  handoffUrl: string,
  state: MessengerUserState,
  variant: SendPortalHandoffInput["messageVariant"] = "onboarding"
): string {
  if (variant === "portal_reentry") {
    if (state.preferredLang === "nl") {
      return [
        "Open je Leaderbot-klantenportaal via deze beveiligde link:",
        handoffUrl,
        "Meld je aan met hetzelfde Facebook-account. De link is tijdelijk en werkt maar een keer.",
      ].join("\n\n");
    }

    return [
      "Open your Leaderbot customer portal with this secure link:",
      handoffUrl,
      "Sign in with the same Facebook account. The link is temporary and can only be used once.",
    ].join("\n\n");
  }

  if (variant === "admin_onboarding") {
    if (state.preferredLang === "nl") {
      return [
        "Je Messenger-beheerdersidentiteit is geverifieerd.",
        "Open deze beveiligde link om je Leaderbot-klantenportaal te activeren:",
        handoffUrl,
        "De link verloopt snel en werkt maar een keer. Deel hem met niemand.",
      ].join("\n\n");
    }

    return [
      "Your Messenger administrator identity is verified.",
      "Open this secure link to activate your Leaderbot customer portal:",
      handoffUrl,
      "The link expires soon and only works once. Do not share it.",
    ].join("\n\n");
  }

  if (state.preferredLang === "nl") {
    return [
      "Je premium setup is klaar.",
      "Open deze beveiligde link om je Leaderbot workspace te beheren:",
      handoffUrl,
      "Deze link is tijdelijk en werkt maar een keer.",
    ].join("\n\n");
  }

  return [
    "Your premium setup is ready.",
    "Open this secure link to manage your Leaderbot workspace:",
    handoffUrl,
    "This link is temporary and can only be used once.",
  ].join("\n\n");
}

async function revokeCreatedToken(
  tokenResult: PortalHandoffTokenResult | null
): Promise<void> {
  if (!tokenResult) {
    return;
  }

  await db.revokePortalHandoffToken(tokenResult.tokenHash);
}

async function revokeCreatedTokenSafely(
  tokenResult: PortalHandoffTokenResult | null,
  workspaceId: number,
  logUser: string
): Promise<void> {
  try {
    await revokeCreatedToken(tokenResult);
  } catch (error) {
    safeLog("portal_handoff_revoke_failed", {
      level: "error",
      workspaceId,
      user: logUser,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
  }
}

export async function sendPortalHandoffLink(
  input: SendPortalHandoffInput
): Promise<SendPortalHandoffResult> {
  const expectedPageId = input.expectedFacebookPageId?.trim();
  const logUser = toLogUser(input.messengerSenderUserKey);
  if (!expectedPageId) {
    return { ok: false, reason: "page_binding_unavailable" };
  }
  const connections = await db.listChannelConnections(input.workspaceId);
  const facebookConnection = connections.find(
    connection =>
      connection.channel === "facebook_messenger" &&
      connection.status === "connected" &&
      connection.externalId === expectedPageId
  );
  if (!facebookConnection) {
    return { ok: false, reason: "page_binding_unavailable" };
  }
  const privacyEpoch = await getActiveMessengerPrivacySubjectEpoch({
    workspaceId: input.workspaceId,
    channelConnectionId: facebookConnection.id,
    userKey: input.messengerSenderUserKey,
  });
  if (!privacyEpoch) {
    return { ok: false, reason: "privacy_erased" };
  }
  const stateFence = {
    workspaceId: input.workspaceId,
    channelConnectionId: facebookConnection.id,
    bindingEpoch: facebookConnection.bindingEpoch,
    privacyEpoch,
  };
  const state = await findStateByUserKey(
    input.messengerSenderUserKey,
    expectedPageId,
    stateFence
  );

  if (!state) {
    safeLog("portal_handoff_send_skipped", {
      reason: "messenger_user_not_found",
      workspaceId: input.workspaceId,
      user: logUser,
    });
    return { ok: false, reason: "messenger_user_not_found" };
  }

  const responseWindowOpen = await Promise.resolve(
    hasOpenPaidHandoffWindow(state.psid, undefined, state.pageId, stateFence)
  );
  if (!responseWindowOpen) {
    safeLog("portal_handoff_send_skipped", {
      reason: "response_window_closed",
      workspaceId: input.workspaceId,
      user: logUser,
    });
    return { ok: false, reason: "response_window_closed" };
  }

  const pageId = state.pageId?.trim();
  if (expectedPageId && pageId && expectedPageId !== pageId) {
    safeLog("portal_handoff_send_skipped", {
      reason: "page_binding_unavailable",
      workspaceId: input.workspaceId,
      user: logUser,
    });
    return { ok: false, reason: "page_binding_unavailable" };
  }
  if (!pageId) {
    safeLog("portal_handoff_send_skipped", {
      reason: "page_binding_unavailable",
      workspaceId: input.workspaceId,
      user: logUser,
    });
    return { ok: false, reason: "page_binding_unavailable" };
  }

  let tokenResult: PortalHandoffTokenResult | null = null;
  try {
    if (
      input.beforeCapabilityCreate &&
      !(await input.beforeCapabilityCreate())
    ) {
      return { ok: false, reason: "privacy_erased" };
    }
    tokenResult = await createPortalHandoffToken({
      workspaceId: input.workspaceId,
      facebookPageId: pageId,
      messengerSenderUserKey: input.messengerSenderUserKey,
      createdByUserId: input.createdByUserId ?? null,
      now: input.now,
      ttlMs: input.ttlMs,
      deliveryIdempotencyKey: input.deliveryIdempotencyKey ?? null,
    });
    const handoffUrl = buildPortalHandoffUrl(tokenResult.token, input.baseUrl);
    if (input.beforeTransport && !(await input.beforeTransport())) {
      await revokeCreatedTokenSafely(tokenResult, input.workspaceId, logUser);
      return { ok: false, reason: "privacy_erased" };
    }
    const outcome = await sendText(
      state.psid,
      buildPortalHandoffMessage(handoffUrl, state, input.messageVariant),
      {
        pageId,
        workspaceId: input.workspaceId,
        channelConnectionId: facebookConnection.id,
        bindingEpoch: facebookConnection.bindingEpoch,
        userKey: input.messengerSenderUserKey,
        privacyEpoch,
        operationId:
          input.deliveryIdempotencyKey ?? `portal-handoff:${input.workspaceId}`,
      }
    );

    if (!outcome.sent) {
      await revokeCreatedTokenSafely(tokenResult, input.workspaceId, logUser);
      safeLog("portal_handoff_send_skipped", {
        reason: outcome.reason,
        workspaceId: input.workspaceId,
        user: logUser,
      });
      return { ok: false, reason: outcome.reason };
    }

    safeLog("portal_handoff_sent", {
      workspaceId: input.workspaceId,
      user: logUser,
      expiresAt: tokenResult.expiresAt.toISOString(),
    });

    return {
      ok: true,
      sent: true,
      expiresAt: tokenResult.expiresAt,
    };
  } catch (error) {
    await revokeCreatedTokenSafely(tokenResult, input.workspaceId, logUser);
    safeLog("portal_handoff_send_failed", {
      level: "error",
      workspaceId: input.workspaceId,
      user: logUser,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return { ok: false, reason: "send_failed" };
  }
}
