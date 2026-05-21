import { createHash } from "node:crypto";
import {
  formatInboundEnvelope,
  resolveInboundSessionEnvelopeContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { hasFinalChannelTurnDispatch } from "openclaw/plugin-sdk/channel-message";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  danger,
  logVerbose,
  waitForAbortSignal,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizePluginHttpPath,
  registerWebhookTargetWithPluginRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveDefaultMessengerAccountId } from "./accounts.js";
import {
  DEFAULT_FACEBOOK_WEBHOOK_PATH,
  FACEBOOK_CHANNEL_ID,
  stripFacebookTargetPrefix,
} from "./naming.js";
import { getMessengerRuntime } from "./runtime.js";
import { sendMessengerText } from "./send.js";
import { validateMessengerSignature } from "./signature.js";
import type {
  MessengerWebhookBody,
  MessengerWebhookMessaging,
  ResolvedMessengerAccount,
} from "./types.js";
import { extractMessengerTextMessages, handleMessengerWebhookVerification } from "./webhook.js";

export interface MonitorMessengerProviderOptions {
  account: ResolvedMessengerAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
}

export type MessengerWebhookTarget = {
  account: ResolvedMessengerAccount;
  path: string;
  runtime: RuntimeEnv;
};

const messengerWebhookTargets = new Map<string, MessengerWebhookTarget[]>();
const messengerWebhookInFlightLimiter = createWebhookInFlightLimiter();
const MESSENGER_MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const MESSENGER_MESSAGE_DEDUPE_MAX_ENTRIES = 5_000;
const processedMessengerMessageIds = new Map<string, number>();

