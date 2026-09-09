import { createHash, timingSafeEqual } from "node:crypto";
import { hasOpenMessengerResponseWindow } from "./messengerState";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { safeLog } from "./logger";
import { getConnectedFacebookPageConnection } from "../db";
import { unsealFacebookPageToken } from "./facebookPageToken";
import {
  getMessengerRequestOwnership,
  getMessengerRequestOperationId,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  isMessengerErasureControlDelivery,
} from "./messengerRequestContext";
import {
  assertMessengerErasureControlDelivery,
  assertMessengerPrivacySubject,
} from "./messengerPrivacySubject";
import { toUserKey } from "./privacy";
import {
  claimMessengerProviderAttemptFence,
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
export { safeLog } from "./logger";

const GRAPH_API_VERSION = "v21.0";
const DEFAULT_GRAPH_API_REQUEST_TIMEOUT_MS = 30_000;
const MAX_GRAPH_API_REQUEST_TIMEOUT_MS = 120_000;

class MessengerGraphRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Messenger Graph request timed out after ${timeoutMs}ms`);
    this.name = "MessengerGraphRequestTimeoutError";
  }
}

type MessengerGraphResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
};

type QuickReply = {
  content_type: "text";
  title: string;
  payload: string;
};

type WebUrlButton = {
  type: "web_url";
  title: string;
  url: string;
  webview_height_ratio?: "compact" | "tall" | "full";
};

type PostbackButton = {
  type: "postback";
  title: string;
  payload: string;
};

type MessengerButton = WebUrlButton | PostbackButton;

type MessengerSendOutcome =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "response_window_closed" };

type SendMessageOptions = {
  pageId?: string | null;
  workspaceId?: number | null;
  channelConnectionId?: number | null;
  bindingEpoch?: number | null;
  userKey?: string | null;
  privacyEpoch?: number | null;
  operationId?: string;
  providerAttemptKey?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void;
  onFinalFailure?: (
    attempts: number,
    maxAttempts: number,
    error: Error
  ) => void;
};

function resolveDeliveryPrivacy(options?: SendMessageOptions) {
  const ownership =
    options?.workspaceId != null &&
    options.channelConnectionId != null &&
    options.bindingEpoch != null
      ? {
          workspaceId: options.workspaceId,
          channelConnectionId: options.channelConnectionId,
          bindingEpoch: options.bindingEpoch,
        }
      : getMessengerRequestOwnership();
  const subject =
    options?.userKey && options.privacyEpoch
      ? { userKey: options.userKey, privacyEpoch: options.privacyEpoch }
      : getMessengerRequestPrivacySubject();
  return ownership && subject ? { ...ownership, ...subject } : null;
}

async function assertDeliveryPrivacy(
  options?: SendMessageOptions
): Promise<void> {
  const fence = resolveDeliveryPrivacy(options);
  if (!fence) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger privacy delivery fence is required");
    }
    return;
  }
  const assertPrivacy = isMessengerErasureControlDelivery()
    ? assertMessengerErasureControlDelivery
    : assertMessengerPrivacySubject;
  await assertPrivacy({
    workspaceId: fence.workspaceId,
    channelConnectionId: fence.channelConnectionId,
    userKey: fence.userKey,
    privacyEpoch: fence.privacyEpoch,
  });
}

type ResolvedRetryOptions = {
  maxRetries: number;
  retryBaseMs: number;
  maxAttempts: number;
};

function getPageToken(): string {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!token) {
    throw new Error("FB_PAGE_ACCESS_TOKEN is missing");
  }

  return token;
}

function getSendApiUrl(): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`;
}

