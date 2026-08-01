import { and, eq } from "drizzle-orm";
import {
  channelConnections,
  workspaceEntitlementUsageReservations,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
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

type InternalAiAnswerQuotaErrorCode =
  | "database_unavailable"
  | "enforcement_disabled"
  | "finalization_store_failure"
  | "quota_store_failure"
  | "reservation_lookup_failed"
  | "reservation_not_finalized"
  | "reservation_scope_unavailable";

export class InternalAiAnswerQuotaError extends Error {
  constructor(
    readonly code: InternalAiAnswerQuotaErrorCode,
    options?: ErrorOptions
  ) {
    super("AI answer quota is unavailable", options);
    this.name = "InternalAiAnswerQuotaError";
  }
}

export function safeInternalAiAnswerQuotaErrorCode(error: unknown): string {
  if (error instanceof InternalAiAnswerQuotaError) return error.code;
  const name = error instanceof Error ? error.name : "UnknownError";
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "UnknownError";
}

function assertAiAnswerEnforcementConfigured(): void {
  if (!isMollieEntitlementEnforcementEnabled()) {
    throw new InternalAiAnswerQuotaError("enforcement_disabled");
  }
  assertAiAnswerDatabaseConfigured();
}

function assertAiAnswerDatabaseConfigured(): void {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new InternalAiAnswerQuotaError("database_unavailable");
  }
}

export async function reserveInternalAiAnswerQuota(input: {
  pageId: string;
  idempotencyKey: string;
}): Promise<InternalAiAnswerQuotaReserveResult> {
  assertAiAnswerEnforcementConfigured();
  const policy = await resolveWorkspaceRuntimePolicy(input.pageId);
  if (policy.kind === "free") return { status: "not_applicable" };

  let result: Awaited<ReturnType<typeof reserveStartpilotAiAnswerUsage>>;
  try {
    result = await reserveStartpilotAiAnswerUsage({
      workspaceId: policy.workspaceId,
      entitlementId: policy.entitlementId,
      mode: policy.mode,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (cause) {
    throw new InternalAiAnswerQuotaError("quota_store_failure", { cause });
  }
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
  // Existing reservations must remain finalizable if the launch flag or active
  // entitlement changes after reservation. Only the database is required here.
  assertAiAnswerDatabaseConfigured();
  const reservation = await findAuthorizedAiAnswerReservation(input);
  const scope = {
    workspaceId: reservation.workspaceId,
    entitlementId: reservation.entitlementId,
    mode: reservation.mode,
    reservationId: input.reservationId,
  };
  let result:
    | Awaited<ReturnType<typeof commitStartpilotAiAnswerUsage>>
    | Awaited<ReturnType<typeof releaseStartpilotAiAnswerUsage>>;
  try {
    result =
      input.outcome === "committed"
        ? await commitStartpilotAiAnswerUsage(scope)
        : await releaseStartpilotAiAnswerUsage(scope);
  } catch (cause) {
    throw new InternalAiAnswerQuotaError("finalization_store_failure", {
      cause,
    });
  }
  const finalized = "committed" in result ? result.committed : result.released;
  if (!finalized) {
    throw new InternalAiAnswerQuotaError("reservation_not_finalized");
  }
  return { status: "finalized" };
}

async function findAuthorizedAiAnswerReservation(input: {
  pageId: string;
  reservationId: string;
}): Promise<{
  workspaceId: number;
  entitlementId: number;
  mode: "test" | "live";
}> {
  const pageId = input.pageId.trim();
  if (!pageId) {
    throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
  }

  try {
    const database = await getDatabaseOrThrow();
    const rows = await database
      .select({
        workspaceId: workspaceEntitlementUsageReservations.workspaceId,
        entitlementId: workspaceEntitlementUsageReservations.entitlementId,
        mode: workspaceEntitlementUsageReservations.mode,
      })
      .from(workspaceEntitlementUsageReservations)
      .innerJoin(
        channelConnections,
        and(
          eq(
            channelConnections.workspaceId,
            workspaceEntitlementUsageReservations.workspaceId
          ),
          eq(channelConnections.channel, "facebook_messenger"),
          eq(channelConnections.externalId, pageId)
        )
      )
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.reservationId,
            input.reservationId
          ),
          eq(workspaceEntitlementUsageReservations.kind, "ai_answer")
        )
      )
      .limit(1);
    if (!rows[0]) {
      throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
    }
    return rows[0];
  } catch (cause) {
    if (cause instanceof InternalAiAnswerQuotaError) throw cause;
    throw new InternalAiAnswerQuotaError("reservation_lookup_failed", {
      cause,
    });
  }
}
