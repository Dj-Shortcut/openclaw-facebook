import * as db from "../db";
import { sendText } from "./messengerApi";
import {
  findStateByUserKey,
  hasOpenMessengerResponseWindow,
  type MessengerUserState,
} from "./messengerState";
import {
  createPortalHandoffToken,
  type PortalHandoffTokenResult,
} from "./portalHandoff";
import { toLogUser } from "./privacy";
import { safeLog } from "./logger";

export type SendPortalHandoffInput = {
  workspaceId: number;
  messengerSenderUserKey: string;
  createdByUserId?: number | null;
  baseUrl?: string;
  now?: Date;
  ttlMs?: number;
};

export type SendPortalHandoffResult =
  | {
      ok: true;
      sent: true;
      expiresAt: Date;
    }
  | {
      ok: false;
      reason: "messenger_user_not_found" | "response_window_closed" | "send_failed";
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
  state: MessengerUserState
): string {
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

export async function sendPortalHandoffLink(
  input: SendPortalHandoffInput
): Promise<SendPortalHandoffResult> {
  const state = await findStateByUserKey(input.messengerSenderUserKey);
  const logUser = toLogUser(input.messengerSenderUserKey);

  if (!state) {
    safeLog("portal_handoff_send_skipped", {
      reason: "messenger_user_not_found",
      workspaceId: input.workspaceId,
      user: logUser,
    });
    return { ok: false, reason: "messenger_user_not_found" };
  }

  const responseWindowOpen = await Promise.resolve(
    hasOpenMessengerResponseWindow(state.psid)
  );
  if (!responseWindowOpen) {
    safeLog("portal_handoff_send_skipped", {
      reason: "response_window_closed",
      workspaceId: input.workspaceId,
      user: logUser,
    });
    return { ok: false, reason: "response_window_closed" };
  }

  let tokenResult: PortalHandoffTokenResult | null = null;
  try {
    tokenResult = await createPortalHandoffToken({
      workspaceId: input.workspaceId,
      messengerSenderUserKey: input.messengerSenderUserKey,
      createdByUserId: input.createdByUserId ?? null,
      now: input.now,
      ttlMs: input.ttlMs,
    });
    const handoffUrl = buildPortalHandoffUrl(tokenResult.token, input.baseUrl);
    const outcome = await sendText(
      state.psid,
      buildPortalHandoffMessage(handoffUrl, state)
    );

    if (!outcome.sent) {
      await revokeCreatedToken(tokenResult);
      safeLog("portal_handoff_send_skipped", {
        reason: outcome.reason,
        workspaceId: input.workspaceId,
        user: logUser,
      });
      return { ok: false, reason: "response_window_closed" };
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
    await revokeCreatedToken(tokenResult);
    safeLog("portal_handoff_send_failed", {
      level: "error",
      workspaceId: input.workspaceId,
      user: logUser,
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return { ok: false, reason: "send_failed" };
  }
}
