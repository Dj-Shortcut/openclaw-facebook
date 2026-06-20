export const DEFAULT_IMAGE_GEN_URL = "https://leaderbot-fb-image-gen.fly.dev";
export const IMAGE_GEN_REQUEST_TIMEOUT_MS = 5_000;

export type LeaderbotImageGenRequestConfig =
  | { ok: true; endpoint: string; token: string }
  | { ok: false; reason: "disabled_by_config" | "missing_token" | "invalid_url" };

export function resolveImageGenRequestConfig(params: {
  leaderbotBridgeEnabled?: boolean;
} = {}): LeaderbotImageGenRequestConfig {
  if (params.leaderbotBridgeEnabled !== true) {
    return { ok: false, reason: "disabled_by_config" };
  }
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
    const isLocalhost = baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1";
    if (baseUrl.protocol !== "https:" && !isLocalhost) {
      return { ok: false, reason: "invalid_url" };
    }
    const endpoint = new URL("/internal/messenger/image-request", baseUrl);
    return { ok: true, endpoint: endpoint.toString(), token };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}
