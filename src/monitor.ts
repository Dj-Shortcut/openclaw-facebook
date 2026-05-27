import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  type ChannelInboundMediaInput,
  buildChannelInboundMediaPayload,
  formatInboundEnvelope,
  resolveInboundSessionEnvelopeContext,
  toInboundMediaFacts,
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
import { sendMessengerSenderAction, sendMessengerText } from "./send.js";
import { validateMessengerSignature } from "./signature.js";
import type {
  MessengerWebhookBody,
  MessengerWebhookMessaging,
  ResolvedMessengerAccount,
} from "./types.js";
import {
  type MessengerAttachmentKind,
  type MessengerAttachmentUrl,
  extractMessengerAttachmentUrls,
  extractMessengerInboundMessages,
  handleMessengerWebhookVerification,
} from "./webhook.js";

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
const MESSENGER_SLOW_REQUEST_LOG_MS = 5_000;
const processedMessengerMessageIds = new Map<string, number>();
const messengerEventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
let activeMessengerEventJobs = 0;

messengerEventLoopDelay.enable();

type MessengerTrace = {
  reqId: string;
  psidHash: string;
  accountId: string;
  startedAt: number;
};

type MessengerFastLaneIntent = "greeting" | "help" | "status" | "image";

const DEFAULT_IMAGE_GEN_URL = "https://leaderbot-fb-image-gen.fly.dev";
const IMAGE_GEN_REQUEST_TIMEOUT_MS = 5_000;
const MESSENGER_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const MESSENGER_IMAGE_FETCH_MAX_BYTES = 10 * 1024 * 1024;
const MESSENGER_MEDIA_FETCH_MAX_BYTES = 25 * 1024 * 1024;

export function redactMessengerIdentifier(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "unknown";
  }
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

export function formatUnmatchedMessengerPageLog(event: MessengerWebhookMessaging): string {
  return `messenger: skipped event for unmatched page ${redactMessengerIdentifier(
    event.recipient?.id,
  )} sender=${redactMessengerIdentifier(event.sender?.id)}`;
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

function hashTracePart(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function createMessengerTrace(params: {
  event: MessengerWebhookMessaging;
  accountId: string;
}): MessengerTrace {
  const senderId = params.event.sender?.id;
  const timestamp = params.event.timestamp ?? Date.now();
  const messageKey = params.event.message?.mid ?? `${senderId ?? "unknown"}:${timestamp}`;
  return {
    reqId: `msg_${hashTracePart(messageKey, "unknown")}`,
    psidHash: redactMessengerIdentifier(senderId),
    accountId: params.accountId,
    startedAt: performance.now(),
  };
}

function eventLoopDelayMaxMs(): number {
  const value = messengerEventLoopDelay.max / 1_000_000;
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function logMessengerStage(
  trace: MessengerTrace,
  stage: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  const durationMs = Math.round(performance.now() - trace.startedAt);
  const base: Record<string, string | number | boolean> = {
    reqId: trace.reqId,
    psidHash: trace.psidHash,
    account: trace.accountId,
    stage,
    durationMs,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  if (durationMs >= MESSENGER_SLOW_REQUEST_LOG_MS) {
    base.eventLoopDelayMs = eventLoopDelayMaxMs();
    base.activeMessengerEventJobs = activeMessengerEventJobs;
  }
  logVerbose(
    `messenger_trace ${Object.entries(base)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ")}`,
  );
}

function isAllowedMessengerMediaHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "facebook.com" ||
    normalized.endsWith(".facebook.com") ||
    normalized === "fbcdn.net" ||
    normalized.endsWith(".fbcdn.net") ||
    normalized === "fbsbx.com" ||
    normalized.endsWith(".fbsbx.com")
  );
}

export function sanitizeMessengerSourceImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !isAllowedMessengerMediaHost(parsed.hostname)) {
    return null;
  }
  return parsed.toString();
}

function extensionFromContentType(contentType: string | null, kind: MessengerAttachmentKind): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/aac":
      return ".aac";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "application/pdf":
      return ".pdf";
    default:
      return kind === "audio"
        ? ".audio"
        : kind === "video"
          ? ".video"
          : kind === "file"
            ? ".bin"
            : "";
  }
}

