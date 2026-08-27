import { createHash } from "node:crypto";
import { safeLog } from "../logger";
import {
  assertCostLedgerTenantScope,
  safelyAppendCostLedgerEntry,
} from "../costLedger";
import {
  VideoProviderJobRegistrationError,
  type VideoProvider,
  type VideoProviderFailure,
  type VideoProviderRequest,
  type VideoProviderResult,
} from "./videoProvider";

const OPENAI_VIDEO_ENDPOINT = "https://api.openai.com/v1/videos";
const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";
const DEFAULT_OPENAI_VIDEO_SIZE = "1280x720";
const DEFAULT_OPENAI_VIDEO_SECONDS = "8";
const DEFAULT_OPENAI_VIDEO_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OPENAI_VIDEO_MAX_RETRIES = 1;
const DEFAULT_OPENAI_VIDEO_RETRY_BASE_MS = 750;
const DEFAULT_OPENAI_VIDEO_MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const DEFAULT_OPENAI_VIDEO_MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;

function toOpenAiClientRequestId(reqId: string): string {
  return `video-${createHash("sha256").update(reqId).digest("hex").slice(0, 32)}`;
}

type OpenAiVideoJob = {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string };
  duration_seconds?: number;
};

type ReferenceImage = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
};

function readPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }
  return apiKey;
}

function getModel(): string {
  return process.env.OPENAI_VIDEO_MODEL?.trim() || DEFAULT_OPENAI_VIDEO_MODEL;
}

function getSize(): string {
  return process.env.OPENAI_VIDEO_SIZE?.trim() || DEFAULT_OPENAI_VIDEO_SIZE;
}

function getSeconds(): string {
  return (
    process.env.OPENAI_VIDEO_SECONDS?.trim() || DEFAULT_OPENAI_VIDEO_SECONDS
  );
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function remainingTimeoutMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return null;
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > maxBytes ? null : bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function fetchReferenceImage(
  imageUrl: string,
  timeoutMs: number
): Promise<ReferenceImage | VideoProviderFailure> {
  const response = await fetchWithTimeout(
    imageUrl,
    {
      method: "GET",
      redirect: "manual",
    },
    timeoutMs
  );

  if (!response.ok) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim();
  if (!contentType?.startsWith("image/")) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  const maxBytes = readPositiveInt(
    "OPENAI_VIDEO_MAX_REFERENCE_IMAGE_BYTES",
    DEFAULT_OPENAI_VIDEO_MAX_REFERENCE_IMAGE_BYTES
  );
  const bytes = await readBoundedBytes(response, maxBytes);
  if (!bytes || bytes.length <= 0) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  return {
    bytes,
    contentType,
  };
}

function classifyResponse(status: number, body: string): VideoProviderFailure {
  const normalized = body.toLowerCase();
  const providerErrorCode = readProviderErrorCode(body);
  const metadata = {
    providerStatus: status,
    ...(providerErrorCode ? { providerErrorCode } : {}),
  };
  if (status === 408) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "timeout",
      retryable: true,
      ...metadata,
    };
  }
  if (status === 429) {
    return normalized.includes("quota") || normalized.includes("budget")
      ? {
          kind: "failure",
          provider: "openai",
          errorClass: "budget",
          retryable: false,
          ...metadata,
        }
      : {
          kind: "failure",
          provider: "openai",
          errorClass: "rate_limited",
          retryable: true,
          ...metadata,
        };
  }
  if (status === 400 || status === 403) {
    return normalized.includes("policy") || normalized.includes("safety")
      ? {
          kind: "failure",
          provider: "openai",
          errorClass: "policy",
          retryable: false,
          ...metadata,
        }
      : {
          kind: "failure",
          provider: "openai",
          errorClass: "provider",
          retryable: false,
          ...metadata,
        };
  }
  return {
    kind: "failure",
    provider: "openai",
    errorClass: status >= 500 ? "provider" : "unknown",
    retryable: status >= 500,
    ...metadata,
  };
}

function readProviderErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const providerError =
      parsed !== null && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : undefined;
    const code =
      providerError !== null &&
      typeof providerError === "object" &&
      "code" in providerError
        ? providerError.code
        : undefined;
    return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyError(error: unknown): VideoProviderFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "timeout",
      retryable: true,
    };
  }
  return {
    kind: "failure",
    provider: "openai",
    errorClass: "unknown",
    retryable: false,
  };
}

async function readErrorBody(response: Response): Promise<string> {
  return await response.text().catch(() => response.statusText);
}

async function createVideoJob(
  input: VideoProviderRequest,
  timeoutMs: number
): Promise<OpenAiVideoJob | VideoProviderFailure> {
  const referenceImage = await fetchReferenceImage(
    input.sourceImageUrl,
    timeoutMs
  );
  if ("kind" in referenceImage) {
    return referenceImage;
  }

  const formData = new FormData();
  formData.append("model", getModel());
  formData.append("prompt", input.prompt);
  formData.append("size", getSize());
  formData.append("seconds", getSeconds());
  formData.append(
    "input_reference",
    new Blob([referenceImage.bytes.buffer], {
      type: referenceImage.contentType,
    }),
    `source.${referenceImage.contentType.split("/")[1] || "jpg"}`
  );

  const apiKey = getApiKey();
  const attemptNow = new Date();
  const suppliedEntryId = await input.onProviderAttempt?.();
  const ledgerEntryId =
    suppliedEntryId || `${input.reqId}:${attemptNow.toISOString()}`;
  if (!suppliedEntryId) {
    if (input.costLedgerScope) {
      assertCostLedgerTenantScope(input.costLedgerScope);
      if (input.costLedgerScope.userKey !== input.userKey) {
        throw new Error("Video cost ledger user scope does not match");
      }
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger video cost ledger tenant scope is required");
    }
    await safelyAppendCostLedgerEntry(
      {
        id: ledgerEntryId,
        channel: "facebook_messenger",
        operation: "video_generation",
        provider: "openai-video",
        model: getModel(),
        ...(input.costLedgerScope ?? {}),
        userKey: input.userKey,
        reqId: input.reqId,
        status: "provider_attempt_started",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: false,
        estimateSource: "unpriced",
        unpricedCostComponents: ["video_generation"],
        providerUsage: {
          pricingModel: "unpriced",
          size: getSize(),
          seconds: Number(getSeconds()),
          sourceContentType: referenceImage.contentType,
          sourceBytes: referenceImage.bytes.byteLength,
        },
      },
      attemptNow
    );
  }
  const response = await fetchWithTimeout(
    OPENAI_VIDEO_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Client-Request-Id": toOpenAiClientRequestId(input.reqId),
      },
      body: formData,
    },
    timeoutMs
  );

  if (!response.ok) {
    return classifyResponse(response.status, await readErrorBody(response));
  }

  return (await response.json()) as OpenAiVideoJob;
}