export function redactMessengerIdentifier(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "unknown";
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

function pruneProcessedMessengerMessageIds(now: number): void {
  if (processedMessengerMessageIds.size <= MESSENGER_MESSAGE_DEDUPE_MAX_ENTRIES) {
    for (const [key, expiresAt] of processedMessengerMessageIds) {
      if (expiresAt <= now) {
        processedMessengerMessageIds.delete(key);
      }
    }
    return;
  }
  for (const [key, expiresAt] of processedMessengerMessageIds) {
    if (
      expiresAt <= now ||
      processedMessengerMessageIds.size > MESSENGER_MESSAGE_DEDUPE_MAX_ENTRIES
    ) {
      processedMessengerMessageIds.delete(key);
    }
  }
}

function logMessengerWebhookRejected(reason: string, path: string): void {
  logVerbose(`messenger webhook rejected: ${reason} path=${path}`);
}

export function shouldProcessMessengerMessageOnce(params: {
  accountId: string;
  senderId: string;
  messageId?: string;
  timestamp?: number;
  now?: number;
}): boolean {
  const stableMessageId =
    normalizeOptionalString(params.messageId) ??
    (params.senderId && params.timestamp ? `${params.senderId}:${params.timestamp}` : undefined);
  if (!stableMessageId) {
    return true;
  }
  const now = params.now ?? Date.now();
  pruneProcessedMessengerMessageIds(now);
  const key = `${params.accountId}:${stableMessageId}`;
  const existingExpiresAt = processedMessengerMessageIds.get(key);
  if (existingExpiresAt && existingExpiresAt > now) {
    return false;
  }
  processedMessengerMessageIds.set(key, now + MESSENGER_MESSAGE_DEDUPE_TTL_MS);
  return true;
}

export function resolveMessengerEventTarget(
  targets: MessengerWebhookTarget[],
  event: MessengerWebhookMessaging,
): MessengerWebhookTarget | null {
  const pageId = event.recipient?.id?.trim();
  if (!pageId) {
    return targets.length === 1 ? (targets[0] ?? null) : null;
  }
  return (
    targets.find((target) => target.account.pageId === pageId) ??
    (targets.length === 1 ? (targets[0] ?? null) : null)
  );
}

export function resolveMessengerVerificationTarget(
  targets: MessengerWebhookTarget[],
  url: URL,
): MessengerWebhookTarget | null {
  if (url.searchParams.get("hub.mode") !== "subscribe") {
    return null;
  }
  const verifyToken = url.searchParams.get("hub.verify_token") ?? "";
  return targets.find((target) => target.account.verifyToken === verifyToken) ?? null;
}

async function sendMessengerPairingReply(params: {
  senderId: string;
  account: ResolvedMessengerAccount;
  cfg: OpenClawConfig;
}) {
  await createChannelPairingChallengeIssuer({
    channel: FACEBOOK_CHANNEL_ID,
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertChannelPairingRequest({
        channel: FACEBOOK_CHANNEL_ID,
        id,
        accountId: params.account.accountId,
        meta,
      }),
  })({
    senderId: params.senderId,
    senderIdLine: `Your Messenger PSID: ${params.senderId}`,
    onCreated: () =>
      logVerbose(`messenger pairing request sender=${redactMessengerIdentifier(params.senderId)}`),
    sendPairingReply: async (text) => {
      await sendMessengerText(params.senderId, text, {
        cfg: params.cfg,
        accountId: params.account.accountId,
      });
    },
  });
}

async function shouldProcessMessengerEvent(params: {
  event: MessengerWebhookMessaging;
  cfg: OpenClawConfig;
  account: ResolvedMessengerAccount;
}) {
  const senderId = params.event.sender?.id ?? "";
  const rawText = params.event.message?.text ?? "";
  const access = await resolveStableChannelMessageIngress({
    channelId: FACEBOOK_CHANNEL_ID,
    accountId: params.account.accountId,
    identity: {
      key: "messenger-psid",
      normalize: stripFacebookTargetPrefix,
      sensitivity: "pii",
      entryIdPrefix: "messenger-entry",
    },
    cfg: params.cfg,
    readStoreAllowFrom: async () =>
      await readChannelAllowFromStore(FACEBOOK_CHANNEL_ID, undefined, params.account.accountId),
    subject: { stableId: senderId },
    conversation: {
      kind: "direct",
      id: senderId || "unknown",
    },
    event: { kind: "message" },
    dmPolicy: params.account.config.dmPolicy ?? "pairing",
    groupPolicy: "disabled",
    policy: {
      activation: {
        requireMention: false,
        allowTextCommands: true,
      },
    },
    allowFrom: (params.account.config.allowFrom ?? []).map((value) => String(value)),
    groupAllowFrom: [],
    command: {
      hasControlCommand: shouldComputeCommandAuthorized(rawText, params.cfg),
      groupOwnerAllowFrom: "none",
    },
  });

  if (access.senderAccess.decision === "allow") {
    logVerbose(
      `messenger: allowed sender ${redactMessengerIdentifier(senderId)} account=${
        params.account.accountId
      }`,
    );
    return true;
  }
  if (access.senderAccess.decision === "pairing") {
    if (senderId) {
      await sendMessengerPairingReply({ senderId, account: params.account, cfg: params.cfg });
    }
    return false;
  }
  logVerbose(
    `Blocked messenger sender ${redactMessengerIdentifier(senderId)} (dmPolicy: ${
      params.account.config.dmPolicy ?? "pairing"
    })`,
  );
  return false;
}

async function processMessengerEvent(params: {
  event: MessengerWebhookMessaging;
  cfg: OpenClawConfig;
  account: ResolvedMessengerAccount;
  runtime: RuntimeEnv;
}) {
  if (!(await shouldProcessMessengerEvent(params))) {
    return;
  }
  const senderId = params.event.sender?.id ?? "";
  const text = params.event.message?.text ?? "";
  const timestamp = params.event.timestamp ?? Date.now();
  logVerbose(
    `messenger: received text event sender=${redactMessengerIdentifier(
      senderId,
    )} account=${params.account.accountId} message=${redactMessengerIdentifier(
      params.event.message?.mid ?? `${senderId}:${timestamp}`,
    )}`,
  );
  if (
    !shouldProcessMessengerMessageOnce({
      accountId: params.account.accountId,
      senderId,
      messageId: params.event.message?.mid,
      timestamp,
    })
  ) {
    logVerbose(
      `messenger: skipped duplicate message ${redactMessengerIdentifier(
        params.event.message?.mid ?? `${senderId}:${timestamp}`,
      )} from ${redactMessengerIdentifier(senderId)}`,
    );
    return;
  }
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: FACEBOOK_CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: senderId },
  });
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Facebook",
    from: `facebook:${senderId}`,
    timestamp,
    body: text,
    chatType: "direct",
    sender: { id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const ctxPayload = finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: `facebook:${senderId}`,
    To: `facebook:${senderId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: `facebook:${senderId}`,
    SenderId: senderId,
    Provider: FACEBOOK_CHANNEL_ID,
    Surface: FACEBOOK_CHANNEL_ID,
    MessageSid: normalizeOptionalString(params.event.message?.mid) ?? `${senderId}:${timestamp}`,
    Timestamp: timestamp,
    CommandAuthorized: shouldComputeCommandAuthorized(text, params.cfg),
    OriginatingChannel: FACEBOOK_CHANNEL_ID,
    OriginatingTo: `facebook:${senderId}`,
  });
  const core = getMessengerRuntime();
  logVerbose(
    `messenger: dispatching inbound turn session=${route.sessionKey} account=${route.accountId}`,
  );
  const turnResult = await core.channel.turn.run({
    channel: FACEBOOK_CHANNEL_ID,
    accountId: route.accountId,
    raw: params.event,
    adapter: {
      ingest: () => ({
        id: ctxPayload.MessageSid ?? `${senderId}:${timestamp}`,
        rawText: text,
      }),
      resolveTurn: () => ({
        cfg: params.cfg,
        channel: FACEBOOK_CHANNEL_ID,
        accountId: route.accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession: core.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher:
          core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        record: {
          updateLastRoute: {
            sessionKey: route.mainSessionKey,
            channel: FACEBOOK_CHANNEL_ID,
            to: senderId,
            accountId: route.accountId,
          },
          onRecordError: (err: unknown) =>
            logVerbose(`messenger: failed updating session meta: ${String(err)}`),
        },
        replyPipeline: {},
        delivery: {
          deliver: async (payload) => {
            if (!payload.text?.trim()) {
              return { visibleReplySent: false };
            }
            const result = await sendMessengerText(senderId, payload.text, {
              cfg: params.cfg,
              accountId: params.account.accountId,
            });
            logVerbose(
              `messenger: sent ${payload.text.length} char reply to ${redactMessengerIdentifier(
                senderId,
              )} message=${redactMessengerIdentifier(result.messageId)}`,
            );
            return {
              messageIds: [result.messageId],
              receipt: result.receipt,
              visibleReplySent: true,
            };
          },
          onError: (err, info) => {
            params.runtime.error?.(danger(`messenger ${info.kind} reply failed: ${String(err)}`));
          },
        },
      }),
    },
  });
  const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
  if (!hasFinalChannelTurnDispatch(dispatchResult)) {
    logVerbose(
      `messenger: no response generated for message from ${redactMessengerIdentifier(senderId)}`,
    );
  } else {
    logVerbose(
      `messenger: completed inbound turn sender=${redactMessengerIdentifier(
        senderId,
      )} account=${route.accountId}`,
    );
  }
}

export async function monitorMessengerProvider(
  opts: MonitorMessengerProviderOptions,
): Promise<{ stop: () => void }> {
  const accountId = opts.account.accountId ?? resolveDefaultMessengerAccountId(opts.config);
  const normalizedPath =
    normalizePluginHttpPath(
      opts.webhookPath ?? opts.account.config.webhookPath,
      DEFAULT_FACEBOOK_WEBHOOK_PATH,
    ) ?? DEFAULT_FACEBOOK_WEBHOOK_PATH;

  const { unregister } = registerWebhookTargetWithPluginRoute({
    targetsByPath: messengerWebhookTargets,
    target: {
      account: opts.account,
      path: normalizedPath,
      runtime: opts.runtime,
    },
    route: {
      auth: "plugin",
      pluginId: FACEBOOK_CHANNEL_ID,
      accountId,
      log: (message) => logVerbose(message),
      handler: async (req, res) => {
        const targets = messengerWebhookTargets.get(normalizedPath) ?? [];
        if (req.method === "GET") {
          const firstTarget = targets[0];
          if (!firstTarget) {
            logMessengerWebhookRejected("no registered target for verification", normalizedPath);
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          const url = new URL(req.url ?? "", "http://localhost");
          const target = resolveMessengerVerificationTarget(targets, url);
          if (!target) {
            logMessengerWebhookRejected("verification token mismatch", normalizedPath);
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          handleMessengerWebhookVerification({
            url,
            verifyToken: target.account.verifyToken,
            res,
            log: (message) => logVerbose(`${message} path=${normalizedPath}`),
          });
          return;
        }
        const requestLifecycle = beginWebhookRequestPipelineOrReject({
          req,
          res,
          allowMethods: ["GET", "POST"],
          inFlightLimiter: messengerWebhookInFlightLimiter,
          inFlightKey: `messenger:${normalizedPath}`,
          requireJsonContentType: true,
        });
        if (!requestLifecycle.ok) {
          logMessengerWebhookRejected("request pipeline rejected", normalizedPath);
          return;
        }
        try {
          const signatureHeader = req.headers["x-hub-signature-256"];
          const signature =
            typeof signatureHeader === "string"
              ? signatureHeader
              : Array.isArray(signatureHeader)
                ? (signatureHeader[0] ?? "")
                : "";
          const raw = await readWebhookBodyOrReject({
            req,
            res,
            profile: "pre-auth",
            invalidBodyMessage: "Invalid webhook body",
          });
          if (!raw.ok) {
            logMessengerWebhookRejected("invalid body", normalizedPath);
            return;
          }
          const matchingTargets = targets.filter((target) =>
            validateMessengerSignature(raw.value, signature, target.account.appSecret),
          );
          if (matchingTargets.length === 0) {
            logMessengerWebhookRejected("invalid signature", normalizedPath);
            res.statusCode = 401;
            res.end("Invalid signature");
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(raw.value);
          } catch {
            logMessengerWebhookRejected("invalid JSON payload", normalizedPath);
            res.statusCode = 400;
            res.end("Invalid webhook payload");
            return;
          }
          const events = extractMessengerTextMessages(body as MessengerWebhookBody);
          logVerbose(
            `messenger webhook accepted: events=${events.length} targets=${matchingTargets.length} path=${normalizedPath}`,
          );
          for (const event of events) {
            const target = resolveMessengerEventTarget(matchingTargets, event);
            if (!target) {
              logVerbose(
                `messenger: skipped event for unmatched page ${redactMessengerIdentifier(
                  event.recipient?.id,
                )} sender=${redactMessengerIdentifier(event.sender?.id)}`,
              );
              continue;
            }
            await processMessengerEvent({
              event,
              cfg: opts.config,
              account: target.account,
              runtime: target.runtime,
            });
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "ok" }));
        } catch (error) {
          opts.runtime.error?.(danger(`messenger webhook error: ${String(error)}`));
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        } finally {
          requestLifecycle.release();
        }
      },
    },
  });

  logVerbose(`messenger: registered webhook handler at ${normalizedPath}`);
  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    unregister();
  };
  if (opts.abortSignal?.aborted) {
    stop();
  } else if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", stop, { once: true });
    await waitForAbortSignal(opts.abortSignal);
  }
  return { stop };
}
