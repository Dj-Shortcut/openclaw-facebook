import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  channelConnections,
  workspaceEntitlements,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import { STARTPILOT_PLAN_CODE } from "./billing/catalog";
import { isMollieEntitlementEnforcementEnabled } from "./billing/config";
import { parseStartpilotQuota } from "./billing/entitlementUsageStore";

const STARTPILOT_IMAGE_TOTAL_LIMIT = 20;
const STARTPILOT_IMAGE_DAILY_LIMIT = 5;
const STARTPILOT_IMAGE_MODEL = "gpt-image-2";

export type StartpilotRuntimePolicy = Readonly<{
  kind: "startpilot";
  workspaceId: number;
  entitlementId: number;
  mode: "test" | "live";
  imageTotalLimit: number;
  imageDailyLimit: number;
  imageModel: typeof STARTPILOT_IMAGE_MODEL;
  imageQuality: "high";
}>;

export type WorkspaceRuntimePolicy =
  Readonly<{ kind: "free" }> | StartpilotRuntimePolicy;

export type MessengerGenerationOwnership = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  pageId: string;
}>;

type ActiveEntitlement = {
  id: number;
  workspaceId: number;
  mode: "test" | "live";
  planCode: string;
  quota: unknown;
};

type WorkspaceEntitlementRuntimeDeps = {
  findWorkspaceIdsByFacebookPage(pageId: string): Promise<number[]>;
  findActiveEntitlement(
    workspaceId: number,
    mode: "test" | "live",
    now: Date
  ): Promise<ActiveEntitlement | null>;
};

export class WorkspaceEntitlementLookupError extends Error {
  constructor(message = "Workspace entitlement lookup failed") {
    super(message);
    this.name = "WorkspaceEntitlementLookupError";
  }
}

export class WorkspaceEntitlementConfigurationError extends Error {
  constructor(message = "Workspace entitlement is not safely configured") {
    super(message);
    this.name = "WorkspaceEntitlementConfigurationError";
  }
}

function runtimeBillingMode(): "test" | "live" {
  const mode = process.env.MOLLIE_MODE?.trim();
  if (mode === "test" || mode === "live") {
    return mode;
  }
  throw new WorkspaceEntitlementConfigurationError(
    "MOLLIE_MODE must be test or live for workspace entitlement lookup"
  );
}

function toStartpilotPolicy(
  entitlement: ActiveEntitlement
): StartpilotRuntimePolicy {
  if (!parseStartpilotQuota(entitlement.quota)) {
    throw new WorkspaceEntitlementConfigurationError(
      "Startpilot quota does not match the launch catalog"
    );
  }

  return Object.freeze({
    kind: "startpilot",
    workspaceId: entitlement.workspaceId,
    entitlementId: entitlement.id,
    mode: entitlement.mode,
    imageTotalLimit: STARTPILOT_IMAGE_TOTAL_LIMIT,
    imageDailyLimit: STARTPILOT_IMAGE_DAILY_LIMIT,
    imageModel: STARTPILOT_IMAGE_MODEL,
    imageQuality: "high",
  });
}

export async function resolveWorkspaceRuntimePolicyWithDeps(
  pageId: string | undefined,
  deps: WorkspaceEntitlementRuntimeDeps,
  now = new Date()
): Promise<WorkspaceRuntimePolicy> {
  const normalizedPageId = pageId?.trim();
  if (!normalizedPageId) {
    return { kind: "free" };
  }

  let workspaceIds: number[];
  try {
    workspaceIds = await deps.findWorkspaceIdsByFacebookPage(normalizedPageId);
  } catch {
    throw new WorkspaceEntitlementLookupError();
  }

  const uniqueWorkspaceIds = Array.from(new Set(workspaceIds));
  if (uniqueWorkspaceIds.length === 0) {
    return { kind: "free" };
  }
  if (uniqueWorkspaceIds.length !== 1) {
    throw new WorkspaceEntitlementLookupError(
      "Facebook Page is linked to multiple workspaces"
    );
  }

  const mode = runtimeBillingMode();
  let entitlement: ActiveEntitlement | null;
  try {
    entitlement = await deps.findActiveEntitlement(
      uniqueWorkspaceIds[0],
      mode,
      now
    );
  } catch {
    throw new WorkspaceEntitlementLookupError();
  }

  if (!entitlement) {
    return { kind: "free" };
  }
  if (entitlement.planCode !== STARTPILOT_PLAN_CODE) {
    throw new WorkspaceEntitlementConfigurationError(
      "Active paid plan is not supported by the runtime"
    );
  }

  return toStartpilotPolicy(entitlement);
}

