import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  type ChannelInboundMediaInput,
  buildChannelInboundMediaPayload,
  formatInboundEnvelope,
  hasFinalInboundReplyDispatch,
  resolveInboundSessionEnvelopeContext,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { shouldComputeCommandAuthorized } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { isReplyPayloadNonTerminalToolErrorWarning } from "openclaw/plugin-sdk/reply-payload";
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
  forwardLeaderbotMessengerEvent,
  requestLeaderbotImageGeneration,
  type LeaderbotBridgeTrace,
} from "./leaderbot-bridge.js";
import {
  classifyMessengerFastLaneIntent,
  hasMessengerImageGenerationIntent,
  normalizeFastLaneText,
  resolveMessengerFastLaneReply,
  resolveMessengerSourceImageGenerationPrompt,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldForwardMessengerTextToImageGen,
} from "./messenger-product-intents.js";
import {
  DEFAULT_FACEBOOK_WEBHOOK_PATH,
  FACEBOOK_CHANNEL_ID,
  stripFacebookTargetPrefix,
} from "./naming.js";
import { getMessengerRuntime } from "./runtime.js";
import { sendMessengerSenderAction, sendMessengerText } from "./send.js";
import { validateMessengerSignature } from "./signature.js";
import {
  decodeOpenClawActionPayload,
  getMessengerQuickReplies,
  renderMessengerReplyPayload,
} from "./presentation.js";
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

export {
  DEFAULT_IMAGE_GEN_URL,
  IMAGE_GEN_REQUEST_TIMEOUT_MS,
  forwardLeaderbotMessengerEvent,
  requestLeaderbotImageGeneration,
  resolveImageGenRequestConfig,
  type LeaderbotBridgeTrace,
} from "./leaderbot-bridge.js";

export {
  classifyMessengerFastLaneIntent,
  hasMessengerImageGenerationIntent,
  hasMessengerSourceImageEditIntent,
  resolveMessengerConversationIntent,
  resolveMessengerFastLaneReply,
  resolveMessengerSourceImageGenerationPrompt,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldForwardMessengerTextToImageGen,
  type MessengerConversationIntent,
} from "./messenger-product-intents.js";

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
const MESSENGER_PROMPT_MEMORY_TTL_MS = 30 * 60 * 1000;
const MESSENGER_PROMPT_MEMORY_MAX_ENTRIES = 2_000;
const recentMessengerAssistantPrompts = new Map<string, { prompt: string; expiresAt: number }>();
const recentMessengerAssistantPromptsByMessage = new Map<
  string,
  { prompt: string; expiresAt: number }
>();
const recentMessengerAssistantRepliesByMessage = new Map<
  string,
  { text: string; expiresAt: number }
>();
const recentMessengerAssistantReplies = new Map<string, { text: string; expiresAt: number }>();
const messengerGatewayDailyImageForwardCounts = new Map<
  string,
  { count: number; expiresAt: number }
>();
const messengerGatewayDailyAudioTranscriptionCounts = new Map<
  string,
  { count: number; expiresAt: number }
>();
const messengerGatewayDailyLeaderbotEventForwardCounts = new Map<
  string,
  { count: number; expiresAt: number }
>();
const FACEBOOK_UNTRUSTED_TOOL_DENY = [
  "image_generate",
  "video_generate",
  "music_generate",
  "browser",
  "canvas",
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
  "group:runtime",
  "group:fs",
] as const;
const messengerEventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
let activeMessengerEventJobs = 0;

messengerEventLoopDelay.enable();

type MessengerTrace = LeaderbotBridgeTrace;

export type FacebookInboundToolPolicy = {
  source: "facebook_untrusted_default";
  tools: {
    deny: string[];
  };
};

export type MessengerAudioTranscript = {
  mediaIndex: number;
  text: string;
};

const MESSENGER_IMAGE_FETCH_TIMEOUT_MS = 10_000;
const MESSENGER_IMAGE_FETCH_MAX_BYTES = 10 * 1024 * 1024;
const MESSENGER_MEDIA_FETCH_MAX_BYTES = 25 * 1024 * 1024;
const MESSENGER_MEDIA_FETCH_MAX_REDIRECTS = 2;
const MISSING_REFERENCED_PROMPT_REPLY =
  "Ik vind die prompt niet meer terug. Plak hem even opnieuw, dan maak ik de afbeelding.";
const MESSENGER_GATEWAY_IMAGE_BUDGET_REPLY =
  "Even pauze, ons dagbudget voor afbeeldingen is bereikt. Probeer later opnieuw.";
const MESSENGER_GATEWAY_AUDIO_BUDGET_REPLY =
  "Even pauze, ons dagbudget voor voiceberichten is bereikt. Typ je bericht even uit, dan help ik meteen verder.";
const MESSENGER_GATEWAY_EVENT_FORWARD_BUDGET_REPLY =
  "Even pauze, ons dagbudget is bereikt. Probeer later opnieuw.";

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

