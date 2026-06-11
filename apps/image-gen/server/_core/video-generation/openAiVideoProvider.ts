import { safeLog } from "../logger";
import type {
  VideoProvider,
  VideoProviderFailure,
  VideoProviderRequest,
  VideoProviderResult,
} from "./videoProvider";

const OPENAI_VIDEO_ENDPOINT = "https://api.openai.com/v1/videos";
const DEFAULT_OPENAI_VIDEO_MODEL = "sora-2";
const DEFAULT_OPENAI_VIDEO_SIZE = "1280x720";
const DEFAULT_OPENAI_VIDEO_SECONDS = "8";
const DEFAULT_OPENAI_VIDEO_POLL_INTERVAL_MS = 2_000;
const DEFAULT_OPENAI_VIDEO_MAX_RETRIES = 1;
const DEFAULT_OPENAI_VIDEO_RETRY_BASE_MS = 750;
const DEFAULT_OPENAI_VIDEO_MAX_OUTPUT_BYTES = 60 * 1024 * 1024;

type OpenAiVideoJob = {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string };
  duration_seconds?: number;
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
  return process.env.OPENAI_VIDEO_SECONDS?.trim() || DEFAULT_OPENAI_VIDEO_SECONDS;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function classifyResponse(status: number, body: string): VideoProviderFailure {
  const normalized = body.toLowerCase();
  if (status === 408) {
    return { kind: "failure", provider: "openai", errorClass: "timeout", retryable: true };
  }
  if (status === 429) {
    return normalized.includes("quota") || normalized.includes("budget")
      ? { kind: "failure", provider: "openai", errorClass: "budget", retryable: false }
      : { kind: "failure", provider: "openai", errorClass: "rate_limited", retryable: true };
  }
  if (status === 400 || status === 403) {
    return normalized.includes("policy") || normalized.includes("safety")
      ? { kind: "failure", provider: "openai", errorClass: "policy", retryable: false }
      : { kind: "failure", provider: "openai", errorClass: "provider", retryable: false };
  }
  return {
    kind: "failure",
    provider: "openai",
    errorClass: status >= 500 ? "provider" : "unknown",
    retryable: status >= 500,
  };
}

function classifyError(error: unknown): VideoProviderFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "failure", provider: "openai", errorClass: "timeout", retryable: true };
  }
  return { kind: "failure", provider: "openai", errorClass: "unknown", retryable: false };
}

async function readErrorBody(response: Response): Promise<string> {
  return await response.text().catch(() => response.statusText);
}

async function createVideoJob(
  input: VideoProviderRequest,
  timeoutMs: number
): Promise<OpenAiVideoJob | VideoProviderFailure> {
  const response = await fetchWithTimeout(
    OPENAI_VIDEO_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getModel(),
        prompt: input.prompt,
        size: getSize(),
        seconds: getSeconds(),
        input_reference: {
          image_url: input.sourceImageUrl,
        },
      }),
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

  const bytes = new Uint8Array(await response.arrayBuffer());
  const maxBytes = readPositiveInt(
    "OPENAI_VIDEO_MAX_OUTPUT_BYTES",
    DEFAULT_OPENAI_VIDEO_MAX_OUTPUT_BYTES
  );
  if (bytes.length <= 0 || bytes.length > maxBytes) {
    return {
      kind: "failure",
      provider: "openai",
      errorClass: "provider",
      retryable: false,
    };
  }

  return bytes;
}

export class OpenAiVideoProvider implements VideoProvider {
  async generateVideo(input: VideoProviderRequest): Promise<VideoProviderResult> {
    const maxRetries = readNonNegativeInt(
      "OPENAI_VIDEO_MAX_RETRIES",
      DEFAULT_OPENAI_VIDEO_MAX_RETRIES
    );
    const retryBaseMs = readPositiveInt(
      "OPENAI_VIDEO_RETRY_BASE_MS",
      DEFAULT_OPENAI_VIDEO_RETRY_BASE_MS
    );

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await this.tryGenerateVideo(input).catch(classifyError);
      if (result.kind === "success" || !result.retryable || attempt >= maxRetries) {
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
    const job = await createVideoJob(input, input.timeoutMs);
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

    const deadline = Date.now() + input.timeoutMs;
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
          retryable: true,
        };
      }

      await wait(pollIntervalMs);
      const polled = await retrieveVideoJob(videoId, input.timeoutMs);
      if ("kind" in polled) {
        return polled;
      }
      current = polled;
    }

    const bytes = await downloadVideo(videoId, input.timeoutMs);
    if ("kind" in bytes) {
      return bytes;
    }

    safeLog("openai_video_response_downloaded", {
      reqId: input.reqId,
      providerJobId: videoId,
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
}
