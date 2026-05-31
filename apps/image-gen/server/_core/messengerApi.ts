import { hasOpenMessengerResponseWindow } from "./messengerState";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";

const GRAPH_API_VERSION = "v21.0";

type QuickReply = {
  content_type: "text";
  title: string;
  payload: string;
};

type MessengerSendOutcome =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "response_window_closed" };

type SendMessageOptions = {
  maxRetries?: number;
  retryBaseMs?: number;
  onRetry?: (attempt: number, maxAttempts: number, error: Error) => void;
  onFinalFailure?: (
    attempts: number,
    maxAttempts: number,
    error: Error
  ) => void;
};

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
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${encodeURIComponent(getPageToken())}`;
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

  return error.name === "AbortError" || error instanceof TypeError;
}

function getRetryAfterMs(response: Response): number | null {
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

function resolveRetryOptions(options?: SendMessageOptions): ResolvedRetryOptions {
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

async function postMessengerMessage(
  psid: string,
  message: Record<string, unknown>
): Promise<Response> {
  return await fetch(getSendApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: psid },
      message,
    }),
  });
}

async function waitBeforeRetry(
  attempt: number,
  retryBaseMs: number,
  response?: Response
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
    input.attempt < input.retry.maxRetries && isTransientNetworkError(input.error);

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
  response: Response;
  attempt: number;
  retry: ResolvedRetryOptions;
  options?: SendMessageOptions;
}): Promise<void> {
  const body = await input.response.text();
  const error = new Error(`Messenger API error ${input.response.status}: ${body}`);
  const canRetry =
    input.attempt < input.retry.maxRetries && shouldRetry(input.response.status);

  if (!canRetry) {
    input.options?.onFinalFailure?.(
      input.attempt + 1,
      input.retry.maxAttempts,
      error
    );
    throw error;
  }

  input.options?.onRetry?.(
    input.attempt + 1,
    input.retry.maxAttempts,
    error
  );
  await waitBeforeRetry(input.attempt, input.retry.retryBaseMs, input.response);
}

async function sendMessage(
  psid: string,
  message: Record<string, unknown>,
  options?: SendMessageOptions
): Promise<MessengerSendOutcome> {
  const withinResponseWindow = await Promise.resolve(hasOpenMessengerResponseWindow(psid));
  if (!withinResponseWindow) {
    safeLog("messenger_send_skipped", { reason: "response_window_closed" });
    return { sent: false, reason: "response_window_closed" };
  }

  const retry = resolveRetryOptions(options);

  for (let attempt = 0; attempt <= retry.maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await postMessengerMessage(psid, message);
    } catch (error) {
      await handleNetworkFailure({ error, attempt, retry, options });
      continue;
    }

    if (response.ok) {
      return await parseSendOutcome(response);
    }

    await handleErrorResponse({ response, attempt, retry, options });
  }

  throw new Error("Messenger API error: retry loop exited unexpectedly");
}

async function parseSendOutcome(response: Response): Promise<MessengerSendOutcome> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { sent: true };
  }

  try {
    const body = (await response.json()) as { message_id?: unknown };
    return typeof body.message_id === "string" && body.message_id.trim()
      ? { sent: true, messageId: body.message_id.trim() }
      : { sent: true };
  } catch {
    return { sent: true };
  }
}

function shouldDropLogKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return [
    "token",
    "psid",
    "text",
    "url",
    "payload",
    "attachment",
    "message",
    "sender",
    "body",
  ].some(fragment => lowered.includes(fragment));
}

function redactLogDetails(
  details: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !shouldDropLogKey(key))
      .map(([key, value]) => {
        if (typeof value === "string" && key === "user") {
          return [key, value.slice(0, 8)];
        }

        return [key, value];
      })
  );
}

export function safeLog(
  event: string,
  details: Record<string, unknown> = {}
): void {
  console.log(`[messenger] ${event}`, redactLogDetails(details));
}

export async function sendText(
  psid: string,
  text: string
): Promise<MessengerSendOutcome> {
  return await sendMessage(psid, { text });
}

export async function sendQuickReplies(
  psid: string,
  text: string,
  replies: QuickReply[]
): Promise<MessengerSendOutcome> {
  return await sendMessage(psid, {
    text,
    quick_replies: replies,
  });
}

export async function sendImage(
  psid: string,
  imageUrl: string
): Promise<MessengerSendOutcome> {
  const imageUrlSummary = summarizeSensitiveUrl(imageUrl);
  const startedAt = Date.now();
  console.info(
    JSON.stringify({
      level: "info",
      msg: "messenger_image_send_started",
      imageUrl: imageUrlSummary,
    })
  );

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
      maxRetries: 2,
      retryBaseMs: 150,
      onRetry: (attempt, maxAttempts, error) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "messenger_image_retry",
            attempt,
            maxAttempts,
            imageUrl: imageUrlSummary,
            errorCode: error.name,
          })
        );
      },
      onFinalFailure: (attempts, _maxAttempts, error) => {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "messenger_image_send_failed",
            attempts,
            imageUrl: imageUrlSummary,
            errorCode: error.name,
          })
        );
      },
    }
  );
  console.info(
    JSON.stringify({
      level: "info",
      msg: "messenger_image_send_completed",
      imageUrl: imageUrlSummary,
      durationMs: Date.now() - startedAt,
      sent: outcome.sent,
      reason: outcome.sent ? undefined : outcome.reason,
    })
  );
  return outcome;
}

export type {
  QuickReply,
  MessengerSendOutcome,
};