async function resolvePageToken(options?: SendMessageOptions): Promise<string> {
  const explicitPageId = options?.pageId?.trim();
  const requestPageId = getMessengerRequestPageId();
  if (explicitPageId && requestPageId && explicitPageId !== requestPageId) {
    throw new Error(
      "Messenger Page context does not match explicit delivery Page"
    );
  }
  const pageId = explicitPageId || requestPageId;
  const requestOwnership = getMessengerRequestOwnership();
  if (!pageId) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Messenger Page context is required for production delivery"
      );
    }
    return getPageToken();
  }

  const effectiveOwnership =
    options?.workspaceId != null &&
    options.channelConnectionId != null &&
    options.bindingEpoch != null
      ? {
          workspaceId: options.workspaceId,
          channelConnectionId: options.channelConnectionId,
          bindingEpoch: options.bindingEpoch,
        }
      : requestOwnership;
  const hasAnyOwnership =
    options?.workspaceId != null ||
    options?.channelConnectionId != null ||
    options?.bindingEpoch != null;
  const hasCompleteOwnership =
    options?.workspaceId != null &&
    options?.channelConnectionId != null &&
    options?.bindingEpoch != null;
  if (hasAnyOwnership && !hasCompleteOwnership) {
    throw new Error("Messenger Page credential ownership is incomplete");
  }
  if (process.env.NODE_ENV === "production" && !effectiveOwnership) {
    throw new Error("Messenger delivery ownership is required in production");
  }
  const connection = await getConnectedFacebookPageConnection(
    pageId,
    effectiveOwnership
  );
  if (!connection || !connection.encryptedAccessToken) {
    throw new Error("Messenger Page credential binding is unavailable");
  }
  return unsealFacebookPageToken(connection.encryptedAccessToken);
}

function parsePositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error instanceof MessengerGraphRequestTimeoutError ||
    error instanceof TypeError
  );
}

function getRetryAfterMs(response: MessengerGraphResponse): number | null {
  const header = response.headers.get("retry-after");
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  return null;
}

function getGraphApiRequestTimeoutMs(): number {
  const configured = Number(process.env.GRAPH_API_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_GRAPH_API_REQUEST_TIMEOUT_MS;
  }
  return Math.min(Math.floor(configured), MAX_GRAPH_API_REQUEST_TIMEOUT_MS);
}