function extensionFromUrl(url: string, kind: MessengerAttachmentKind): string {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    const allowedByKind: Record<MessengerAttachmentKind, string[]> = {
      image: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
      audio: [".mp3", ".m4a", ".aac", ".ogg", ".wav", ".webm"],
      video: [".mp4", ".mov", ".webm", ".m4v"],
      file: [".pdf", ".txt", ".csv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"],
      unknown: [],
    };
    return allowedByKind[kind].includes(ext) ? ext : "";
  } catch {
    return "";
  }
}

function mediaKindForMessengerAttachment(kind: MessengerAttachmentKind): ChannelInboundMediaInput["kind"] {
  switch (kind) {
    case "image":
    case "audio":
    case "video":
      return kind;
    case "file":
      return "document";
    default:
      return "unknown";
  }
}

function contentTypeMatchesMessengerAttachmentKind(
  contentType: string | null,
  kind: MessengerAttachmentKind,
): boolean {
  if (kind === "unknown") {
    return true;
  }
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return true;
  }
  switch (kind) {
    case "image":
      return normalized.startsWith("image/");
    case "audio":
      return normalized.startsWith("audio/") || normalized === "video/mp4";
    case "video":
      return normalized.startsWith("video/");
    case "file":
      return (
        !normalized.startsWith("image/") &&
        !normalized.startsWith("audio/") &&
        !normalized.startsWith("video/")
      );
    default:
      return true;
  }
}

