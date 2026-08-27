import type { CostLedgerTenantScope } from "../costLedger";

export type VideoProviderErrorClass =
  "timeout" | "rate_limited" | "budget" | "policy" | "provider" | "unknown";

export type VideoProviderRequest = {
  prompt: string;
  sourceImageUrl: string;
  reqId: string;
  userKey: string;
  costLedgerScope?: CostLedgerTenantScope;
  timeoutMs: number;
  onProviderAttempt?: () => Promise<string | undefined>;
  onProviderJobCreated?: (artifact: {
    provider: string;
    providerJobId: string;
  }) => Promise<void>;
};

export type VideoProviderSuccess = {
  kind: "success";
  provider: string;
  providerJobId: string;
  videoBytes: Uint8Array;
  contentType: "video/mp4";
  durationSeconds?: number;
};

export type VideoProviderFailure = {
  kind: "failure";
  provider: string;
  errorClass: VideoProviderErrorClass;
  retryable: boolean;
  /** Safe provider metadata for operational diagnosis; never include prompts or media URLs. */
  providerStatus?: number;
  providerErrorCode?: string;
};

export type VideoProviderResult = VideoProviderSuccess | VideoProviderFailure;

export type VideoProvider = {
  generateVideo(input: VideoProviderRequest): Promise<VideoProviderResult>;
  deleteVideo?(providerJobId: string, reqId?: string): Promise<void>;
};

export class VideoProviderJobRegistrationError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("Video provider job cleanup registration failed");
    this.name = "VideoProviderJobRegistrationError";
    this.cause = cause;
  }
}
