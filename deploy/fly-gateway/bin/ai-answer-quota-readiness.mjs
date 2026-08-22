const AI_ANSWER_QUOTA_PROTOCOL = "leaderbot-ai-answer-quota-v1";
const DEFAULT_IMAGE_GEN_URL = "https://leaderbot-fb-image-gen.fly.dev";
const DEFAULT_TIMEOUT_MS = 5_000;

function isExactEnabled(value) {
  return String(value || "").trim() === "true";
}

export function resolveAiAnswerQuotaReadinessPolicy(env = process.env) {
  const admissionRequired = isExactEnabled(
    env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED,
  );
  const preflightRequired = isExactEnabled(
    env.LEADERBOT_AI_ANSWER_PREFLIGHT_ENABLED,
  );
  return {
    required: admissionRequired || preflightRequired,
    admissionRequired,
  };
}

export async function assertLeaderbotAiAnswerQuotaReadiness({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const policy = resolveAiAnswerQuotaReadinessPolicy(env);
  if (!policy.required) {
    return { checked: false };
  }

  const token = String(
    env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN ||
      env.INTERNAL_IMAGE_REQUEST_TOKEN ||
      "",
  ).trim();
  if (token.length < 32) {
    throw new Error("AI answer quota readiness token is unavailable");
  }

  let endpoint;
  try {
    const baseUrl = new URL(
      String(env.LEADERBOT_IMAGE_GEN_URL || DEFAULT_IMAGE_GEN_URL).trim(),
    );
    const local =
      baseUrl.hostname === "localhost" ||
      baseUrl.hostname === "127.0.0.1" ||
      baseUrl.hostname === "::1";
    if (baseUrl.protocol !== "https:" && !local) {
      throw new Error("invalid protocol");
    }
    endpoint = new URL(
      "/internal/messenger/ai-answer-quota/readiness",
      baseUrl,
    );
  } catch {
    throw new Error("AI answer quota readiness URL is invalid");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error("AI answer quota readiness handshake failed");
    }
    const payload = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      payload.protocol !== AI_ANSWER_QUOTA_PROTOCOL ||
      payload.preflightReady !== true ||
      payload.drainEnabled !== true ||
      (policy.admissionRequired && payload.admissionEnabled !== true)
    ) {
      throw new Error("AI answer quota readiness contract mismatch");
    }
    return {
      checked: true,
      admissionEnabled: payload.admissionEnabled === true,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("AI answer quota readiness")
    ) {
      throw error;
    }
    throw new Error("AI answer quota readiness handshake failed", {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}