async function runMessengerGraphRequest(
  request: (signal: AbortSignal) => Promise<MessengerGraphResponse>
): Promise<MessengerGraphResponse> {
  const timeoutMs = getGraphApiRequestTimeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new MessengerGraphRequestTimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function resolveRetryOptions(
  options?: SendMessageOptions
): ResolvedRetryOptions {
  const maxRetries =
    options?.maxRetries ?? parsePositiveInt("GRAPH_API_MAX_RETRIES", 3);
  const retryBaseMs =
    options?.retryBaseMs ?? parsePositiveInt("GRAPH_API_RETRY_BASE_MS", 300);

  return {
    maxRetries,
    retryBaseMs,
    maxAttempts: maxRetries + 1,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function markMessengerDeliveryAmbiguous(error: unknown): Error {
  const ambiguousError = toError(error);
  Object.defineProperty(ambiguousError, "messengerDeliveryAmbiguous", {
    value: true,
  });
  return ambiguousError;
}

async function postMessengerMessage(
  psid: string,
  message: Record<string, unknown>,
  options?: SendMessageOptions
): Promise<
  | {
      kind: "response";
      response: MessengerGraphResponse;
      fence: MessengerProviderAttemptFence | null;
    }
  | { kind: "already_succeeded" }
> {
  const deliveryFence = resolveDeliveryPrivacy(options);
  const pageId = options?.pageId?.trim() || getMessengerRequestPageId();
  let fence: MessengerProviderAttemptFence | null = null;
  let started = false;
  let providerStartAttempted = false;
  try {
    const operationId =
      options?.operationId ?? getMessengerRequestOperationId();
    if (deliveryFence && pageId && operationId) {
      const messageDigest = createHash("sha256")
        .update(JSON.stringify(message))
        .digest("hex");
      const providerAttemptKey =
        options?.providerAttemptKey?.trim() || messageDigest;
      const job: MessengerGenerationJob = {
        psid,
        userId: deliveryFence.userKey,
        reqId: createHash("sha256")
          .update(operationId)
          .update("\0")
          .update(providerAttemptKey)
          .digest("hex"),
        lang: "en",
        pageId,
        workspaceId: deliveryFence.workspaceId,
        channelConnectionId: deliveryFence.channelConnectionId,
        bindingEpoch: deliveryFence.bindingEpoch,
        privacyEpoch: deliveryFence.privacyEpoch,
      };
      const claim = await claimMessengerProviderAttemptFence(
        job,
        "messenger-graph-send",
        1,
        new Date(),
        { takeOverReserved: true }
      );
      if (claim.kind === "owned") {
        fence = claim.fence;
      } else if (
        claim.kind === "unsafe_or_done" &&
        claim.status === "succeeded"
      ) {
        return { kind: "already_succeeded" };
      } else if (claim.kind === "unsafe_or_done") {
        throw markMessengerDeliveryAmbiguous(
          new Error(`Messenger provider attempt is ${claim.status}`)
        );
      } else if (claim.kind === "busy") {
        throw new Error(
          `Messenger provider attempt is reserved until ${claim.retryAt.toISOString()}`
        );
      } else {
        throw new Error(`Messenger provider attempt is ${claim.status}`);
      }
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger transport operation identity is required");
    }
    const pageToken = await resolvePageToken(options);
    await assertDeliveryPrivacy(options);
    if (fence) {
      providerStartAttempted = true;
      await markMessengerProviderAttemptStarted(fence);
      started = true;
    }
    const response = await runMessengerGraphRequest(async signal => {
      const graphResponse = await fetch(getSendApiUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pageToken}`,
        },
        body: JSON.stringify({
          messaging_type: "RESPONSE",
          recipient: { id: psid },
          message,
        }),
        signal,
      });
      const contentType = graphResponse.headers.get("content-type") ?? "";
      return {
        ok: graphResponse.ok,
        status: graphResponse.status,
        statusText: graphResponse.statusText,
        headers: graphResponse.headers,
        body:
          !graphResponse.ok || contentType.includes("application/json")
            ? await graphResponse.text()
            : "",
      };
    });
    return { kind: "response", response, fence };
  } catch (error) {
    let finalizationError: unknown;
    if (fence) {
      try {
        if (started) {
          await finalizeMessengerProviderAttemptFence(fence, "ambiguous");
        } else if (!providerStartAttempted) {
          await finalizeMessengerProviderAttemptFence(fence, "known_failed");
        }
      } catch (caught) {
        finalizationError = caught;
      }
    }
    const deliveryError = finalizationError ?? error;
    // A failed mark-start call has not crossed this process's fetch boundary.
    // Leave the DB row untouched and let a retry inspect/take over `reserved`,
    // or contain `started`; do not prematurely send an ambiguous-image notice.
    throw started
      ? markMessengerDeliveryAmbiguous(deliveryError)
      : deliveryError;
  }
}

async function waitBeforeRetry(
  attempt: number,
  retryBaseMs: number,
  response?: MessengerGraphResponse
): Promise<void> {
  const retryAfterMs = response ? getRetryAfterMs(response) : null;
  const exponentialBackoffMs = retryBaseMs * 2 ** attempt;
  await delay(retryAfterMs ?? exponentialBackoffMs);
}

async function handleNetworkFailure(input: {
  error: unknown;
  attempt: number;
  retry: ResolvedRetryOptions;
  options?: SendMessageOptions;
}): Promise<boolean> {
  const retryError = toError(input.error);
  const canRetry =
    input.attempt < input.retry.maxRetries &&
    isTransientNetworkError(input.error);

  if (!canRetry) {
    input.options?.onFinalFailure?.(
      input.attempt + 1,
      input.retry.maxAttempts,
      retryError
    );
    throw input.error;
  }

  input.options?.onRetry?.(
    input.attempt + 1,
    input.retry.maxAttempts,
    retryError
  );
  await waitBeforeRetry(input.attempt, input.retry.retryBaseMs);
  return true;
}

async function handleErrorResponse(input: {
  response: MessengerGraphResponse;
  attempt: number;
  retry: ResolvedRetryOptions;
  options?: SendMessageOptions;
}): Promise<void> {
  const error = new Error(
    `Messenger API error ${input.response.status}: ${input.response.body}`
  );
  const canRetry =
    input.attempt < input.retry.maxRetries &&
    shouldRetry(input.response.status);

  if (!canRetry) {
    input.options?.onFinalFailure?.(
      input.attempt + 1,
      input.retry.maxAttempts,
      error
    );
    throw error;
  }

  input.options?.onRetry?.(input.attempt + 1, input.retry.maxAttempts, error);
  await waitBeforeRetry(input.attempt, input.retry.retryBaseMs, input.response);
}

async function sendMessage(
  psid: string,
  message: Record<string, unknown>,
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  const deliveryFence = resolveDeliveryPrivacy(options);
  if (deliveryFence) {
    const actualUserKey = Buffer.from(toUserKey(psid), "utf8");
    const expectedUserKey = Buffer.from(deliveryFence.userKey, "utf8");
    if (
      actualUserKey.length !== expectedUserKey.length ||
      !timingSafeEqual(actualUserKey, expectedUserKey)
    ) {
      throw new Error("Messenger recipient does not match privacy subject");
    }
  }
  await assertDeliveryPrivacy(options);
  const explicitPageId = options?.pageId?.trim();
  const requestPageId = getMessengerRequestPageId();
  if (explicitPageId && requestPageId && explicitPageId !== requestPageId) {
    throw new Error(
      "Messenger Page context does not match explicit delivery Page"
    );
  }
  const withinResponseWindow = await Promise.resolve(
    hasOpenMessengerResponseWindow(
      psid,
      undefined,
      options?.pageId,
      deliveryFence ?? undefined
    )
  );
  if (!withinResponseWindow) {
    safeLog("messenger_send_skipped", { reason: "response_window_closed" });
    return { sent: false, reason: "response_window_closed" };
  }

  const retry = resolveRetryOptions(options);

  for (let attempt = 0; attempt <= retry.maxRetries; attempt += 1) {
    let response: MessengerGraphResponse;
    let providerFence: MessengerProviderAttemptFence | null = null;
    try {
      const posted = await postMessengerMessage(psid, message, options);
      if (posted.kind === "already_succeeded") {
        return { sent: true };
      }
      response = posted.response;
      providerFence = posted.fence;
    } catch (error) {
      if (
        error instanceof Error &&
        (error as Error & { messengerDeliveryAmbiguous?: boolean })
          .messengerDeliveryAmbiguous
      ) {
        throw error;
      }
      await handleNetworkFailure({ error, attempt, retry, options });
      continue;
    }

    if (response.ok) {
      if (providerFence) {
        try {
          await finalizeMessengerProviderAttemptFence(
            providerFence,
            "succeeded"
          );
        } catch (error) {
          // Meta already accepted this transport. Losing only our durable
          // provider marker must never make a higher layer resend the image.
          throw markMessengerDeliveryAmbiguous(error);
        }
      }
      return parseSendOutcome(response);
    }

    if (providerFence) {
      const safeRetry = response.status === 425 || response.status === 429;
      await finalizeMessengerProviderAttemptFence(
        providerFence,
        safeRetry || (response.status < 500 && response.status !== 408)
          ? "known_failed"
          : "ambiguous"
      );
      if (!safeRetry && (response.status >= 500 || response.status === 408)) {
        throw markMessengerDeliveryAmbiguous(
          new Error(`Messenger API ambiguous error ${response.status}`)
        );
      }
    }

    await handleErrorResponse({ response, attempt, retry, options });
  }

  throw new Error("Messenger API error: retry loop exited unexpectedly");
}

function parseSendOutcome(
  response: MessengerGraphResponse
): MessengerSendOutcome {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { sent: true };
  }

  try {
    const body = JSON.parse(response.body) as { message_id?: unknown };
    return typeof body.message_id === "string" && body.message_id.trim()
      ? { sent: true, messageId: body.message_id.trim() }
      : { sent: true };
  } catch {
    return { sent: true };
  }
}

export async function sendText(
  psid: string,
  text: string,
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  return await sendMessage(psid, { text }, options);
}

export async function sendQuickReplies(
  psid: string,
  text: string,
  replies: QuickReply[],
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  return await sendMessage(
    psid,
    {
      text,
      quick_replies: replies,
    },
    options
  );
}

const MESSENGER_BUTTON_TEMPLATE_TEXT_MAX_LENGTH = 640;

function normalizeButtonTemplateText(text: string): string {
  return Array.from(text)
    .slice(0, MESSENGER_BUTTON_TEMPLATE_TEXT_MAX_LENGTH)
    .join("");
}

export async function sendButtonTemplate(
  psid: string,
  text: string,
  buttons: MessengerButton[],
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  return await sendMessage(
    psid,
    {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: normalizeButtonTemplateText(text),
          buttons,
        },
      },
    },
    options
  );
}

export async function sendImage(
  psid: string,
  imageUrl: string,
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  const imageUrlSummary = summarizeSensitiveUrl(imageUrl);
  const startedAt = Date.now();
  safeLog("messenger_image_send_started", { imageUrl: imageUrlSummary });

  const outcome = await sendMessage(
    psid,
    {
      attachment: {
        type: "image",
        payload: {
          url: imageUrl,
          is_reusable: false,
        },
      },
    },
    {
      ...options,
      maxRetries: 2,
      retryBaseMs: 150,
      onRetry: (attempt, maxAttempts, error) => {
        safeLog("messenger_image_retry", {
          level: "warn",
          attempt,
          maxAttempts,
          imageUrl: imageUrlSummary,
          errorCode: error.name,
        });
      },
      onFinalFailure: (attempts, _maxAttempts, error) => {
        safeLog("messenger_image_send_failed", {
          level: "error",
          attempts,
          imageUrl: imageUrlSummary,
          errorCode: error.name,
        });
      },
    }
  );
  safeLog("messenger_image_send_completed", {
    imageUrl: imageUrlSummary,
    durationMs: Date.now() - startedAt,
    sent: outcome.sent,
    reason: outcome.sent ? undefined : outcome.reason,
  });
  return outcome;
}

export async function sendVideo(
  psid: string,
  videoUrl: string,
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  const videoUrlSummary = summarizeSensitiveUrl(videoUrl);
  const startedAt = Date.now();
  safeLog("messenger_video_send_started", { videoUrl: videoUrlSummary });

  const outcome = await sendMessage(
    psid,
    {
      attachment: {
        type: "video",
        payload: {
          url: videoUrl,
          is_reusable: false,
        },
      },
    },
    {
      ...options,
      maxRetries: 2,
      retryBaseMs: 150,
      onRetry: (attempt, maxAttempts, error) => {
        safeLog("messenger_video_retry", {
          level: "warn",
          attempt,
          maxAttempts,
          videoUrl: videoUrlSummary,
          errorCode: error.name,
        });
      },
      onFinalFailure: (attempts, _maxAttempts, error) => {
        safeLog("messenger_video_send_failed", {
          level: "error",
          attempts,
          videoUrl: videoUrlSummary,
          errorCode: error.name,
        });
      },
    }
  );
  safeLog("messenger_video_send_completed", {
    videoUrl: videoUrlSummary,
    durationMs: Date.now() - startedAt,
    sent: outcome.sent,
    reason: outcome.sent ? undefined : outcome.reason,
  });
  return outcome;
}

export async function sendAudio(
  psid: string,
  audioUrl: string
): Promise<MessengerSendOutcome> {
  return await sendMessage(psid, {
    attachment: {
      type: "audio",
      payload: { url: audioUrl, is_reusable: false },
    },
  });
}

export type { QuickReply, WebUrlButton, MessengerSendOutcome };