const databaseRuntimeDeps: WorkspaceEntitlementRuntimeDeps = {
  async findWorkspaceIdsByFacebookPage(pageId) {
    const db = await getDatabaseOrThrow();
    const rows = await db
      .select({ workspaceId: channelConnections.workspaceId })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, "facebook_messenger"),
          eq(channelConnections.externalId, pageId)
        )
      )
      .limit(2);
    return rows.map(row => row.workspaceId);
  },

  async findActiveEntitlement(workspaceId, mode, now) {
    const db = await getDatabaseOrThrow();
    const rows = await db
      .select({
        id: workspaceEntitlements.id,
        workspaceId: workspaceEntitlements.workspaceId,
        mode: workspaceEntitlements.mode,
        planCode: workspaceEntitlements.planCode,
        quota: workspaceEntitlements.quota,
      })
      .from(workspaceEntitlements)
      .where(
        and(
          eq(workspaceEntitlements.workspaceId, workspaceId),
          eq(workspaceEntitlements.mode, mode),
          or(
            eq(workspaceEntitlements.status, "active"),
            eq(workspaceEntitlements.status, "grace")
          ),
          or(
            isNull(workspaceEntitlements.validUntil),
            gt(workspaceEntitlements.validUntil, now)
          )
        )
      )
      .orderBy(desc(workspaceEntitlements.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  },
};

/**
 * Resolves paid behavior only when the inbound Page has one owning workspace.
 * With no configured database, legacy/free calls remain unchanged. Once a
 * database is configured, lookup failures throw so paid calls cannot fail open.
 */
export async function resolveWorkspaceRuntimePolicy(
  pageId: string | undefined,
  now = new Date()
): Promise<WorkspaceRuntimePolicy> {
  if (!isMollieEntitlementEnforcementEnabled()) {
    return { kind: "free" };
  }
  if (
    !process.env.DATABASE_URL?.trim() &&
    process.env.NODE_ENV !== "production" &&
    !process.env.REDIS_URL?.trim()
  ) {
    return { kind: "free" };
  }
  return await resolveWorkspaceRuntimePolicyWithDeps(
    pageId,
    databaseRuntimeDeps,
    now
  );
}

export async function resolveMessengerGenerationOwnership(
  pageId: string | undefined
): Promise<MessengerGenerationOwnership | null> {
  if (
    !process.env.DATABASE_URL?.trim() &&
    process.env.NODE_ENV !== "production" &&
    !process.env.REDIS_URL?.trim()
  ) {
    return null;
  }
  const normalizedPageId = pageId?.trim();
  if (!normalizedPageId) {
    throw new WorkspaceEntitlementLookupError(
      "Messenger generation requires a receiving Page"
    );
  }
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      workspaceId: channelConnections.workspaceId,
      channelConnectionId: channelConnections.id,
      bindingEpoch: channelConnections.bindingEpoch,
    })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, "facebook_messenger"),
        eq(channelConnections.externalId, normalizedPageId),
        eq(channelConnections.status, "connected")
      )
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new WorkspaceEntitlementLookupError(
      "Messenger Page ownership is unavailable"
    );
  }
  return Object.freeze({
    workspaceId: rows[0].workspaceId,
    channelConnectionId: rows[0].channelConnectionId,
    bindingEpoch: rows[0].bindingEpoch,
    pageId: normalizedPageId,
  });
}

export async function assertMessengerGenerationOwnership(input: {
  pageId?: string;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
}): Promise<void> {
  if (
    !process.env.DATABASE_URL?.trim() &&
    process.env.NODE_ENV !== "production" &&
    !process.env.REDIS_URL?.trim()
  ) {
    return;
  }
  const ownership = await resolveMessengerGenerationOwnership(input.pageId);
  if (
    !ownership ||
    ownership.workspaceId !== input.workspaceId ||
    ownership.channelConnectionId !== input.channelConnectionId ||
    ownership.bindingEpoch !== input.bindingEpoch
  ) {
    throw new WorkspaceEntitlementLookupError(
      "Messenger generation ownership changed after enqueue"
    );
  }
}

export const STARTPILOT_RUNTIME_LIMITS = Object.freeze({
  imageTotal: STARTPILOT_IMAGE_TOTAL_LIMIT,
  imageDaily: STARTPILOT_IMAGE_DAILY_LIMIT,
});
