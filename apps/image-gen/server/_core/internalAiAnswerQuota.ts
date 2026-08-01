import { isMollieEntitlementEnforcementEnabled } from "./billing/config";
import {
  commitStartpilotAiAnswerUsage,
  releaseStartpilotAiAnswerUsage,
  reserveStartpilotAiAnswerUsage,
} from "./billing/entitlementUsageStore";
import { resolveWorkspaceRuntimePolicy } from "./workspaceEntitlementRuntime";

export type InternalAiAnswerQuotaReserveResult =
  | { status: "not_applicable" }
  | { status: "reserved"; reservationId: string }
  | { status: "duplicate" }
  | { status: "exhausted" };

function assertAiAnswerEnforcementConfigured(): void {
  if (!isMollieEntitlementEnforcementEnabled()) {
    throw new Error("paid entitlement enforcement is disabled");
  }
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error("paid entitlement database is unavailable");
  }
}

export async function reserveInternalAiAnswerQuota(input: {
  pageId: string;
  idempotencyKey: string;
}): Promise<InternalAiAnswerQuotaReserveResult> {
  assertAiAnswerEnforcementConfigured();
  const policy = await resolveWorkspaceRuntimePolicy(input.pageId);
  if (policy.kind === "free") return { status: "not_applicable" };

  const result = await reserveStartpilotAiAnswerUsage({
    workspaceId: policy.workspaceId,
    entitlementId: policy.entitlementId,
    mode: policy.mode,
    idempotencyKey: input.idempotencyKey,
  });
  if (!result.allowed) {
    return result.reason === "idempotency_reused"
      ? { status: "duplicate" }
      : { status: "exhausted" };
  }
  if (result.alreadyReserved) return { status: "duplicate" };
  return { status: "reserved", reservationId: result.reservationId };
}

export async function finalizeInternalAiAnswerQuota(input: {
  pageId: string;
  reservationId: string;
  outcome: "committed" | "released";
}): Promise<{ status: "finalized" }> {
  assertAiAnswerEnforcementConfigured();
  const policy = await resolveWorkspaceRuntimePolicy(input.pageId);
  if (policy.kind !== "startpilot") {
    throw new Error("paid entitlement reservation scope is unavailable");
  }
  const scope = {
    workspaceId: policy.workspaceId,
    entitlementId: policy.entitlementId,
    mode: policy.mode,
    reservationId: input.reservationId,
  };
  const result =
    input.outcome === "committed"
      ? await commitStartpilotAiAnswerUsage(scope)
      : await releaseStartpilotAiAnswerUsage(scope);
  const finalized =
    "committed" in result ? result.committed : result.released;
  if (!finalized) throw new Error("paid entitlement reservation was not finalized");
  return { status: "finalized" };
}
