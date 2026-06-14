export type VideoProviderErrorClass =
  | "timeout"
  | "rate_limited"
  | "budget"
  | "policy"
  | "provider"
  | "unknown";

export type VideoProviderRequest = {
  prompt: string;
  sourceImageUrl: string;
  reqId: string;
  userKey: string;
  timeoutMs: number;
  onProviderAttempt?: () => Promise<void>;
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
};

export type VideoProviderResult = VideoProviderSuccess | VideoProviderFailure;

export type VideoProvider = {
  generateVideo(input: VideoProviderRequest): Promise<VideoProviderResult>;
  deleteVideo?(providerJobId: string, reqId?: string): Promise<void>;
};