function readPositiveIntEnvValue(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function readMessengerGatewayDailyImageForwardCap(): number | null {
  return readPositiveIntEnvValue(process.env.MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP);
}

function readMessengerGatewayDailyAudioTranscriptionCap(): number | null {
  return readPositiveIntEnvValue(process.env.MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP);
}

function readMessengerGatewayDailyLeaderbotEventForwardCap(): number | null {
  return readPositiveIntEnvValue(process.env.MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP);
}

function utcDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcDayTimestamp(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function pruneMessengerGatewayDailyBudgetCounts(now = Date.now()): void {
  for (const counters of [
    messengerGatewayDailyImageForwardCounts,
    messengerGatewayDailyAudioTranscriptionCounts,
    messengerGatewayDailyLeaderbotEventForwardCounts,
  ]) {
    for (const [key, value] of counters) {
      if (value.expiresAt <= now) {
        counters.delete(key);
      }
    }
  }
}

export function resetMessengerGatewayDailyImageForwardBudgetForTests(): void {
  messengerGatewayDailyImageForwardCounts.clear();
  messengerGatewayDailyAudioTranscriptionCounts.clear();
  messengerGatewayDailyLeaderbotEventForwardCounts.clear();
}

function reserveMessengerGatewayDailyBudget(params: {
  accountId: string;
  cap: number | null;
  counters: Map<string, { count: number; expiresAt: number }>;
  now?: number;
}): { ok: true; count: number; cap: number | null } | { ok: false; count: number; cap: number } {
  const cap = params.cap;
  if (!cap) {
    return { ok: true, count: 0, cap: null };
  }

  const now = params.now ?? Date.now();
  pruneMessengerGatewayDailyBudgetCounts(now);
  const key = `${params.accountId}:${utcDayKey(now)}`;
  const current = params.counters.get(key);
  const next = {
    count: (current?.count ?? 0) + 1,
    expiresAt: current?.expiresAt ?? nextUtcDayTimestamp(now),
  };
  params.counters.set(key, next);

  if (next.count > cap) {
    return { ok: false, count: next.count, cap };
  }
  return { ok: true, count: next.count, cap };
}

export function reserveMessengerGatewayDailyImageForwardBudget(params: {
  accountId: string;
  now?: number;
}): { ok: true; count: number; cap: number | null } | { ok: false; count: number; cap: number } {
  return reserveMessengerGatewayDailyBudget({
    accountId: params.accountId,
    cap: readMessengerGatewayDailyImageForwardCap(),
    counters: messengerGatewayDailyImageForwardCounts,
    now: params.now,
  });
}

export function reserveMessengerGatewayDailyAudioTranscriptionBudget(params: {
  accountId: string;
  now?: number;
}): { ok: true; count: number; cap: number | null } | { ok: false; count: number; cap: number } {
  return reserveMessengerGatewayDailyBudget({
    accountId: params.accountId,
    cap: readMessengerGatewayDailyAudioTranscriptionCap(),
    counters: messengerGatewayDailyAudioTranscriptionCounts,
    now: params.now,
  });
}

export function reserveMessengerGatewayDailyLeaderbotEventForwardBudget(params: {
  accountId: string;
  now?: number;
}): { ok: true; count: number; cap: number | null } | { ok: false; count: number; cap: number } {
  return reserveMessengerGatewayDailyBudget({
    accountId: params.accountId,
    cap: readMessengerGatewayDailyLeaderbotEventForwardCap(),
    counters: messengerGatewayDailyLeaderbotEventForwardCounts,
    now: params.now,
  });
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
  messengerEventLoopDelay.reset();
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
  const line = `messenger_trace ${Object.entries(base)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")}`;
  logVerbose(line);
  if (shouldLogMessengerStageToStdout(stage)) {
    console.info(line);
  }
}

function shouldLogMessengerStageToStdout(stage: string): boolean {
  return (
    stage === "webhook_received" ||
    stage === "messenger_ack_sent" ||
    stage === "intent_classified" ||
    stage.startsWith("image_gen_request_") ||
    stage.startsWith("messenger_event_forward_") ||
    stage === "request_completed"
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

export async function downloadMessengerMediaAttachment(params: {
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
    let currentUrl = parsed;
    let response: Response | null = null;
    for (
      let redirectCount = 0;
      redirectCount <= MESSENGER_MEDIA_FETCH_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      response = await fetch(currentUrl, { redirect: "manual", signal: controller.signal });
      if (response.status < 300 || response.status >= 400) {
        break;
      }

      if (redirectCount >= MESSENGER_MEDIA_FETCH_MAX_REDIRECTS) {
        return null;
      }
      const location = response.headers.get("location");
      if (!location) {
        return null;
      }
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== "https:" || !isAllowedMessengerMediaHost(nextUrl.hostname)) {
        return null;
      }
      currentUrl = nextUrl;
    }

    if (!response?.ok) {
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
    return "De gebruiker stuurde een afbeelding zonder duidelijke image-generation opdracht. Bekijk de bijgevoegde afbeelding en antwoord op basis daarvan. Als de gebruiker lijkt te willen bewerken, vraag eerst wat er aangepast moet worden.";
  }
  if (attachments.some((attachment) => attachment.kind === "video")) {
    return "De gebruiker stuurde een video. Bekijk of analyseer de bijgevoegde video als dat beschikbaar is en reageer inhoudelijk.";
  }
  if (attachments.some((attachment) => attachment.kind === "file")) {
    return "De gebruiker stuurde een bestand. Gebruik de bijlage als context als dat beschikbaar is en reageer inhoudelijk.";
  }
  return "De gebruiker stuurde een bijlage. Gebruik de bijlage als context als dat beschikbaar is en reageer inhoudelijk.";
}

export function buildMessengerAgentTextForAttachments(params: {
  text: string;
  attachments: MessengerAttachmentUrl[];
  audioTranscripts?: MessengerAudioTranscript[];
}): string {
  const userText = params.text.trim();
  const transcripts = (params.audioTranscripts ?? [])
    .map((transcript) => transcript.text.trim())
    .filter(Boolean);

  if (transcripts.length > 0) {
    const transcriptText = transcripts
      .map((transcript, index) =>
        transcripts.length === 1
          ? `Transcriptie voicebericht:\n${transcript}`
          : `Transcriptie voicebericht ${index + 1}:\n${transcript}`,
      )
      .join("\n\n");
    return userText ? `${userText}\n\n${transcriptText}` : transcriptText;
  }

  return userText ||
    (params.attachments.length > 0
      ? fallbackTextForMessengerAttachments(params.attachments)
      : "");
}

async function resolveMessengerAudioTranscripts(params: {
  media: ChannelInboundMediaInput[];
  cfg: OpenClawConfig;
  trace: MessengerTrace;
}): Promise<MessengerAudioTranscript[]> {
  const audioMedia = params.media
    .map((entry, mediaIndex) => ({ entry, mediaIndex, path: entry.path }))
    .filter(
      (item): item is { entry: ChannelInboundMediaInput; mediaIndex: number; path: string } =>
        item.entry.kind === "audio" && typeof item.path === "string" && item.path.length > 0,
    );
  if (audioMedia.length === 0) {
    return [];
  }

  const transcripts = await Promise.all(
    audioMedia.map(async ({ entry, mediaIndex, path }) => {
      try {
        const { transcribeAudioFile } =
          await import("openclaw/plugin-sdk/media-understanding-runtime");
        const result = await transcribeAudioFile({
          filePath: path,
          cfg: params.cfg,
          mime: entry.contentType ?? undefined,
        });
        const text = result.text?.trim();
        if (!text) {
          logMessengerStage(params.trace, "audio_transcription_skipped", {
            mediaIndex,
            reason: "empty_transcript",
          });
          return null;
        }
        logMessengerStage(params.trace, "audio_transcribed", {
          mediaIndex,
          chars: text.length,
        });
        return { mediaIndex, text };
      } catch (error) {
        logMessengerStage(params.trace, "audio_transcription_skipped", {
          mediaIndex,
          errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
        });
        return null;
      }
    }),
  );

  return transcripts.filter((entry): entry is MessengerAudioTranscript => entry !== null);
}

function pruneRecentMessengerAssistantPrompts(now: number): void {
  const pruneMap = (entries: Map<string, { expiresAt: number }>) => {
    if (entries.size <= MESSENGER_PROMPT_MEMORY_MAX_ENTRIES) {
      for (const [key, value] of entries) {
        if (value.expiresAt <= now) {
          entries.delete(key);
        }
      }
      return;
    }

    for (const [key, value] of entries) {
      if (value.expiresAt <= now) {
        entries.delete(key);
      }
    }
    for (const key of entries.keys()) {
      if (entries.size <= MESSENGER_PROMPT_MEMORY_MAX_ENTRIES) {
        break;
      }
      entries.delete(key);
    }
  };

  pruneMap(recentMessengerAssistantPrompts);
  pruneMap(recentMessengerAssistantPromptsByMessage);
  pruneMap(recentMessengerAssistantReplies);
  pruneMap(recentMessengerAssistantRepliesByMessage);
}

export function extractImagePromptFromAssistantReply(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || !/\bprompt\b/i.test(trimmed)) {
    return null;
  }

  const fencedMatches = [...trimmed.matchAll(/```(?:text|prompt)?\s*([\s\S]*?)```/gi)];
  const fencedPrompt = fencedMatches
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value && value.length >= 20))
    .at(-1);
  if (fencedPrompt) {
    return fencedPrompt;
  }

  const afterPromptLabel = trimmed.match(/\bprompt\s*[:-]\s*([\s\S]+)/i)?.[1]?.trim();
  if (afterPromptLabel && afterPromptLabel.length >= 20) {
    return afterPromptLabel;
  }

  return null;
}

function messengerPromptMessageKey(senderId: string, messageId: string): string {
  return `${senderId}:${messageId}`;
}

function selectedOptionNumber(text: string): number | null {
  const normalized = normalizeFastLaneText(text);
  const match =
    normalized.match(/^nr\s*(\d+)(?:\s*go)?$/) ??
    normalized.match(/^nummer\s*(\d+)(?:\s*go)?$/) ??
    normalized.match(/^option\s*(\d+)(?:\s*go)?$/) ??
    normalized.match(/^(\d+)(?:\s*go)?$/);
  const value = Number(match?.[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function extractNumberedImageOptionFromAssistantReply(
  assistantText: string,
  userText: string,
): string | null {
  const optionNumber = selectedOptionNumber(userText);
  if (!optionNumber) {
    return null;
  }

  const optionLine = assistantText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => new RegExp(`^${optionNumber}[.)]\\s+`).test(line));
  if (!optionLine) {
    return null;
  }

  const option = optionLine
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[,.]$/g, "")
    .replace(/^(?:of\s+)?(?:een|a|an)\s+/i, "")
    .replace(/\s+maak$/i, "")
    .trim();
  if (!option) {
    return null;
  }
  if (/\b(?:tekstprompt|image prompt|prompt)\b/i.test(option)) {
    return null;
  }

  return /^(?:maak|genereer|create|generate)\b/i.test(option)
    ? option
    : `Maak deze afbeelding: ${option}`;
}

export function rememberMessengerAssistantPrompt(
  senderId: string,
  text: string,
  now = Date.now(),
  messageId?: string,
): void {
  const prompt = extractImagePromptFromAssistantReply(text);
  const expiresAt = now + MESSENGER_PROMPT_MEMORY_TTL_MS;
  const normalizedMessageId = messageId?.trim();
  pruneRecentMessengerAssistantPrompts(now);
  recentMessengerAssistantReplies.set(senderId, { text, expiresAt });
  if (normalizedMessageId) {
    recentMessengerAssistantRepliesByMessage.set(
      messengerPromptMessageKey(senderId, normalizedMessageId),
      { text, expiresAt },
    );
  }
  if (!prompt) {
    return;
  }
  recentMessengerAssistantPrompts.set(senderId, {
    prompt,
    expiresAt,
  });
  if (normalizedMessageId) {
    recentMessengerAssistantPromptsByMessage.set(
      messengerPromptMessageKey(senderId, normalizedMessageId),
      { prompt, expiresAt },
    );
  }
}

function resolveRememberedMessengerAssistantPrompt(
  senderId: string,
  now = Date.now(),
  replyToMessageId?: string,
): string | null {
  pruneRecentMessengerAssistantPrompts(now);
  const normalizedMessageId = replyToMessageId?.trim();
  if (normalizedMessageId) {
    const exact = recentMessengerAssistantPromptsByMessage.get(
      messengerPromptMessageKey(senderId, normalizedMessageId),
    )?.prompt;
    if (exact) {
      return exact;
    }
  }
  return recentMessengerAssistantPrompts.get(senderId)?.prompt ?? null;
}

function resolveMessengerAssistantReplyOptionPrompt(params: {
  senderId: string;
  text: string;
  now?: number;
  replyToMessageId?: string;
}): string | null {
  pruneRecentMessengerAssistantPrompts(params.now ?? Date.now());
  const normalizedMessageId = params.replyToMessageId?.trim();
  if (normalizedMessageId) {
    const exactAssistantReply = recentMessengerAssistantRepliesByMessage.get(
      messengerPromptMessageKey(params.senderId, normalizedMessageId),
    )?.text;
    if (exactAssistantReply) {
      return extractNumberedImageOptionFromAssistantReply(exactAssistantReply, params.text);
    }
  }

  const assistantReply = recentMessengerAssistantReplies.get(params.senderId)?.text;
  return assistantReply
    ? extractNumberedImageOptionFromAssistantReply(assistantReply, params.text)
    : null;
}

function isPromptReferenceImageRequest(text: string): boolean {
  const normalized = normalizeFastLaneText(text);
  return (
    /^(?:gebruik|use)\s+(?:deze|this)\s+prompt\s*(?:en\s+maak\s+(?:een\s+)?(?:afbeelding|foto|plaatje)|to\s+(?:make|create|generate)\s+(?:an?\s+)?(?:image|picture|photo))?\.?$/.test(
      normalized,
    ) ||
    /^(?:maak|genereer|create|generate)\s+(?:deze|dit|this)\s*(?:afbeelding|foto|plaatje|image|picture|photo)?$/.test(
      normalized,
    ) ||
    /^(?:maak|generate|create|go|start|ja|yes|ok|nr\s*\d+\s*go)$/.test(normalized) ||
    selectedOptionNumber(text) !== null
  );
}

function isExplicitPromptReferenceImageRequest(text: string): boolean {
  const normalized = normalizeFastLaneText(text);
  return (
    /^(?:gebruik|use)\s+(?:deze|this)\s+prompt\s*(?:en\s+maak\s+(?:een\s+)?(?:afbeelding|foto|plaatje)|to\s+(?:make|create|generate)\s+(?:an?\s+)?(?:image|picture|photo))?\.?$/.test(
      normalized,
    ) ||
    /^(?:maak|genereer|create|generate)\s+(?:deze|dit|this)\s*(?:afbeelding|foto|plaatje|image|picture|photo)?$/.test(
      normalized,
    )
  );
}

export function resolveMessengerImagePromptFromUserText(params: {
  senderId: string;
  text: string;
  now?: number;
  replyToMessageId?: string;
}): string | null {
  const text = params.text.trim();
  if (isPromptReferenceImageRequest(text)) {
    return (
      resolveMessengerAssistantReplyOptionPrompt(params) ??
      resolveRememberedMessengerAssistantPrompt(
        params.senderId,
        params.now,
        params.replyToMessageId,
      )
    );
  }
  const exactReplyPrompt = params.replyToMessageId
    ? resolveRememberedMessengerAssistantPrompt(
        params.senderId,
        params.now,
        params.replyToMessageId,
      )
    : null;
  if (
    exactReplyPrompt &&
    (isPromptReferenceImageRequest(text) || hasMessengerImageGenerationIntent(text))
  ) {
    return exactReplyPrompt;
  }
  return text;
}

export function shouldDeliverMessengerReplyPayload(
  payload: ReplyPayload,
): payload is ReplyPayload & { text: string } {
  if (!payload.text?.trim()) {
    return false;
  }
  if (
    payload.isReasoning ||
    payload.isCompactionNotice ||
    payload.isFallbackNotice
  ) {
    return false;
  }
  return true;
}

export function resolveFacebookInboundToolPolicy(params: {
  commandAuthorized: boolean;
}): FacebookInboundToolPolicy | null {
  if (params.commandAuthorized) {
    return null;
  }
  return {
    source: "facebook_untrusted_default",
    tools: { deny: [...FACEBOOK_UNTRUSTED_TOOL_DENY] },
  };
}

export function applyFacebookInboundToolPolicyToConfig(
  cfg: OpenClawConfig,
  policy: FacebookInboundToolPolicy | null
): OpenClawConfig {
  if (!policy) {
    return cfg;
  }

  const currentTools = (cfg as { tools?: Record<string, unknown> }).tools ?? {};
  const currentDeny = Array.isArray(currentTools.deny)
    ? currentTools.deny.filter((tool): tool is string => typeof tool === "string")
    : [];

  return {
    ...cfg,
    tools: {
      ...currentTools,
      deny: [...new Set([...currentDeny, ...policy.tools.deny])],
    },
  } as OpenClawConfig;
}

function isMessengerToolFeedbackPayload(payload: ReplyPayload & { text: string }): boolean {
  if (isReplyPayloadNonTerminalToolErrorWarning(payload)) {
    return true;
  }
  return (
    payload.isStatusNotice === true &&
    /\b(?:run|search|open|find|read|write|edit|tool)\b/i.test(payload.text) &&
    /\b(?:failed|error|mislukt)\b/i.test(payload.text)
  );
}

export function normalizeMessengerReplyPayloadForDelivery(
  payload: ReplyPayload,
): (ReplyPayload & { text: string }) | null {
  const renderedPayload = renderMessengerReplyPayload(payload);
  if (!shouldDeliverMessengerReplyPayload(renderedPayload)) {
    return null;
  }
  if (!isMessengerToolFeedbackPayload(renderedPayload)) {
    return renderedPayload;
  }

  return {
    ...renderedPayload,
    text: "Ik kon een interne actie niet uitvoeren. Probeer het zo meteen opnieuw.",
  };
}

async function reserveMessengerGatewayImageForwardOrReply(params: {
  senderId: string;
  cfg: OpenClawConfig;
  accountId: string;
  trace: MessengerTrace;
  route: string;
}): Promise<boolean> {
  const reservation = reserveMessengerGatewayDailyImageForwardBudget({
    accountId: params.accountId,
  });
  if (reservation.ok) {
    return true;
  }

  logMessengerStage(params.trace, "image_gen_request_skipped", {
    reason: "gateway_daily_image_forward_cap",
    route: params.route,
    cap: reservation.cap,
    count: reservation.count,
  });
  await sendMessengerText(params.senderId, MESSENGER_GATEWAY_IMAGE_BUDGET_REPLY, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return false;
}

async function reserveMessengerGatewayAudioTranscriptionOrReply(params: {
  senderId: string;
  cfg: OpenClawConfig;
  accountId: string;
  trace: MessengerTrace;
}): Promise<boolean> {
  const reservation = reserveMessengerGatewayDailyAudioTranscriptionBudget({
    accountId: params.accountId,
  });
  if (reservation.ok) {
    return true;
  }

  logMessengerStage(params.trace, "audio_transcription_skipped", {
    reason: "gateway_daily_audio_transcription_cap",
    cap: reservation.cap,
    count: reservation.count,
  });
  await sendMessengerText(params.senderId, MESSENGER_GATEWAY_AUDIO_BUDGET_REPLY, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return false;
}

async function reserveMessengerGatewayLeaderbotEventForwardOrReply(params: {
  senderId: string;
  cfg: OpenClawConfig;
  accountId: string;
  trace: MessengerTrace;
  route: string;
}): Promise<boolean> {
  const reservation = reserveMessengerGatewayDailyLeaderbotEventForwardBudget({
    accountId: params.accountId,
  });
  if (reservation.ok) {
    return true;
  }

  logMessengerStage(params.trace, "messenger_event_forward_skipped", {
    reason: "gateway_daily_leaderbot_event_forward_cap",
    route: params.route,
    cap: reservation.cap,
    count: reservation.count,
  });
  await sendMessengerText(params.senderId, MESSENGER_GATEWAY_EVENT_FORWARD_BUDGET_REPLY, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return false;
}

function hasMessengerInteractivePayload(event: MessengerWebhookMessaging): boolean {
  return Boolean(event.message?.quick_reply?.payload?.trim() || event.postback?.payload?.trim());
}

export function getOpenClawActionText(event: MessengerWebhookMessaging): string | null {
  return decodeOpenClawActionPayload(
    event.message?.quick_reply?.payload ?? event.postback?.payload,
  );
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
  return targets.find((target) => target.account.pageId === pageId) ?? null;
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
  const core = getMessengerRuntime();
  await createChannelPairingChallengeIssuer({
    channel: FACEBOOK_CHANNEL_ID,
    upsertPairingRequest: async ({ id, meta }) =>
      await core.channel.pairing.upsertPairingRequest({
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

type MessengerIngressDecision = "process" | "leaderbot_free_tier" | "stop";

function isLeaderbotBridgeEnabled(account: ResolvedMessengerAccount): boolean {
  return account.config.leaderbotBridgeEnabled === true;
}

function shouldRouteUnknownSenderToLeaderbotFreeTier(params: {
  account: ResolvedMessengerAccount;
  dmPolicy: string;
  event: MessengerWebhookMessaging;
  senderId: string;
  text: string;
}): boolean {
  return (
    params.dmPolicy === "pairing" &&
    params.senderId.trim().length > 0 &&
    isLeaderbotBridgeEnabled(params.account) &&
    params.account.config.unknownSenderMode === "leaderbot_free_tier" &&
    shouldForwardUnknownSenderEventToLeaderbot(params.event, params.text)
  );
}

function shouldForwardUnknownSenderEventToLeaderbot(
  event: MessengerWebhookMessaging,
  text: string,
): boolean {
  if (classifyMessengerFastLaneIntent(text) === "delete_data") {
    return true;
  }
  if (hasMessengerInteractivePayload(event)) {
    return true;
  }
  const attachments = event.message?.attachments ?? [];
  if (attachments.length > 0) {
    return true;
  }
  return shouldForwardMessengerTextToImageGen(text);
}

async function shouldProcessMessengerEvent(params: {
  event: MessengerWebhookMessaging;
  cfg: OpenClawConfig;
  account: ResolvedMessengerAccount;
  trace?: MessengerTrace;
}): Promise<MessengerIngressDecision> {
  params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "checking" });
  const senderId = params.event.sender?.id ?? "";
  const rawText = params.event.message?.text ?? "";
  const dmPolicy = params.account.config.dmPolicy ?? "pairing";
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
      await getMessengerRuntime().channel.pairing.readAllowFromStore({
        channel: FACEBOOK_CHANNEL_ID,
        accountId: params.account.accountId,
      }),
    subject: { stableId: senderId },
    conversation: {
      kind: "direct",
      id: senderId || "unknown",
    },
    event: { kind: "message" },
    dmPolicy,
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
    return "process";
  }
  if (access.senderAccess.decision === "pairing") {
    if (
      shouldRouteUnknownSenderToLeaderbotFreeTier({
        account: params.account,
        dmPolicy,
        event: params.event,
        senderId,
        text: rawText,
      })
    ) {
      params.trace &&
        logMessengerStage(params.trace, "intent_classified", {
          decision: "leaderbot_free_tier",
        });
      logVerbose(
        `messenger: routing unknown sender ${redactMessengerIdentifier(
          senderId,
        )} to Leaderbot free tier account=${params.account.accountId}`,
      );
      return "leaderbot_free_tier";
    }
    if (
      dmPolicy === "pairing" &&
      senderId.trim().length > 0 &&
      isLeaderbotBridgeEnabled(params.account) &&
      params.account.config.unknownSenderMode === "leaderbot_free_tier"
    ) {
      params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "allow" });
      logVerbose(
        `messenger: routing unknown sender ${redactMessengerIdentifier(
          senderId,
        )} to OpenClaw turn account=${params.account.accountId}`,
      );
      return "process";
    }
    params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "pairing" });
    if (senderId) {
      await sendMessengerPairingReply({ senderId, account: params.account, cfg: params.cfg });
    }
    return "stop";
  }
  params.trace && logMessengerStage(params.trace, "intent_classified", { decision: "blocked" });
  logVerbose(
    `Blocked messenger sender ${redactMessengerIdentifier(senderId)} (dmPolicy: ${
      dmPolicy
    })`,
  );
  return "stop";
}

export async function processMessengerEvent(params: {
  event: MessengerWebhookMessaging;
  cfg: OpenClawConfig;
  account: ResolvedMessengerAccount;
  runtime: RuntimeEnv;
  trace: MessengerTrace;
}) {
  activeMessengerEventJobs += 1;
  try {
    const ingressDecision = await shouldProcessMessengerEvent(params);
    if (ingressDecision === "stop") {
      return;
    }
    const senderId = params.event.sender?.id ?? "";
    const openClawActionText = getOpenClawActionText(params.event);
    const text = openClawActionText ?? params.event.message?.text ?? "";
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
    const rawAttachmentCount = params.event.message?.attachments?.length ?? 0;
    const leaderbotBridgeEnabled = isLeaderbotBridgeEnabled(params.account);
    if (rawAttachmentCount > 0 && attachments.length === 0 && !text.trim()) {
      logMessengerStage(params.trace, "messenger_event_forward_skipped", {
        reason: "attachments_missing_payload_url",
        rawAttachments: rawAttachmentCount,
      });
      logVerbose(
        `messenger: skipped attachment-only event with no usable payload.url sender=${redactMessengerIdentifier(
          senderId,
        )} account=${params.account.accountId} message=${redactMessengerIdentifier(
          params.event.message?.mid ?? `${senderId}:${timestamp}`,
        )} rawAttachments=${rawAttachmentCount}`,
      );
      return;
    }
    if (
      leaderbotBridgeEnabled &&
      classifyMessengerFastLaneIntent(text) === "delete_data"
    ) {
      logMessengerStage(params.trace, "messenger_event_forward_started", {
        reason: "delete_data_request",
      });
      if (
        await forwardLeaderbotMessengerEvent({
          event: params.event,
          trace: params.trace,
          leaderbotBridgeEnabled,
          logStage: logMessengerStage,
        })
      ) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon je verwijderverzoek nu niet automatisch verwerken. Mail privacy@leaderbot.live met je verzoek, dan behandelen we het via de privacyflow.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      );
      return;
    }
    if (ingressDecision === "leaderbot_free_tier") {
      if (
        !(await reserveMessengerGatewayLeaderbotEventForwardOrReply({
          senderId,
          cfg: params.cfg,
          accountId: params.account.accountId,
          trace: params.trace,
          route: "unknown_sender_leaderbot_free_tier",
        }))
      ) {
        return;
      }
      logMessengerStage(params.trace, "messenger_event_forward_started", {
        reason: "unknown_sender_leaderbot_free_tier",
      });
      if (
        await forwardLeaderbotMessengerEvent({
          event: params.event,
          trace: params.trace,
          leaderbotBridgeEnabled,
          logStage: logMessengerStage,
        })
      ) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      ).catch((err: unknown) => {
        params.runtime.error?.(
          danger(`messenger image generator fallback failed: ${String(err)}`),
        );
      });
      return;
    }
    const sourceImageAttachment = attachments.find((attachment) => attachment.kind === "image");
    const replyToMessageId = params.event.message?.reply_to?.mid;
    logVerbose(
      `messenger: received inbound event sender=${redactMessengerIdentifier(
        senderId,
      )} account=${params.account.accountId} message=${redactMessengerIdentifier(
        params.event.message?.mid ?? `${senderId}:${timestamp}`,
      )} media=${attachments.length}`,
    );
    if (!openClawActionText && hasMessengerInteractivePayload(params.event)) {
      logMessengerStage(params.trace, "messenger_interactive_payload_received", {
        quickReply: Boolean(params.event.message?.quick_reply?.payload),
        postback: Boolean(params.event.postback?.payload),
      });
      if (leaderbotBridgeEnabled) {
        if (
          !(await reserveMessengerGatewayLeaderbotEventForwardOrReply({
            senderId,
            cfg: params.cfg,
            accountId: params.account.accountId,
            trace: params.trace,
            route: "interactive_payload",
          }))
        ) {
          return;
        }
        if (
          await forwardLeaderbotMessengerEvent({
            event: params.event,
            trace: params.trace,
            leaderbotBridgeEnabled,
            logStage: logMessengerStage,
          })
        ) {
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
      logMessengerStage(params.trace, "messenger_event_forward_skipped", {
        reason: "disabled_by_config",
        route: "interactive_payload",
      });
      return;
    }
    const sourceImageGenerationPrompt = resolveMessengerSourceImageGenerationPrompt({
      hasSourceImage: Boolean(sourceImageAttachment),
      text,
    });
    if (
      leaderbotBridgeEnabled &&
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: Boolean(sourceImageAttachment),
        text,
      })
    ) {
      if (
        !(await reserveMessengerGatewayImageForwardOrReply({
          senderId,
          cfg: params.cfg,
          accountId: params.account.accountId,
          trace: params.trace,
          route: "source_image_without_prompt",
        }))
      ) {
        return;
      }
      logMessengerStage(params.trace, "messenger_event_forward_started", {
        reason: "source_image_without_prompt",
        sourceImage: true,
      });
      if (
        await forwardLeaderbotMessengerEvent({
          event: params.event,
          trace: params.trace,
          leaderbotBridgeEnabled,
          logStage: logMessengerStage,
        })
      ) {
        return;
      }
    } else if (
      !leaderbotBridgeEnabled &&
      shouldForwardMessengerImageOnlyEventToImageGen({
        hasSourceImage: Boolean(sourceImageAttachment),
        text,
      })
    ) {
      logMessengerStage(params.trace, "messenger_event_forward_skipped", {
        reason: "disabled_by_config",
        route: "source_image_without_prompt",
      });
    }
    if (leaderbotBridgeEnabled && sourceImageAttachment && sourceImageGenerationPrompt) {
      if (
        !(await reserveMessengerGatewayImageForwardOrReply({
          senderId,
          cfg: params.cfg,
          accountId: params.account.accountId,
          trace: params.trace,
          route: "source_image_with_prompt",
        }))
      ) {
        return;
      }
      logMessengerStage(params.trace, "messenger_event_forward_started", {
        reason: "source_image_with_prompt",
        sourceImage: true,
        hasPrompt: true,
      });
      if (
        await forwardLeaderbotMessengerEvent({
          event: params.event,
          trace: params.trace,
          leaderbotBridgeEnabled,
          logStage: logMessengerStage,
        })
      ) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      ).catch((err: unknown) => {
        params.runtime.error?.(
          danger(`messenger image generator fallback failed: ${String(err)}`),
        );
      });
      return;
    } else if (!leaderbotBridgeEnabled && sourceImageAttachment && sourceImageGenerationPrompt) {
      logMessengerStage(params.trace, "messenger_event_forward_skipped", {
        reason: "disabled_by_config",
        route: "source_image_with_prompt",
      });
    }
    if (
      leaderbotBridgeEnabled &&
      attachments.length > 0 &&
      !sourceImageGenerationPrompt &&
      hasMessengerImageGenerationIntent(text)
    ) {
      if (
        !(await reserveMessengerGatewayImageForwardOrReply({
          senderId,
          cfg: params.cfg,
          accountId: params.account.accountId,
          trace: params.trace,
          route: "media_with_image_prompt",
        }))
      ) {
        return;
      }
      logMessengerStage(params.trace, "messenger_event_forward_started", {
        reason: "media_with_image_prompt",
        isSourceImageEdit: false,
        hasPrompt: true,
      });
      if (
        await forwardLeaderbotMessengerEvent({
          event: params.event,
          trace: params.trace,
          leaderbotBridgeEnabled,
          logStage: logMessengerStage,
        })
      ) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      ).catch((err: unknown) => {
        params.runtime.error?.(
          danger(`messenger image generator fallback failed: ${String(err)}`),
        );
      });
      return;
    } else if (
      !leaderbotBridgeEnabled &&
      attachments.length > 0 &&
      !sourceImageGenerationPrompt &&
      hasMessengerImageGenerationIntent(text)
    ) {
      logMessengerStage(params.trace, "messenger_event_forward_skipped", {
        reason: "disabled_by_config",
        route: "media_with_image_prompt",
      });
    }
    const referencedPrompt = resolveMessengerImagePromptFromUserText({
      senderId,
      text,
      replyToMessageId,
    });
    if (
      leaderbotBridgeEnabled &&
      attachments.length === 0 &&
      referencedPrompt &&
      referencedPrompt !== text.trim()
    ) {
      if (
        !(await reserveMessengerGatewayImageForwardOrReply({
          senderId,
          cfg: params.cfg,
          accountId: params.account.accountId,
          trace: params.trace,
          route: "assistant_reference_prompt",
        }))
      ) {
        return;
      }
      logMessengerStage(params.trace, "image_gen_request_started", {
        sourceImage: false,
        hasPrompt: true,
        promptSource: replyToMessageId ? "messenger_reply" : "assistant_reference",
      });
      const queued = await requestLeaderbotImageGeneration({
        psid: senderId,
        prompt: referencedPrompt,
        reqId: params.trace.reqId,
        timestamp,
        trace: params.trace,
        leaderbotBridgeEnabled,
        logStage: logMessengerStage,
      });
      if (queued) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      );
      return;
    } else if (
      !leaderbotBridgeEnabled &&
      attachments.length === 0 &&
      referencedPrompt &&
      referencedPrompt !== text.trim()
    ) {
      logMessengerStage(params.trace, "image_gen_request_skipped", {
        reason: "disabled_by_config",
        promptSource: replyToMessageId ? "messenger_reply" : "assistant_reference",
      });
    }
    if (
      attachments.length === 0 &&
      !referencedPrompt &&
      isExplicitPromptReferenceImageRequest(text)
    ) {
      await sendMessengerText(senderId, MISSING_REFERENCED_PROMPT_REPLY, {
        cfg: params.cfg,
        accountId: params.account.accountId,
      });
      return;
    }
    const hasAudioAttachment = attachments.some((attachment) => attachment.kind === "audio");
    if (
      hasAudioAttachment &&
      !(await reserveMessengerGatewayAudioTranscriptionOrReply({
        senderId,
        cfg: params.cfg,
        accountId: params.account.accountId,
        trace: params.trace,
      }))
    ) {
      return;
    }
    const media = await resolveMessengerMedia({ attachments, trace: params.trace });
    const audioTranscripts = await resolveMessengerAudioTranscripts({
      media,
      cfg: params.cfg,
      trace: params.trace,
    });
    const mediaPayload = buildChannelInboundMediaPayload(
      toInboundMediaFacts(media, { messageId: params.event.message?.mid }),
    );
    const hasMedia = attachments.length > 0;
    if (hasAudioAttachment && !text.trim() && audioTranscripts.length === 0) {
      await sendMessengerText(
        senderId,
        "Ik heb je voicebericht ontvangen, maar ik kan audio nu niet betrouwbaar omzetten naar tekst. Typ je bericht even uit, dan help ik meteen verder.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      );
      logMessengerStage(params.trace, "messenger_response_sent", {
        reason: "audio_transcription_unavailable",
      });
      return;
    }
    const attachmentSummary = describeMessengerAttachments(attachments);
    const textForAgent = buildMessengerAgentTextForAttachments({
      text,
      attachments,
      audioTranscripts,
    });
    const displayBody = [
      text.trim(),
      hasMedia ? `[Messenger attachment: ${attachmentSummary || "bijlage"}]` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (leaderbotBridgeEnabled && !hasMedia && shouldForwardMessengerTextToImageGen(text)) {
      if (
        !(await reserveMessengerGatewayImageForwardOrReply({
          senderId,
          cfg: params.cfg,
          accountId: params.account.accountId,
          trace: params.trace,
          route: "text_image_intent",
        }))
      ) {
        return;
      }
      logMessengerStage(params.trace, "messenger_event_forward_started", {
        reason: "text_image_intent",
        sourceImage: false,
        hasPrompt: true,
      });
      if (
        await forwardLeaderbotMessengerEvent({
          event: params.event,
          trace: params.trace,
          leaderbotBridgeEnabled,
          logStage: logMessengerStage,
        })
      ) {
        return;
      }
      await sendMessengerText(
        senderId,
        "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
        {
          cfg: params.cfg,
          accountId: params.account.accountId,
        },
      );
      return;
    } else if (!leaderbotBridgeEnabled && !hasMedia && shouldForwardMessengerTextToImageGen(text)) {
      logMessengerStage(params.trace, "messenger_event_forward_skipped", {
        reason: "disabled_by_config",
        route: "text_image_intent",
      });
    }
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
      return;
    }
    await sendMessengerSenderAction(senderId, "typing_on", {
      cfg: params.cfg,
      accountId: params.account.accountId,
    }).catch((err: unknown) => {
      params.runtime.error?.(danger(`messenger typing_on failed: ${String(err)}`));
    });
    logMessengerStage(params.trace, "messenger_response_sent", { senderAction: "typing_on" });
  const commandAuthorized = shouldComputeCommandAuthorized(text, params.cfg);
  const facebookToolPolicy = resolveFacebookInboundToolPolicy({ commandAuthorized });
  const inboundCfg = applyFacebookInboundToolPolicyToConfig(
    params.cfg,
    facebookToolPolicy
  );
  const route = resolveAgentRoute({
    cfg: inboundCfg,
    channel: FACEBOOK_CHANNEL_ID,
    accountId: params.account.accountId,
    peer: { kind: "direct", id: senderId },
  });
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: inboundCfg,
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
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: FACEBOOK_CHANNEL_ID,
    OriginatingTo: `facebook:${senderId}`,
    ...(facebookToolPolicy
      ? {
          ToolPolicy: facebookToolPolicy,
          Tools: facebookToolPolicy.tools,
          ToolPolicySource: facebookToolPolicy.source,
        }
      : {}),
    ...mediaPayload,
  });
  const core = getMessengerRuntime();
  logMessengerStage(params.trace, "openclaw_call_started", {
    openclawSessionId: route.sessionKey,
  });
  logVerbose(
    `messenger: dispatching inbound turn session=${route.sessionKey} account=${route.accountId}`,
  );
  const turnResult = await core.channel.inbound.run({
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
        cfg: inboundCfg,
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
          deliver: async (payload: ReplyPayload) => {
            const deliveryPayload = normalizeMessengerReplyPayloadForDelivery(payload);
            if (!deliveryPayload) {
              return { visibleReplySent: false };
            }
            logMessengerStage(params.trace, "first_response_ready", {
              openclawSessionId: route.sessionKey,
            });
            const result = await sendMessengerText(senderId, deliveryPayload.text, {
              cfg: params.cfg,
              accountId: params.account.accountId,
              quickReplies: getMessengerQuickReplies(deliveryPayload),
            });
            rememberMessengerAssistantPrompt(
              senderId,
              deliveryPayload.text,
              Date.now(),
              result.messageId,
            );
            logMessengerStage(params.trace, "messenger_response_sent", {
              message: redactMessengerIdentifier(result.messageId),
            });
            logVerbose(
              `messenger: sent ${deliveryPayload.text.length} char reply to ${redactMessengerIdentifier(
                senderId,
              )} message=${redactMessengerIdentifier(result.messageId)}`,
            );
            return {
              messageIds: [result.messageId],
              receipt: result.receipt,
              visibleReplySent: true,
            };
          },
          onError: (err: unknown, info: { kind: string }) => {
            params.runtime.error?.(danger(`messenger ${info.kind} reply failed: ${String(err)}`));
          },
        },
      }),
    },
  });
  const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
  if (!hasFinalInboundReplyDispatch(dispatchResult)) {
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
