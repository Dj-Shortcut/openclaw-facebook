import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createLogger } from "./logger";
import { toUserKey } from "./privacy";
import {
  resolveWhatsAppTransportCredential,
  WhatsAppTransportBindingError,
  type WhatsAppTransportCredential,
} from "./whatsappTransportCredential";
import {
  claimWhatsAppErasureControlProviderAttempt,
  finalizeWhatsAppProviderAttemptFence,
  markWhatsAppProviderAttemptStarted,
  reserveWhatsAppProviderAttemptFence,
  type WhatsAppProviderAttemptFence,
} from "./whatsappProviderAttemptFence";

const GRAPH_API_VERSION = "v19.0";
const logger = createLogger({});
const DEFAULT_WHATSAPP_GRAPH_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const WHATSAPP_MEDIA_HOSTS = new Set([
  "graph.facebook.com",
  "lookaside.fbsbx.com",
]);

export type WhatsAppReplyButton = {
  id: string;
  title: string;
};

export type WhatsAppDeliveryFailureOutcome =
  "pre_transport" | "known_rejected" | "ambiguous";

export type WhatsAppDeliveryReceipt = Readonly<{
  outcome: "accepted";
  attemptKeyHash: string | null;
}>;

export class WhatsAppDeliveryError extends Error {
  readonly outcome: WhatsAppDeliveryFailureOutcome;
  readonly attemptKeyHash: string | null;

  constructor(
    outcome: WhatsAppDeliveryFailureOutcome,
    attemptKeyHash: string | null,
    cause?: unknown
  ) {
    super(
      "WhatsApp delivery failed",
      cause === undefined ? undefined : { cause }
    );
    this.name = "WhatsAppDeliveryError";
    this.outcome = outcome;
    this.attemptKeyHash = attemptKeyHash;
  }
}

export function hasAmbiguousWhatsAppDeliveryOutcome(error: unknown): boolean {
  if (error instanceof WhatsAppDeliveryError) {
    return error.outcome === "ambiguous";
  }
  if (error instanceof AggregateError) {
    return error.errors.some(hasAmbiguousWhatsAppDeliveryOutcome);
  }
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    hasAmbiguousWhatsAppDeliveryOutcome(error.cause)
  );
}

function getWhatsAppSendUrl(phoneNumberId: string): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
}

function getGraphApiUrl(path: string): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`;
}

async function fetchWhatsAppGraph(
  pathOrUrl: string,
  init: RequestInit = {},
  credential?: WhatsAppTransportCredential
): Promise<Response> {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : getGraphApiUrl(pathOrUrl);
  const activeCredential =
    credential ?? (await resolveWhatsAppTransportCredential());

  return fetch(url, {
    ...init,
    redirect: "error",
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${activeCredential.accessToken}`,
    },
  });
}

function isAmbiguousWhatsAppResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function throwWithFenceFailure(
  primaryError: unknown,
  fence: WhatsAppProviderAttemptFence,
  outcome: "known_failed" | "ambiguous",
  deliveryOutcome: WhatsAppDeliveryFailureOutcome
): Promise<never> {
  const deliveryError = new WhatsAppDeliveryError(
    deliveryOutcome,
    fence.attemptKeyHash,
    primaryError
  );
  try {
    await finalizeWhatsAppProviderAttemptFence(fence, outcome);
  } catch (fenceError) {
    throw new AggregateError(
      [deliveryError, fenceError],
      "WhatsApp transport fence finalization failed",
      { cause: deliveryError }
    );
  }
  throw deliveryError;
}

async function sendWhatsAppGraph(input: {
  recipient: string;
  credential: WhatsAppTransportCredential & { phoneNumberId: string };
  reqId?: string;
  operation:
    "whatsapp_graph_text" | "whatsapp_graph_image" | "whatsapp_graph_buttons";
  init: RequestInit;
  fence?: WhatsAppProviderAttemptFence;
}): Promise<{
  response: Response;
  attemptKeyHash: string | null;
  failureOutcome: Exclude<
    WhatsAppDeliveryFailureOutcome,
    "pre_transport"
  > | null;
}> {
  let fence: WhatsAppProviderAttemptFence;
  try {
    fence =
      input.fence ??
      (await reserveWhatsAppProviderAttemptFence({
        reqId: input.reqId ?? randomUUID(),
        userKey: input.credential.userKey ?? toUserKey(input.recipient),
        providerOperation: input.operation,
      }));
  } catch (error) {
    throw new WhatsAppDeliveryError("pre_transport", null, error);
  }
  try {
    await markWhatsAppProviderAttemptStarted(fence);
  } catch (error) {
    return throwWithFenceFailure(error, fence, "known_failed", "pre_transport");
  }

  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, getWhatsAppGraphSendTimeoutMs());
  try {
    response = await fetchWhatsAppGraph(
      getWhatsAppSendUrl(input.credential.phoneNumberId),
      { ...input.init, signal: controller.signal },
      input.credential
    );
  } catch (error) {
    return throwWithFenceFailure(error, fence, "ambiguous", "ambiguous");
  } finally {
    clearTimeout(timeout);
  }
  const failureOutcome = response.ok
    ? null
    : isAmbiguousWhatsAppResponse(response.status)
      ? ("ambiguous" as const)
      : ("known_rejected" as const);
  try {
    await finalizeWhatsAppProviderAttemptFence(
      fence,
      response.ok
        ? "succeeded"
        : failureOutcome === "known_rejected"
          ? "known_failed"
          : "ambiguous"
    );
  } catch (error) {
    // A 2xx followed by a local persistence failure is provider-ambiguous to
    // the caller; it can never be downgraded to a safe automatic cleanup.
    throw new WhatsAppDeliveryError(
      response.ok ? "ambiguous" : (failureOutcome ?? "ambiguous"),
      fence.attemptKeyHash,
      error
    );
  }
  return {
    response,
    attemptKeyHash: fence.attemptKeyHash,
    failureOutcome,
  };
}

function validateWhatsAppMediaUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("WhatsApp media URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !WHATSAPP_MEDIA_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new Error("WhatsApp media URL is invalid");
  }
  return url.toString();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function getWhatsAppMediaDownloadTimeoutMs(): number {
  return readPositiveIntEnv(
    "WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS",
    DEFAULT_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS
  );
}

function getWhatsAppGraphSendTimeoutMs(): number {
  return readPositiveIntEnv(
    "WHATSAPP_GRAPH_SEND_TIMEOUT_MS",
    DEFAULT_WHATSAPP_GRAPH_SEND_TIMEOUT_MS
  );
}

function getWhatsAppMediaMaxBytes(): number {
  return readPositiveIntEnv(
    "WHATSAPP_MEDIA_MAX_BYTES",
    DEFAULT_WHATSAPP_MEDIA_MAX_BYTES
  );
}

function assertWhatsAppMediaWithinLimit(byteLength: number): void {
  const maxBytes = getWhatsAppMediaMaxBytes();
  if (byteLength > maxBytes) {
    throw new Error(`WhatsApp media too large (${byteLength} bytes)`);
  }
}

async function readWhatsAppMediaBuffer(response: Response): Promise<Buffer> {
  const contentLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10
  );
  if (Number.isFinite(contentLength) && contentLength > 0) {
    assertWhatsAppMediaWithinLimit(contentLength);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertWhatsAppMediaWithinLimit(buffer.length);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    try {
      assertWhatsAppMediaWithinLimit(totalBytes);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    chunks.push(value);
  }

  return Buffer.concat(
    chunks.map(chunk =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )
  );
}

function assertWhatsAppResponseOk(response: Response, event: string): void {
  if (response.ok) {
    return;
  }

  logger.error({
    event,
    status: response.status,
  });

  throw new Error(`WhatsApp API request failed (${response.status})`);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function resolveWhatsAppSendCredential(
  recipient: string
): Promise<WhatsAppTransportCredential & { phoneNumberId: string }> {
  const credential = await resolveWhatsAppTransportCredential();
  if (!credential.phoneNumberId) {
    throw new WhatsAppTransportBindingError();
  }
  if (
    credential.userKey &&
    !constantTimeEqual(toUserKey(recipient), credential.userKey)
  ) {
    throw new WhatsAppTransportBindingError();
  }
  return { ...credential, phoneNumberId: credential.phoneNumberId };
}

function createErasureOutcomeAttemptId(reqId: string, message: string): string {
  return createHash("sha256")
    .update("whatsapp:erasure-outcome:v1", "utf8")
    .update("\0")
    .update(reqId)
    .update("\0")
    .update(message)
    .digest("hex");
}

export async function sendWhatsAppErasureControlText(
  to: string,
  message: string,
  reqId: string
): Promise<void> {
  const normalizedReqId = reqId.trim();
  if (!normalizedReqId) {
    throw new WhatsAppDeliveryError("pre_transport", null);
  }

  let claim;
  try {
    claim = await claimWhatsAppErasureControlProviderAttempt({
      reqId: createErasureOutcomeAttemptId(normalizedReqId, message),
      userKey: toUserKey(to),
    });
  } catch (error) {
    throw new WhatsAppDeliveryError("pre_transport", null, error);
  }
  if (claim.kind === "succeeded") return;
  if (claim.kind === "ambiguous") {
    throw new WhatsAppDeliveryError("ambiguous", claim.attemptKeyHash);
  }

  const fence = claim.fence;
  let credential: WhatsAppTransportCredential & { phoneNumberId: string };
  try {
    credential = await resolveWhatsAppSendCredential(to);
  } catch (error) {
    return throwWithFenceFailure(error, fence, "known_failed", "pre_transport");
  }
  const result = await sendWhatsAppGraph({
    recipient: to,
    credential,
    operation: "whatsapp_graph_text",
    fence,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      }),
    },
  });
  if (!result.response.ok) {
    logger.error({
      event: "whatsapp_send_failed",
      status: result.response.status,
    });
    throw new WhatsAppDeliveryError(
      result.failureOutcome ?? "ambiguous",
      result.attemptKeyHash
    );
  }
}