async function retrieveVideoJob(
  videoId: string,
  timeoutMs: number
): Promise<OpenAiVideoJob | VideoProviderFailure> {
  const response = await fetchWithTimeout(
    `${OPENAI_VIDEO_ENDPOINT}/${encodeURIComponent(videoId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
      },
    },
    timeoutMs
  );

  if (!response.ok) {
    return classifyResponse(response.status, await readErrorBody(response));
  }

  return (await response.json()) as OpenAiVideoJob;
}

async function downloadVideo(
  videoId: string,
  timeoutMs: number
): Promise<Uint8Array | VideoProviderFailure> {
  const response = await fetchWithTimeout(
    `${OPENAI_VIDEO_ENDPOINT}/${encodeURIComponent(videoId)}/content?variant=video`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
      },
    },
    timeoutMs
  );

  if (!response.ok) {
    return classifyResponse(response.status, await readErrorBody(response));
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "video/mp4") {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  const maxBytes = readPositiveInt(
    "OPENAI_VIDEO_MAX_OUTPUT_BYTES",
    DEFAULT_OPENAI_VIDEO_MAX_OUTPUT_BYTES
  );
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  if (!response.body) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return {
        kind: "failure",
        provider: "openai",
        errorClass: "provider",
        retryable: false,
      };
    }
    chunks.push(value);
  }
  if (totalBytes === 0) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export class OpenAiVideoProvider implements VideoProvider {
  async generateVideo(
    input: VideoProviderRequest
  ): Promise<VideoProviderResult> {
    const maxRetries = readNonNegativeInt(
      "OPENAI_VIDEO_MAX_RETRIES",
      DEFAULT_OPENAI_VIDEO_MAX_RETRIES
    );
    const retryBaseMs = readPositiveInt(
      "OPENAI_VIDEO_RETRY_BASE_MS",
      DEFAULT_OPENAI_VIDEO_RETRY_BASE_MS
    );

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await this.tryGenerateVideo(input).catch(error => {
        if (
          error instanceof VideoProviderJobRegistrationError ||
          (error instanceof Error &&
            error.name === "MessengerQuotaReservationCommitError")
        ) {
          throw error;
        }
        return classifyError(error);
      });
      if (
        result.kind === "success" ||
        !result.retryable ||
        attempt >= maxRetries
      ) {
        return result;
      }

      const waitMs = retryBaseMs * 2 ** attempt;
      safeLog("openai_video_generation_retry", {
        level: "warn",
        reqId: input.reqId,
        attempt: attempt + 1,
        waitMs,
        errorClass: result.errorClass,
      });
      await wait(waitMs);
    }

    return {
      kind: "failure",
      provider: "openai",
      errorClass: "unknown",
      retryable: false,
    };
  }

  private async tryGenerateVideo(
    input: VideoProviderRequest
  ): Promise<VideoProviderResult> {
    safeLog("openai_video_request_started", { reqId: input.reqId });
    const deadline = Date.now() + input.timeoutMs;
    const job = await createVideoJob(input, remainingTimeoutMs(deadline));
    if ("kind" in job) {
      return job;
    }

    const videoId = job.id;
    if (!videoId) {
      return {
        kind: "failure",
        provider: "openai",
        errorClass: "provider",
        retryable: false,
      };
    }
    try {
      await input.onProviderJobCreated?.({
        provider: "openai",
        providerJobId: videoId,
      });
    } catch (error) {
      throw new VideoProviderJobRegistrationError(error);
    }

    const pollIntervalMs = readPositiveInt(
      "OPENAI_VIDEO_POLL_INTERVAL_MS",
      DEFAULT_OPENAI_VIDEO_POLL_INTERVAL_MS
    );
    let current: OpenAiVideoJob = job;
    while (current.status !== "completed") {
      if (current.status === "failed" || current.status === "expired") {
        return {
          kind: "failure",
          provider: "openai",
          errorClass: "provider",
          retryable: false,
        };
      }

      if (Date.now() + pollIntervalMs > deadline) {
        return {
          kind: "failure",
          provider: "openai",
          errorClass: "timeout",
          retryable: false,
        };
      }

      await wait(pollIntervalMs);
      const polled = await retrieveVideoJob(
        videoId,
        remainingTimeoutMs(deadline)
      );
      if ("kind" in polled) {
        return polled;
      }
      current = polled;
    }

    const bytes = await downloadVideo(videoId, remainingTimeoutMs(deadline));
    if ("kind" in bytes) {
      return bytes;
    }

    safeLog("openai_video_response_downloaded", {
      reqId: input.reqId,
      outputBytes: bytes.length,
    });
    return {
      kind: "success",
      provider: "openai",
      providerJobId: videoId,
      videoBytes: bytes,
      contentType: "video/mp4",
      durationSeconds: current.duration_seconds,
    };
  }

  async deleteVideo(providerJobId: string, reqId?: string): Promise<void> {
    const response = await fetchWithTimeout(
      `${OPENAI_VIDEO_ENDPOINT}/${encodeURIComponent(providerJobId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
        },
      },
      30_000
    );

    if (!response.ok && response.status !== 404) {
      safeLog("openai_video_delete_failed", {
        level: "warn",
        reqId,
        status: response.status,
      });
      throw new Error(`OpenAI video delete failed (${response.status})`);
    }

    safeLog("openai_video_deleted", {
      reqId,
    });
  }
}