async function downloadMessengerMediaAttachment(params: {
  attachment: MessengerAttachmentUrl;
  reqId: string;
  index: number;
}): Promise<ChannelInboundMediaInput | null> {
  let parsed: URL;
  try {
    parsed = new URL(params.attachment.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !isAllowedMessengerMediaHost(parsed.hostname)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESSENGER_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get("content-type");
    if (!contentTypeMatchesMessengerAttachmentKind(contentType, params.attachment.kind)) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    const maxBytes =
      params.attachment.kind === "image"
        ? MESSENGER_IMAGE_FETCH_MAX_BYTES
        : MESSENGER_MEDIA_FETCH_MAX_BYTES;
    if (contentLength > maxBytes) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maxBytes) {
      return null;
    }

    const mediaDir = join(process.env.OPENCLAW_STATE_DIR?.trim() || "/tmp/openclaw", "media", "inbound");
    await mkdir(mediaDir, { recursive: true });
    const digest = createHash("sha256")
      .update(params.reqId)
      .update(String(params.index))
      .update(buffer)
      .digest("hex")
      .slice(0, 32);
    const ext =
      extensionFromContentType(contentType, params.attachment.kind) ||
      extensionFromUrl(params.attachment.url, params.attachment.kind) ||
      ".bin";
    const path = join(mediaDir, `messenger-${digest}${ext}`);
    await writeFile(path, buffer);
    return {
      path,
      url: params.attachment.url,
      contentType,
      kind: mediaKindForMessengerAttachment(params.attachment.kind),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveMessengerMedia(params: {
  attachments: MessengerAttachmentUrl[];
  trace: MessengerTrace;
}): Promise<ChannelInboundMediaInput[]> {
  const media = await Promise.all(
    params.attachments.map((attachment, index) =>
      downloadMessengerMediaAttachment({ attachment, reqId: params.trace.reqId, index }),
    ),
  );
  const resolved = media.filter((entry): entry is ChannelInboundMediaInput => entry !== null);
  if (params.attachments.length > 0) {
    logMessengerStage(params.trace, "media_resolved", {
      media: params.attachments.length,
      images: params.attachments.filter((attachment) => attachment.kind === "image").length,
      audio: params.attachments.filter((attachment) => attachment.kind === "audio").length,
      video: params.attachments.filter((attachment) => attachment.kind === "video").length,
      files: params.attachments.filter((attachment) => attachment.kind === "file").length,
      downloaded: resolved.length,
    });
  }
  return resolved;
}

function describeMessengerAttachments(attachments: MessengerAttachmentUrl[]): string {
  const counts = new Map<MessengerAttachmentKind, number>();
  for (const attachment of attachments) {
    counts.set(attachment.kind, (counts.get(attachment.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [kind, singular, plural] of [
    ["image", "foto", "foto's"],
    ["audio", "voice/audio", "voice/audio"],
    ["video", "video", "video's"],
    ["file", "bestand", "bestanden"],
    ["unknown", "bijlage", "bijlagen"],
  ] as const) {
    const count = counts.get(kind);
    if (count) {
      parts.push(`${count} ${count === 1 ? singular : plural}`);
    }
  }
  return parts.join(", ");
}

function fallbackTextForMessengerAttachments(attachments: MessengerAttachmentUrl[]): string {
  if (attachments.some((attachment) => attachment.kind === "audio")) {
    return "De gebruiker stuurde een voice/audio-bericht. Luister of transcribeer de bijlage als dat beschikbaar is en reageer inhoudelijk.";
  }
  if (attachments.some((attachment) => attachment.kind === "image")) {
    return "De gebruiker stuurde een afbeelding zonder duidelijke image-generation opdracht. Bekijk de bijgevoegde afbeelding en antwoord op basis daarvan. Als de gebruiker lijkt te willen restylen of bewerken, vraag eerst welke stijl of bewerking gewenst is.";
  }
  if (attachments.some((attachment) => attachment.kind === "video")) {
    return "De gebruiker stuurde een video. Bekijk of analyseer de bijgevoegde video als dat beschikbaar is en reageer inhoudelijk.";
  }
  if (attachments.some((attachment) => attachment.kind === "file")) {
    return "De gebruiker stuurde een bestand. Gebruik de bijlage als context als dat beschikbaar is en reageer inhoudelijk.";
  }
  return "De gebruiker stuurde een bijlage. Gebruik de bijlage als context als dat beschikbaar is en reageer inhoudelijk.";
}

function normalizeFastLaneText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[!?.,;:()[\]{}"'`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyMessengerFastLaneIntent(text: string): MessengerFastLaneIntent | null {
  const normalized = normalizeFastLaneText(text);
  if (!normalized) {
    return null;
  }
  if (/^(hey|hi|hallo|hello|hoi|yo|goedemorgen|goedemiddag|goedenavond)$/.test(normalized)) {
    return "greeting";
  }
  if (
    /^(help|\/help|wat kan je|wat kun je|wat doe je|commands|commando's|mogelijkheden)$/.test(
      normalized,
    )
  ) {
    return "help";
  }
  if (/^(status|ping|ben je online|werkt dit|online)$/.test(normalized)) {
    return "status";
  }
  if (hasMessengerImageGenerationIntent(normalized)) {
    return "image";
  }
  return null;
}

export function hasMessengerImageGenerationIntent(text: string): boolean {
  const normalized = normalizeFastLaneText(text);
  if (isMessengerPromptWritingRequest(normalized)) {
    return false;
  }

  const explicitImageIntent = /\b(restyle|restylen|restijlen|restijl|generate image|create image|maak afbeelding|maak een afbeelding|genereer afbeelding|genereer een afbeelding|maak plaatje|maak een plaatje|bewerk foto|bewerk deze foto|edit image|edit this image)\b/.test(
    normalized,
  );
  if (explicitImageIntent) {
    return true;
  }

  return /^(doe maar|ga maar|ja graag|yes please|ok(e)?|prima|top)$/.test(normalized);
}

function isMessengerPromptWritingRequest(normalizedText: string): boolean {
  return (
    /\b(maak|schrijf|bedenk|genereer|verbeter|formuleer)\s+(?:een|de|mijn)?\s*prompt\b/.test(
      normalizedText,
    ) ||
    /\b(create|write|draft|improve)\s+(?:an?|the|my)?\s*(?:image\s+)?prompt\b/.test(
      normalizedText,
    )
  );
}

export function resolveMessengerSourceImageGenerationPrompt(params: {
  hasSourceImage: boolean;
  text: string;
}): string | null {
  const prompt = params.text.trim();
  if (!params.hasSourceImage || !prompt || !hasMessengerImageGenerationIntent(prompt)) {
    return null;
  }
  return prompt;
}

export function resolveMessengerFastLaneReply(
  text: string,
): { intent: MessengerFastLaneIntent; reply: string } | null {
  const intent = classifyMessengerFastLaneIntent(text);
  switch (intent) {
    case "greeting":
      return {
        intent,
        reply: "Hey! Ik ben er. Stuur je vraag gerust door.",
      };
    case "help":
      return {
        intent,
        reply:
          "Ik kan korte vragen beantwoorden, meedenken met taken en herkennen wanneer je een afbeelding wilt maken. Stuur gewoon wat je nodig hebt.",
      };
    case "status":
      return {
        intent,
        reply: "Online. Messenger is verbonden en ik kan je berichten ontvangen.",
      };
    case "image":
      return {
        intent,
        reply: "Ik stuur je afbeeldingsvraag door naar de image generator. Moment.",
      };
    default:
      return null;
  }
}

function resolveImageGenRequestConfig():
  | { ok: true; endpoint: string; token: string }
  | { ok: false; reason: "missing_token" | "invalid_url" } {
  const token =
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN?.trim() ||
    process.env.INTERNAL_IMAGE_REQUEST_TOKEN?.trim() ||
    "";
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }
  try {
    const baseUrl = new URL(
      process.env.LEADERBOT_IMAGE_GEN_URL?.trim() || DEFAULT_IMAGE_GEN_URL,
    );
    const isLocalhost =
      baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1";
    if (baseUrl.protocol !== "https:" && !isLocalhost) {
      return { ok: false, reason: "invalid_url" };
    }
    const endpoint = new URL("/internal/messenger/image-request", baseUrl);
    return { ok: true, endpoint: endpoint.toString(), token };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

async function requestLeaderbotImageGeneration(params: {
  psid: string;
  prompt: string;
  reqId: string;
  timestamp: number;
  trace: MessengerTrace;
  sourceImageUrl?: string;
}): Promise<boolean> {
  const config = resolveImageGenRequestConfig();
  if (!config.ok) {
    logMessengerStage(params.trace, "image_gen_request_skipped", { reason: config.reason });
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GEN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        psid: params.psid,
        prompt: params.prompt,
        reqId: params.reqId,
        lang: "nl",
        timestamp: params.timestamp,
        sourceImageUrl: params.sourceImageUrl,
      }),
    });
    logMessengerStage(params.trace, "image_gen_request_sent", {
      status: response.status,
    });
    return response.ok;
  } catch (error) {
    logMessengerStage(params.trace, "image_gen_request_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardLeaderbotMessengerEvent(params: {
  event: MessengerWebhookMessaging;
  trace: MessengerTrace;
}): Promise<boolean> {
  const config = resolveImageGenRequestConfig();
  if (!config.ok) {
    logMessengerStage(params.trace, "messenger_event_forward_skipped", { reason: config.reason });
    return false;
  }

  const endpoint = new URL("/internal/messenger/webhook-event", config.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GEN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event: params.event }),
    });
    logMessengerStage(params.trace, "messenger_event_forward_sent", {
      status: response.status,
    });
    return response.ok;
  } catch (error) {
    logMessengerStage(params.trace, "messenger_event_forward_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function hasMessengerInteractivePayload(event: MessengerWebhookMessaging): boolean {
  return Boolean(event.message?.quick_reply?.payload?.trim() || event.postback?.payload?.trim());
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
  trace?: MessengerTrace;
}) {
  params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "checking" });
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
    params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "allow" });
    logVerbose(
      `messenger: allowed sender ${redactMessengerIdentifier(senderId)} account=${
        params.account.accountId
      }`,
    );
    return true;
  }
  if (access.senderAccess.decision === "pairing") {
    params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "pairing" });
    if (senderId) {
      await sendMessengerPairingReply({ senderId, account: params.account, cfg: params.cfg });
    }
    return false;
  }
  params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "blocked" });
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
  trace: MessengerTrace;
}) {
  activeMessengerEventJobs += 1;
  try {
    if (!(await shouldProcessMessengerEvent(params))) {
      return;
    }
    const senderId = params.event.sender?.id ?? "";
    const text = params.event.message?.text ?? "";
    const timestamp = params.event.timestamp ?? Date.now();
    if (
      !shouldProcessMessengerMessageOnce({
        accountId: params.account.accountId,
        senderId,
        messageId: params.event.message?.mid,
        timestamp,
      })
    ) {
      logMessengerStage(params.trace, "duplicate_skipped");
      logVerbose(
        `messenger: skipped duplicate message ${redactMessengerIdentifier(
          params.event.message?.mid ?? `${senderId}:${timestamp}`,
        )} from ${redactMessengerIdentifier(senderId)}`,
      );
      return;
    }
    const attachments = extractMessengerAttachmentUrls(params.event);
    const sourceImageAttachment = attachments.find((attachment) => attachment.kind === "image");
    logVerbose(
      `messenger: received inbound event sender=${redactMessengerIdentifier(
        senderId,
      )} account=${params.account.accountId} message=${redactMessengerIdentifier(
        params.event.message?.mid ?? `${senderId}:${timestamp}`,
      )} media=${attachments.length}`,
    );
    if (hasMessengerInteractivePayload(params.event)) {
      logMessengerStage(params.trace, "messenger_interactive_payload_received", {
        quickReply: Boolean(params.event.message?.quick_reply?.payload),
        postback: Boolean(params.event.postback?.payload),
      });
      if (await forwardLeaderbotMessengerEvent({ event: params.event, trace: params.trace })) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon deze knopactie nu niet verwerken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      ).catch((err: unknown) => {
        params.runtime.error?.(danger(`messenger interactive fallback failed: ${String(err)}`));
      });
      return;
    }
    const sourceImageGenerationPrompt = resolveMessengerSourceImageGenerationPrompt({
      hasSourceImage: Boolean(sourceImageAttachment),
      text,
    });
    if (sourceImageAttachment && sourceImageGenerationPrompt) {
      const sourceImageUrl = sanitizeMessengerSourceImageUrl(sourceImageAttachment.url);
      if (!sourceImageUrl) {
        logMessengerStage(params.trace, "image_gen_request_skipped", {
          reason: "unsafe_source_image_url",
        });
      } else {
        logMessengerStage(params.trace, "image_gen_request_started", {
          sourceImage: true,
          hasPrompt: true,
        });
        const queued = await requestLeaderbotImageGeneration({
          psid: senderId,
          prompt: sourceImageGenerationPrompt,
          reqId: params.trace.reqId,
          timestamp,
          trace: params.trace,
          sourceImageUrl,
        });
        if (queued) {
          return;
        }
        await sendMessengerText(
          senderId,
          "Ik kon de image generator nu niet bereiken. Ik kijk wel even naar je bericht.",
          {
            cfg: params.cfg,
            accountId: params.account.accountId,
          },
        ).catch((err: unknown) => {
          params.runtime.error?.(
            danger(`messenger image generator fallback failed: ${String(err)}`),
          );
        });
      }
    }
    const media = await resolveMessengerMedia({ attachments, trace: params.trace });
    const mediaPayload = buildChannelInboundMediaPayload(
      toInboundMediaFacts(media, { messageId: params.event.message?.mid }),
    );
    const hasMedia = attachments.length > 0;
    const attachmentSummary = describeMessengerAttachments(attachments);
    const textForAgent =
      text.trim() ||
      (hasMedia
        ? fallbackTextForMessengerAttachments(attachments)
        : "");
    const displayBody = [
      text.trim(),
      hasMedia ? `[Messenger attachment: ${attachmentSummary || "bijlage"}]` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const fastLane = hasMedia ? null : resolveMessengerFastLaneReply(text);
    if (fastLane) {
      logMessengerStage(params.trace, "first_response_ready", { intent: fastLane.intent });
      const result = await sendMessengerText(senderId, fastLane.reply, {
        cfg: params.cfg,
        accountId: params.account.accountId,
      });
      logMessengerStage(params.trace, "messenger_response_sent", {
        intent: fastLane.intent,
        message: redactMessengerIdentifier(result.messageId),
      });
      if (fastLane.intent === "image") {
       void requestLeaderbotImageGeneration({
  psid: senderId,
  prompt: text,
  reqId: params.trace.reqId,
  timestamp,
  trace: params.trace,
})
  .then(async (queued) => {
    if (!queued) {
      await sendMessengerText(
        senderId,
        "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      );
    }
  })
  .catch((error: unknown) => {
    params.runtime.error?.(
      danger(`messenger image generation flow failed: ${String(error)}`),
    );
  });
      }
      return;
    }
    await sendMessengerSenderAction(senderId, "typing_on", {
      cfg: params.cfg,
      accountId: params.account.accountId,
    }).catch((err: unknown) => {
      params.runtime.error?.(danger(`messenger typing_on failed: ${String(err)}`));
    });
    logMessengerStage(params.trace, "messenger_response_sent", { senderAction: "typing_on" });
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
    body: displayBody,
    chatType: "direct",
    sender: { id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const ctxPayload = finalizeInboundContext({
    Body: body,
    BodyForAgent: textForAgent,
    RawBody: displayBody,
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
    ...mediaPayload,
  });
  const core = getMessengerRuntime();
  logMessengerStage(params.trace, "openclaw_call_started", {
    openclawSessionId: route.sessionKey,
  });
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
        rawText: displayBody,
        textForAgent,
        textForCommands: text,
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
            logMessengerStage(params.trace, "first_response_ready", {
              openclawSessionId: route.sessionKey,
            });
            const result = await sendMessengerText(senderId, payload.text, {
              cfg: params.cfg,
              accountId: params.account.accountId,
            });
            logMessengerStage(params.trace, "messenger_response_sent", {
              message: redactMessengerIdentifier(result.messageId),
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
    logMessengerStage(params.trace, "openclaw_call_completed", {
      openclawSessionId: route.sessionKey,
    });
    logVerbose(
      `messenger: completed inbound turn sender=${redactMessengerIdentifier(
        senderId,
      )} account=${route.accountId}`,
    );
  }
  } finally {
    logMessengerStage(params.trace, "request_completed", {
      eventLoopDelayMs: eventLoopDelayMaxMs(),
      activeMessengerEventJobs,
    });
    activeMessengerEventJobs = Math.max(0, activeMessengerEventJobs - 1);
  }
}

async function processScheduledMessengerEvents(params: {
  scheduledEvents: Array<{
    event: MessengerWebhookMessaging;
    target: MessengerWebhookTarget;
    trace: MessengerTrace;
  }>;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
}) {
  for (const item of params.scheduledEvents) {
    logMessengerStage(item.trace, "messenger_ack_sent", {
      queuedEvents: params.scheduledEvents.length,
    });
    try {
      await processMessengerEvent({
        event: item.event,
        cfg: params.cfg,
        account: item.target.account,
        runtime: item.target.runtime,
        trace: item.trace,
      });
    } catch (error) {
      params.runtime.error?.(danger(`messenger webhook background error: ${String(error)}`));
    }
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
          const events = extractMessengerInboundMessages(body as MessengerWebhookBody);
          logVerbose(
            `messenger webhook accepted: events=${events.length} targets=${matchingTargets.length} path=${normalizedPath}`,
          );
          const scheduledEvents: Array<{
            event: MessengerWebhookMessaging;
            target: MessengerWebhookTarget;
            trace: MessengerTrace;
          }> = [];
          for (const event of events) {
            const target = resolveMessengerEventTarget(matchingTargets, event);
            if (!target) {
              logVerbose(formatUnmatchedMessengerPageLog(event));
              continue;
            }
            scheduledEvents.push({
              event,
              target,
              trace: createMessengerTrace({ event, accountId: target.account.accountId }),
            });
          }
          for (const item of scheduledEvents) {
            logMessengerStage(item.trace, "webhook_received", {
              queuedEvents: scheduledEvents.length,
            });
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "ok" }));
          void processScheduledMessengerEvents({
            scheduledEvents,
            cfg: opts.config,
            runtime: opts.runtime,
          });
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