export async function sendWhatsAppText(
  to: string,
  message: string
): Promise<void> {
  let credential: WhatsAppTransportCredential & { phoneNumberId: string };
  try {
    credential = await resolveWhatsAppSendCredential(to);
  } catch (error) {
    throw new WhatsAppDeliveryError("pre_transport", null, error);
  }
  const result = await sendWhatsAppGraph({
    recipient: to,
    credential,
    operation: "whatsapp_graph_text",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      }),
    },
  });
  if (!result.response.ok) {
    logger.error({
      event: "whatsapp_send_failed",
      status: result.response.status,
    });
    throw new WhatsAppDeliveryError(
      result.failureOutcome ?? "ambiguous",
      result.attemptKeyHash
    );
  }
}

export async function sendWhatsAppImageWithReceipt(
  to: string,
  imageUrl: string,
  reqId: string
): Promise<WhatsAppDeliveryReceipt> {
  let credential: WhatsAppTransportCredential & { phoneNumberId: string };
  try {
    credential = await resolveWhatsAppSendCredential(to);
  } catch (error) {
    throw new WhatsAppDeliveryError("pre_transport", null, error);
  }
  const result = await sendWhatsAppGraph({
    recipient: to,
    credential,
    reqId,
    operation: "whatsapp_graph_image",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link: imageUrl },
      }),
    },
  });
  if (!result.response.ok) {
    throw new WhatsAppDeliveryError(
      result.failureOutcome ?? "ambiguous",
      result.attemptKeyHash
    );
  }
  return Object.freeze({
    outcome: "accepted" as const,
    attemptKeyHash: result.attemptKeyHash,
  });
}

export async function sendWhatsAppImage(
  to: string,
  imageUrl: string,
  reqId: string
): Promise<void> {
  await sendWhatsAppImageWithReceipt(to, imageUrl, reqId);
}

export async function sendWhatsAppButtons(
  to: string,
  bodyText: string,
  buttons: WhatsAppReplyButton[]
): Promise<void> {
  let credential: WhatsAppTransportCredential & { phoneNumberId: string };
  try {
    credential = await resolveWhatsAppSendCredential(to);
  } catch (error) {
    throw new WhatsAppDeliveryError("pre_transport", null, error);
  }
  const result = await sendWhatsAppGraph({
    recipient: to,
    credential,
    operation: "whatsapp_graph_buttons",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map(button => ({
              type: "reply",
              reply: {
                id: button.id,
                title: button.title.slice(0, 20),
              },
            })),
          },
        },
      }),
    },
  });
  if (!result.response.ok) {
    logger.error({
      event: "whatsapp_buttons_send_failed",
      status: result.response.status,
    });
    throw new WhatsAppDeliveryError(
      result.failureOutcome ?? "ambiguous",
      result.attemptKeyHash
    );
  }
}

export async function downloadWhatsAppMedia(
  mediaId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const metadataController = new AbortController();
  const metadataTimeout = setTimeout(() => {
    metadataController.abort();
  }, getWhatsAppMediaDownloadTimeoutMs());
  let metadata: { url?: string; mime_type?: string };
  try {
    const metadataResponse = await fetchWhatsAppGraph(
      `${encodeURIComponent(mediaId)}`,
      { signal: metadataController.signal }
    );
    assertWhatsAppResponseOk(
      metadataResponse,
      "whatsapp_media_metadata_failed"
    );
    metadata = (await metadataResponse.json()) as {
      url?: string;
      mime_type?: string;
    };
  } finally {
    clearTimeout(metadataTimeout);
  }
  const rawMediaUrl = metadata.url?.trim();
  if (!rawMediaUrl) {
    throw new Error("WhatsApp media metadata response missing url");
  }
  const mediaUrl = validateWhatsAppMediaUrl(rawMediaUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, getWhatsAppMediaDownloadTimeoutMs());
  try {
    const mediaResponse = await fetchWhatsAppGraph(mediaUrl, {
      signal: controller.signal,
    });
    assertWhatsAppResponseOk(mediaResponse, "whatsapp_media_download_failed");

    const contentType =
      mediaResponse.headers.get("content-type") ??
      metadata.mime_type?.trim() ??
      "application/octet-stream";

    return {
      buffer: await readWhatsAppMediaBuffer(mediaResponse),
      contentType,
    };
  } finally {
    clearTimeout(timeout);
  }
}
