import {
  desc,
  eq,
  and,
  gt,
  inArray,
  isNull,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import type { RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";
import {
  aiIdentities,
  auditLog,
  billingIntents,
  billingHandoffRecoveryEvents,
  billingOutbox,
  channelConnections,
  dailyQuota,
  InsertAiIdentity,
  InsertAuditLog,
  InsertChannelConnection,
  InsertPortalHandoffToken,
  InsertUser,
  InsertWorkspace,
  InsertWorkspaceKnowledgeSource,
  InsertWorkspaceMember,
  InsertWorkspacePrivacySetting,
  InsertWorkspacePrivacyRequest,
  InsertWorkspaceUpgradeRequest,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
  portalHandoffTokens,
  users,
  workspaceMembers,
  workspacePrivacySettings,
  workspacePrivacyRequests,
  workspaceUpgradeRequests,
  workspaceKnowledgeSources,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
  workspaces,
  workspaceUsageDaily,
  type PortalHandoffToken,
  type Workspace,
  type WorkspaceMember,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import {
  ConversationIdentityError,
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
} from "./_core/conversationEndpoint";
import { safeLog } from "./_core/logger";
import {
  getBotTextRateLimitMax,
  getBotTextRateLimitWindowSeconds,
  getImageGenerationDailyLimit,
} from "./_core/quotaPolicy";
import { getBillingPlan, STARTPILOT_PLAN_CODE } from "./_core/billing/catalog";

let _db: ReturnType<typeof drizzle> | null = null;

type NamedLockRow = RowDataPacket & {
  acquired?: number | string | null;
  released?: number | string | null;
};

function logDatabaseUnavailable(operation: string): void {
  safeLog("database_unavailable", {
    level: "warn",
    operation,
  });
}

// Lazily create the drizzle instance so local tooling can run without a DB.
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      safeLog("database_connect_failed", {
        level: "warn",
        error,
      });
      _db = null;
    }
  }
  await Promise.resolve();
  return _db;
}

/**
 * Financial writes must fail closed. Billing modules use this accessor instead
 * of the non-financial helpers that can return development fallbacks.
 */
export async function getDatabaseOrThrow() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable for billing operation");
  }
  return db;
}

/**
 * Closes the lazily-created mysql2 pool used by bounded one-off processes.
 * Long-running servers keep the pool for their full process lifetime.
 */
export async function closeDatabasePool(): Promise<void> {
  const db = _db;
  _db = null;
  if (!db) return;
  await db.$client.promise().end();
}

type ImageGenDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type ImageGenTransaction = Parameters<
  Parameters<ImageGenDatabase["transaction"]>[0]
>[0];

export type MessengerPrivacyIdentityFence = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
  privacyEpoch: number;
  pageId: string;
}>;

/**
 * Serializes identity-bearing SQL writes with Messenger erasure. The subject
 * row is always locked before any intent, outbox, or handoff-token row.
 */
export async function lockActiveMessengerPrivacyIdentity(
  tx: ImageGenTransaction,
  input: MessengerPrivacyIdentityFence
): Promise<void> {
  const pageId = input.pageId.trim();
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    !Number.isSafeInteger(input.channelConnectionId) ||
    input.channelConnectionId <= 0 ||
    !Number.isSafeInteger(input.privacyEpoch) ||
    input.privacyEpoch <= 0 ||
    !/^[A-Za-z0-9:_-]{16,96}$/.test(input.userKey) ||
    !pageId ||
    pageId.length > 160
  ) {
    throw new Error("Exact Messenger privacy identity fence is required");
  }

  const subjects = await tx
    .select({ id: messengerPrivacySubjects.id })
    .from(messengerPrivacySubjects)
    .where(
      and(
        eq(messengerPrivacySubjects.workspaceId, input.workspaceId),
        eq(
          messengerPrivacySubjects.channelConnectionId,
          input.channelConnectionId
        ),
        eq(messengerPrivacySubjects.userKey, input.userKey),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch),
        eq(messengerPrivacySubjects.status, "active")
      )
    )
    .limit(1)
    .for("update");
  if (!subjects[0]) {
    throw new Error("Messenger privacy identity is no longer active");
  }

  const connections = await tx
    .select({ id: channelConnections.id })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, input.channelConnectionId),
        eq(channelConnections.workspaceId, input.workspaceId),
        eq(channelConnections.channel, "facebook_messenger"),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.externalId, pageId)
      )
    )
    .limit(1)
    .for("update");
  if (!connections[0]) {
    throw new Error("Messenger Page privacy identity binding is unavailable");
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("upsert_user");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    safeLog("database_upsert_user_failed", {
      level: "error",
      error,
    });
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_user_by_open_id");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getOrCreateUserWorkspace(user: {
  id: number;
  name?: string | null;
}) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_or_create_user_workspace");
    throw new Error("Database unavailable: workspace was not loaded");
  }

  const existing = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, user.id))
    .orderBy(desc(workspaceMembers.id))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const workspaceValues: InsertWorkspace = {
    name: user.name ? `${user.name}'s workspace` : "Leaderbot workspace",
    slug: `workspace-${user.id}`,
  };
  await db
    .insert(workspaces)
    .values(workspaceValues)
    .onDuplicateKeyUpdate({
      set: { slug: workspaceValues.slug },
    });

  const created = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, workspaceValues.slug))
    .limit(1);

  const workspace = created[0];
  if (!workspace) {
    throw new Error("Workspace was not persisted");
  }
  const memberValues: InsertWorkspaceMember = {
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
  };
  await db
    .insert(workspaceMembers)
    .values(memberValues)
    .onDuplicateKeyUpdate({
      set: { workspaceId: memberValues.workspaceId },
    });
  await seedWorkspacePrivacyDefaults(workspace.id);

  return workspace;
}

export async function getWorkspaceById(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_by_id");
    throw new Error("Database unavailable: workspace was not loaded");
  }

  const result = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return result[0] ?? null;
}

export async function addWorkspaceMember(values: InsertWorkspaceMember) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("add_workspace_member");
    throw new Error(
      "Database unavailable: workspace membership was not persisted"
    );
  }

  await db
    .insert(workspaceMembers)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        role: values.role ?? "member",
      },
    });
  await seedWorkspacePrivacyDefaults(values.workspaceId);

  const membership = await getWorkspaceMembership(
    values.workspaceId,
    values.userId
  );
  if (!membership) {
    throw new Error(
      "Workspace membership insert succeeded but read-back failed"
    );
  }

  return membership;
}

async function seedWorkspacePrivacyDefaults(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("seed_workspace_privacy_defaults");
    return;
  }

  const defaults: InsertWorkspacePrivacySetting = {
    workspaceId,
    allowKnowledgeIndexing:
      DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowKnowledgeIndexing ? 1 : 0,
    allowUsageAnalytics: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowUsageAnalytics
      ? 1
      : 0,
    imageMemoryRetentionDays:
      DEFAULT_WORKSPACE_PRIVACY_SETTINGS.imageMemoryRetentionDays,
  };

  await db
    .insert(workspacePrivacySettings)
    .values(defaults)
    .onDuplicateKeyUpdate({
      set: {
        workspaceId,
      },
    });
}

export async function getWorkspaceMembership(
  workspaceId: number,
  userId: number
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_membership");
    throw new Error(
      "Database unavailable: workspace membership was not loaded"
    );
  }

  const result = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  return result[0] ?? null;
}

export async function listWorkspaceMembers(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_members");
    throw new Error("Database unavailable: workspace members were not loaded");
  }

  return db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}

export async function updateWorkspace(
  workspaceId: number,
  values: { name: string }
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_workspace");
    return {
      id: workspaceId,
      name: values.name,
      slug: `workspace-${workspaceId}`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  await db
    .update(workspaces)
    .set({ name: values.name })
    .where(eq(workspaces.id, workspaceId));

  const result = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return (
    result[0] ?? {
      id: workspaceId,
      name: values.name,
      slug: `workspace-${workspaceId}`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }
  );
}

export async function getOrCreateAiIdentity(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_or_create_ai_identity");
    return {
      id: workspaceId,
      workspaceId,
      name: "Leaderbot",
      instructions: "Help customers with clear, useful answers.",
      tone: "Helpful",
      language: "nl",
      modelDefault: "default",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  const existing = await db
    .select()
    .from(aiIdentities)
    .where(eq(aiIdentities.workspaceId, workspaceId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const values: InsertAiIdentity = {
    workspaceId,
    name: "Leaderbot",
    instructions: "Help customers with clear, useful answers.",
  };
  await db.insert(aiIdentities).values(values).onDuplicateKeyUpdate({
    set: { workspaceId },
  });

  const created = await db
    .select()
    .from(aiIdentities)
    .where(eq(aiIdentities.workspaceId, workspaceId))
    .limit(1);

  return created[0];
}

export async function updateAiIdentity(
  workspaceId: number,
  updates: Pick<
    InsertAiIdentity,
    "name" | "instructions" | "tone" | "language" | "modelDefault"
  >
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_ai_identity");
    return {
      id: workspaceId,
      workspaceId,
      createdAt: new Date(0),
      updatedAt: new Date(),
      ...updates,
      instructions: updates.instructions ?? null,
    };
  }

  await getOrCreateAiIdentity(workspaceId);
  await db
    .update(aiIdentities)
    .set(updates)
    .where(eq(aiIdentities.workspaceId, workspaceId));

  return getOrCreateAiIdentity(workspaceId);
}

export async function listChannelConnections(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_channel_connections");
    return [
      {
        id: workspaceId,
        workspaceId,
        channel: "facebook_messenger" as const,
        status: "disconnected" as const,
        externalId: null,
        providerAccountExternalId: null,
        displayName: null,
        encryptedAccessToken: null,
        bindingEpoch: 1,
        grantedScopes: null,
        lastCheckedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
  }

  const result = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.workspaceId, workspaceId));

  return result;
}

export async function getConnectedFacebookPageConnection(
  pageId: string,
  expected?: {
    workspaceId?: number | null;
    channelConnectionId?: number | null;
    bindingEpoch?: number | null;
  }
) {
  if (!pageId.trim()) {
    throw new Error("Facebook Page ID is required");
  }
  return getConnectedMetaChannelConnectionInternal(
    "facebook_messenger",
    pageId,
    expected,
    {
      operation: "get_connected_facebook_page_connection",
      unavailableMessage:
        "Database unavailable: Facebook Page binding was not loaded",
    }
  );
}

export async function getConnectedMetaChannelConnection(
  channel: "facebook_messenger" | "whatsapp",
  externalId: string,
  expected?: {
    workspaceId?: number | null;
    channelConnectionId?: number | null;
    bindingEpoch?: number | null;
  }
) {
  return getConnectedMetaChannelConnectionInternal(
    channel,
    externalId,
    expected,
    {
      operation: "get_connected_meta_channel_connection",
      unavailableMessage:
        "Database unavailable: Meta channel binding was not loaded",
    }
  );
}

async function getConnectedMetaChannelConnectionInternal(
  channel: "facebook_messenger" | "whatsapp",
  externalId: string,
  expected:
    | {
        workspaceId?: number | null;
        channelConnectionId?: number | null;
        bindingEpoch?: number | null;
      }
    | undefined,
  diagnostics: Readonly<{
    operation: string;
    unavailableMessage: string;
  }>
) {
  const normalizedExternalId = externalId.trim();
  if (!normalizedExternalId) {
    throw new Error("Meta channel external ID is required");
  }
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable(diagnostics.operation);
    throw new Error(diagnostics.unavailableMessage);
  }

  const matches = await db
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, channel),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.externalId, normalizedExternalId),
        ...(expected?.workspaceId != null
          ? [eq(channelConnections.workspaceId, expected.workspaceId)]
          : []),
        ...(expected?.channelConnectionId != null
          ? [eq(channelConnections.id, expected.channelConnectionId)]
          : []),
        ...(expected?.bindingEpoch != null
          ? [eq(channelConnections.bindingEpoch, expected.bindingEpoch)]
          : [])
      )
    )
    .limit(2);
  if (matches.length !== 1) {
    return null;
  }
  return matches[0];
}

type WorkspacePrivacySettingsRecord = {
  allowKnowledgeIndexing: number;
  allowUsageAnalytics: number;
  imageMemoryRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
};

type WorkspacePrivacySettingsModel = {
  allowKnowledgeIndexing: boolean;
  allowUsageAnalytics: boolean;
  imageMemoryRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
};

const DEFAULT_WORKSPACE_PRIVACY_SETTINGS: Omit<
  WorkspacePrivacySettingsModel,
  "createdAt" | "updatedAt"
> = {
  allowKnowledgeIndexing: true,
  allowUsageAnalytics: false,
  imageMemoryRetentionDays: 30,
};

function normalizeWorkspacePrivacySettings(
  record?: WorkspacePrivacySettingsRecord | null,
  fallbackBase = new Date()
): WorkspacePrivacySettingsModel {
  if (!record) {
    return {
      allowKnowledgeIndexing:
        DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowKnowledgeIndexing,
      allowUsageAnalytics:
        DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowUsageAnalytics,
      imageMemoryRetentionDays:
        DEFAULT_WORKSPACE_PRIVACY_SETTINGS.imageMemoryRetentionDays,
      createdAt: fallbackBase,
      updatedAt: fallbackBase,
    };
  }

  return {
    allowKnowledgeIndexing: record.allowKnowledgeIndexing === 1,
    allowUsageAnalytics: record.allowUsageAnalytics === 1,
    imageMemoryRetentionDays: record.imageMemoryRetentionDays,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function unwrapDriverResult(result: unknown): unknown {
  return Array.isArray(result) ? result[0] : result;
}

function getInsertedId(result: unknown, label: string): number {
  const driverResult = unwrapDriverResult(result);
  const insertId = (driverResult as { insertId?: unknown } | undefined)
    ?.insertId;

  if (
    typeof insertId === "number" &&
    Number.isSafeInteger(insertId) &&
    insertId > 0
  ) {
    return insertId;
  }

  if (typeof insertId === "bigint" && insertId > BigInt(0)) {
    const numericId = Number(insertId);
    if (Number.isSafeInteger(numericId)) {
      return numericId;
    }
  }

  if (typeof insertId === "string") {
    const numericId = Number(insertId);
    if (Number.isSafeInteger(numericId) && numericId > 0) {
      return numericId;
    }
  }

  throw new Error(`${label} insert did not return an id`);
}

function getAffectedRows(result: unknown): number {
  const driverResult = unwrapDriverResult(result);
  const affectedRows = (driverResult as { affectedRows?: unknown } | undefined)
    ?.affectedRows;

  if (typeof affectedRows === "number" && Number.isSafeInteger(affectedRows)) {
    return affectedRows;
  }

  if (typeof affectedRows === "bigint") {
    const numericRows = Number(affectedRows);
    return Number.isSafeInteger(numericRows) ? numericRows : 0;
  }

  if (typeof affectedRows === "string") {
    const numericRows = Number(affectedRows);
    return Number.isSafeInteger(numericRows) ? numericRows : 0;
  }

  return 0;
}

export async function listWorkspaceKnowledgeSources(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_knowledge_sources");
    throw new Error("Database unavailable: knowledge sources were not loaded");
  }

  const result = await db
    .select()
    .from(workspaceKnowledgeSources)
    .where(eq(workspaceKnowledgeSources.workspaceId, workspaceId))
    .orderBy(table => table.name);

  return result;
}

export async function registerWorkspaceKnowledgeSource(
  workspaceId: number,
  values: Pick<
    InsertWorkspaceKnowledgeSource,
    "sourceType" | "name" | "sourceReference"
  >
) {
  const db = await getDb();
  const now = new Date();
  const source: InsertWorkspaceKnowledgeSource = {
    workspaceId,
    sourceType: values.sourceType,
    name: values.name,
    sourceReference: values.sourceReference ?? null,
    status: "queued",
    itemCount: 0,
  };

  if (!db) {
    logDatabaseUnavailable("register_workspace_knowledge_source");
    return {
      id: workspaceId,
      ...source,
      lastIndexedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: now,
    };
  }

  await db
    .insert(workspaceKnowledgeSources)
    .values(source)
    .onDuplicateKeyUpdate({
      set: {
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        status: "queued",
        itemCount: 0,
        lastIndexedAt: null,
      },
    });

  const created = await db
    .select()
    .from(workspaceKnowledgeSources)
    .where(
      and(
        eq(workspaceKnowledgeSources.workspaceId, workspaceId),
        eq(workspaceKnowledgeSources.name, source.name)
      )
    )
    .limit(1);

  return (
    created[0] ?? {
      id: workspaceId,
      ...source,
      lastIndexedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: now,
    }
  );
}

export async function disableWorkspaceKnowledgeSource(
  workspaceId: number,
  sourceId: number
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("disable_workspace_knowledge_source");
    throw new Error("Database unavailable: knowledge source was not disabled");
  }

  await db
    .update(workspaceKnowledgeSources)
    .set({ status: "disabled" })
    .where(
      and(
        eq(workspaceKnowledgeSources.workspaceId, workspaceId),
        eq(workspaceKnowledgeSources.id, sourceId)
      )
    );

  const result = await db
    .select()
    .from(workspaceKnowledgeSources)
    .where(
      and(
        eq(workspaceKnowledgeSources.workspaceId, workspaceId),
        eq(workspaceKnowledgeSources.id, sourceId)
      )
    )
    .limit(1);

  if (!result[0]) {
    throw new Error("Knowledge source not found for workspace");
  }

  return result[0];
}

export async function getWorkspaceKnowledgeSummary(workspaceId: number) {
  const sources = await listWorkspaceKnowledgeSources(workspaceId);
  const activeSources = sources.filter(source => source.status === "active");
  return {
    workspaceId,
    totalSources: sources.length,
    activeSources: activeSources.length,
    lastUpdate:
      sources.reduce(
        (last: Date | null, source) => {
          if (!source.updatedAt || (last && source.updatedAt <= last)) {
            return last;
          }
          return source.updatedAt;
        },
        null as Date | null
      ) ?? new Date(0),
    sources,
  };
}

export async function getWorkspacePrivacySettings(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_privacy_settings");
    return {
      workspaceId,
      ...DEFAULT_WORKSPACE_PRIVACY_SETTINGS,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  const existing = await db
    .select()
    .from(workspacePrivacySettings)
    .where(eq(workspacePrivacySettings.workspaceId, workspaceId))
    .limit(1);

  const record = existing[0];
  if (record) {
    return {
      workspaceId,
      ...normalizeWorkspacePrivacySettings(record, record.createdAt),
    };
  }

  return {
    workspaceId,
    ...normalizeWorkspacePrivacySettings(undefined, new Date(0)),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function updateWorkspacePrivacySettings(
  workspaceId: number,
  updates: {
    allowKnowledgeIndexing: boolean;
    allowUsageAnalytics: boolean;
    imageMemoryRetentionDays: number;
  }
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_workspace_privacy_settings");
    return {
      workspaceId,
      ...updates,
      createdAt: new Date(0),
      updatedAt: new Date(),
    };
  }

  const values: InsertWorkspacePrivacySetting = {
    workspaceId,
    allowKnowledgeIndexing: updates.allowKnowledgeIndexing ? 1 : 0,
    allowUsageAnalytics: updates.allowUsageAnalytics ? 1 : 0,
    imageMemoryRetentionDays: updates.imageMemoryRetentionDays,
  };

  await db
    .insert(workspacePrivacySettings)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        allowKnowledgeIndexing: values.allowKnowledgeIndexing,
        allowUsageAnalytics: values.allowUsageAnalytics,
        imageMemoryRetentionDays: values.imageMemoryRetentionDays,
      },
    });

  return getWorkspacePrivacySettings(workspaceId);
}

export async function listWorkspacePrivacyRequests(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_privacy_requests");
    throw new Error("Database unavailable: privacy requests were not loaded");
  }

  const result = await db
    .select()
    .from(workspacePrivacyRequests)
    .where(eq(workspacePrivacyRequests.workspaceId, workspaceId))
    .orderBy(desc(workspacePrivacyRequests.id));

  return result;
}

export async function createWorkspacePrivacyRequest(
  workspaceId: number,
  userId: number,
  values: Pick<InsertWorkspacePrivacyRequest, "requestType" | "note">,
  audit?: Pick<InsertAuditLog, "event" | "metadata">
) {
  const db = await getDb();
  const request: InsertWorkspacePrivacyRequest = {
    workspaceId,
    userId,
    requestType: values.requestType,
    note: values.note ?? null,
    status: "requested",
  };

  if (!db) {
    logDatabaseUnavailable("create_workspace_privacy_request");
    throw new Error("Database unavailable: privacy request was not persisted");
  }

  return db.transaction(async tx => {
    const insertResult = await tx
      .insert(workspacePrivacyRequests)
      .values(request);
    const insertedId = getInsertedId(insertResult, "privacy request");

    if (audit) {
      await tx.insert(auditLog).values({
        workspaceId,
        userId,
        event: audit.event,
        metadata: audit.metadata,
      });
    }

    const created = await tx
      .select()
      .from(workspacePrivacyRequests)
      .where(eq(workspacePrivacyRequests.id, insertedId))
      .limit(1);

    if (!created[0]) {
      throw new Error("Privacy request insert succeeded but read-back failed");
    }

    return created[0];
  });
}

export async function listWorkspaceUpgradeRequests(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_upgrade_requests");
    throw new Error("Database unavailable: upgrade requests were not loaded");
  }

  return db
    .select()
    .from(workspaceUpgradeRequests)
    .where(eq(workspaceUpgradeRequests.workspaceId, workspaceId))
    .orderBy(desc(workspaceUpgradeRequests.id));
}

export async function createWorkspaceUpgradeRequest(
  workspaceId: number,
  userId: number,
  values: Pick<
    InsertWorkspaceUpgradeRequest,
    | "currentPlanName"
    | "billingStatus"
    | "upgradeReason"
    | "imagesRemainingToday"
    | "blockedToday"
    | "requestedPlanName"
  >,
  audit?: Pick<InsertAuditLog, "event" | "metadata">
) {
  const db = await getDb();
  const request: InsertWorkspaceUpgradeRequest = {
    workspaceId,
    userId,
    status: "requested",
    currentPlanName: values.currentPlanName,
    billingStatus: values.billingStatus,
    upgradeReason: values.upgradeReason ?? null,
    imagesRemainingToday: values.imagesRemainingToday,
    blockedToday: values.blockedToday,
    requestedPlanName: values.requestedPlanName,
  };

  if (!db) {
    logDatabaseUnavailable("create_workspace_upgrade_request");
    throw new Error("Database unavailable: upgrade request was not persisted");
  }

  return db.transaction(async tx => {
    const insertResult = await tx
      .insert(workspaceUpgradeRequests)
      .values(request);
    const insertedId = getInsertedId(insertResult, "upgrade request");

    if (audit) {
      await tx.insert(auditLog).values({
        workspaceId,
        userId,
        event: audit.event,
        metadata: audit.metadata,
      });
    }

    const created = await tx
      .select()
      .from(workspaceUpgradeRequests)
      .where(eq(workspaceUpgradeRequests.id, insertedId))
      .limit(1);

    if (!created[0]) {
      throw new Error("Upgrade request insert succeeded but read-back failed");
    }

    return created[0];
  });
}

export async function createPortalHandoffToken(
  values: InsertPortalHandoffToken
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("create_portal_handoff_token");
    throw new Error(
      "Database unavailable: portal handoff token was not persisted"
    );
  }

  return db.transaction(async tx => {
    await lockPortalHandoffIdentityBeforeWrite(tx, values);
    const insertResult = await tx.insert(portalHandoffTokens).values(values);
    const insertedId = getInsertedId(insertResult, "portal handoff token");

    const created = await tx
      .select()
      .from(portalHandoffTokens)
      .where(eq(portalHandoffTokens.id, insertedId))
      .limit(1);

    if (!created[0]) {
      throw new Error(
        "Portal handoff token insert succeeded but read-back failed"
      );
    }

    return created[0];
  });
}

/**
 * Idempotently persists a delivery token.  Callers that deterministically
 * derive the token from an outbox operation can retry an ambiguous Messenger
 * send without minting another claimable link.
 */
export async function createOrGetPortalHandoffToken(
  values: InsertPortalHandoffToken,
  now = new Date(),
  tokenHashForGeneration?: (generation: number) => string
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("create_or_get_portal_handoff_token");
    throw new Error(
      "Database unavailable: portal handoff token was not persisted"
    );
  }

  if (!values.deliveryIdempotencyKeyHash) {
    throw new Error("portal handoff delivery key hash is required");
  }
  return db.transaction(async tx => {
    await lockPortalHandoffIdentityBeforeWrite(tx, values);
    await tx
      .insert(portalHandoffTokens)
      .values(values)
      .onDuplicateKeyUpdate({
        set: { deliveryIdempotencyKeyHash: values.deliveryIdempotencyKeyHash },
      });
    const stored = await tx
      .select()
      .from(portalHandoffTokens)
      .where(
        eq(
          portalHandoffTokens.deliveryIdempotencyKeyHash,
          values.deliveryIdempotencyKeyHash!
        )
      )
      .limit(1)
      .for("update");
    const token = stored[0];
    if (!token)
      throw new Error(
        "Portal handoff token upsert succeeded but read-back failed"
      );
    const expectedTokenHash = tokenHashForGeneration
      ? tokenHashForGeneration(token.capabilityGeneration)
      : values.tokenHash;
    if (
      token.tokenHash !== expectedTokenHash ||
      token.workspaceId !== values.workspaceId ||
      token.purpose !== values.purpose
    ) {
      throw new Error("portal handoff delivery binding mismatch");
    }
    if (token.status === "consumed") {
      throw new Error("portal handoff delivery is no longer active");
    }
    if (
      token.status === "revoked" ||
      token.status === "expired" ||
      token.expiresAt.getTime() <= now.getTime()
    ) {
      const storedIdentityWasScrubbed =
        token.messengerSenderUserKey === null &&
        token.facebookPageId === null &&
        token.messengerChannelConnectionId === null &&
        token.messengerPrivacyEpoch === null;
      if (
        !storedIdentityWasScrubbed &&
        !portalHandoffIdentityMatches(token, values)
      ) {
        throw new Error("portal handoff delivery binding mismatch");
      }
      const capabilityGeneration = token.capabilityGeneration + 1;
      const tokenHash = tokenHashForGeneration?.(capabilityGeneration);
      if (!tokenHash) {
        throw new Error("portal handoff capability rotation is unavailable");
      }
      await tx
        .update(portalHandoffTokens)
        .set({
          status: "pending",
          expiresAt: values.expiresAt,
          capabilityGeneration,
          tokenHash,
          messengerSenderUserKey: values.messengerSenderUserKey ?? null,
          facebookPageId: values.facebookPageId ?? null,
          messengerChannelConnectionId:
            values.messengerChannelConnectionId ?? null,
          messengerPrivacyEpoch: values.messengerPrivacyEpoch ?? null,
        })
        .where(
          and(
            eq(portalHandoffTokens.id, token.id),
            eq(
              portalHandoffTokens.capabilityGeneration,
              token.capabilityGeneration
            )
          )
        );
      return {
        ...token,
        status: "pending" as const,
        expiresAt: values.expiresAt,
        capabilityGeneration,
        tokenHash,
        messengerSenderUserKey: values.messengerSenderUserKey ?? null,
        facebookPageId: values.facebookPageId ?? null,
        messengerChannelConnectionId:
          values.messengerChannelConnectionId ?? null,
        messengerPrivacyEpoch: values.messengerPrivacyEpoch ?? null,
      };
    }
    if (!portalHandoffIdentityMatches(token, values)) {
      throw new Error("portal handoff delivery binding mismatch");
    }
    if (token.status !== "pending")
      throw new Error("portal handoff delivery is no longer active");
    return token;
  });
}

function portalHandoffIdentityMatches(
  stored: Pick<
    PortalHandoffToken,
    | "messengerSenderUserKey"
    | "facebookPageId"
    | "messengerChannelConnectionId"
    | "messengerPrivacyEpoch"
  >,
  values: InsertPortalHandoffToken
): boolean {
  return (
    stored.messengerSenderUserKey === (values.messengerSenderUserKey ?? null) &&
    stored.facebookPageId === (values.facebookPageId ?? null) &&
    stored.messengerChannelConnectionId ===
      (values.messengerChannelConnectionId ?? null) &&
    stored.messengerPrivacyEpoch === (values.messengerPrivacyEpoch ?? null)
  );
}

async function lockPortalHandoffIdentityBeforeWrite(
  tx: ImageGenTransaction,
  values: InsertPortalHandoffToken
): Promise<void> {
  const identityValues = [
    values.messengerSenderUserKey,
    values.facebookPageId,
    values.messengerChannelConnectionId,
    values.messengerPrivacyEpoch,
  ];
  if (identityValues.every(value => value === null || value === undefined)) {
    return;
  }
  if (identityValues.some(value => value === null || value === undefined)) {
    throw new Error("Complete Messenger portal handoff identity is required");
  }
  await lockActiveMessengerPrivacyIdentity(tx, {
    workspaceId: values.workspaceId,
    channelConnectionId: values.messengerChannelConnectionId!,
    userKey: values.messengerSenderUserKey!,
    privacyEpoch: values.messengerPrivacyEpoch!,
    pageId: values.facebookPageId!,
  });
}

export async function getPortalHandoffTokenByHash(tokenHash: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_portal_handoff_token_by_hash");
    throw new Error(
      "Database unavailable: portal handoff token was not loaded"
    );
  }

  const result = await db
    .select()
    .from(portalHandoffTokens)
    .where(eq(portalHandoffTokens.tokenHash, tokenHash))
    .limit(1);

  return result[0] ?? null;
}

export async function markPortalHandoffTokenConsumed(tokenHash: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("mark_portal_handoff_token_consumed");
    throw new Error(
      "Database unavailable: portal handoff token was not consumed"
    );
  }

  const now = new Date();
  const result = await db
    .update(portalHandoffTokens)
    .set({
      status: "consumed",
      consumedAt: now,
    })
    .where(
      and(
        eq(portalHandoffTokens.tokenHash, tokenHash),
        eq(portalHandoffTokens.status, "pending")
      )
    );

  return getAffectedRows(result) > 0;
}

export type ClaimPortalHandoffTokenForUserResult =
  | {
      ok: true;
      workspace: Pick<
        Workspace,
        "id" | "name" | "slug" | "createdAt" | "updatedAt"
      >;
      membership: WorkspaceMember;
      purpose: PortalHandoffToken["purpose"];
      messengerSenderUserKey: string | null;
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "already_used"
        | "workspace_not_found"
        | "tenant_boundary";
    };

export async function claimPortalHandoffTokenForUser(input: {
  tokenHash: string;
  userId: number;
  role?: InsertWorkspaceMember["role"];
  now?: Date;
}): Promise<ClaimPortalHandoffTokenForUserResult> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("claim_portal_handoff_token_for_user");
    throw new Error(
      "Database unavailable: portal handoff token was not claimed"
    );
  }

  const now = input.now ?? new Date();
  const role = input.role ?? "owner";

  return db.transaction(async tx => {
    const tokens = await tx
      .select()
      .from(portalHandoffTokens)
      .where(eq(portalHandoffTokens.tokenHash, input.tokenHash))
      .limit(1)
      .for("update");
    const stored = tokens[0];

    if (!stored) {
      return { ok: false, reason: "invalid" };
    }

    if (stored.status !== "pending") {
      return { ok: false, reason: "already_used" };
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" };
    }

    const workspaceRows = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, stored.workspaceId))
      .limit(1)
      .for("update");
    const workspace = workspaceRows[0];

    if (!workspace) {
      return { ok: false, reason: "workspace_not_found" };
    }

    if (!stored.facebookPageId) {
      return { ok: false, reason: "tenant_boundary" };
    }

    const connectedPages = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.workspaceId, stored.workspaceId),
          eq(channelConnections.channel, "facebook_messenger"),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.externalId, stored.facebookPageId)
        )
      )
      .limit(2)
      .for("update");

    if (connectedPages.length !== 1) {
      return { ok: false, reason: "tenant_boundary" };
    }

    let priorClaim:
      { minUserId: number | null; maxUserId: number | null } | undefined;
    if (stored.messengerSenderUserKey) {
      const priorClaims = await tx
        .select({
          minUserId: sql<
            number | null
          >`MIN(${portalHandoffTokens.claimedByUserId})`,
          maxUserId: sql<
            number | null
          >`MAX(${portalHandoffTokens.claimedByUserId})`,
        })
        .from(portalHandoffTokens)
        .where(
          and(
            eq(portalHandoffTokens.workspaceId, stored.workspaceId),
            eq(portalHandoffTokens.facebookPageId, stored.facebookPageId),
            eq(
              portalHandoffTokens.messengerSenderUserKey,
              stored.messengerSenderUserKey
            ),
            eq(portalHandoffTokens.status, "consumed"),
            isNotNull(portalHandoffTokens.claimedByUserId)
          )
        );
      priorClaim = priorClaims[0];
    }
    if (
      priorClaim?.minUserId != null &&
      priorClaim.maxUserId != null &&
      priorClaim.minUserId !== priorClaim.maxUserId
    ) {
      return { ok: false, reason: "invalid" };
    }
    const restrictedUserId = priorClaim?.minUserId ?? null;
    const isRestrictedReentry = restrictedUserId != null;
    if (isRestrictedReentry && restrictedUserId !== input.userId) {
      return { ok: false, reason: "invalid" };
    }

    let membership: WorkspaceMember | undefined;
    if (isRestrictedReentry) {
      const memberships = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, stored.workspaceId),
            eq(workspaceMembers.userId, input.userId)
          )
        )
        .limit(1)
        .for("update");
      membership = memberships[0];
      if (!membership) {
        return { ok: false, reason: "invalid" };
      }
    }

    const consumeResult = await tx
      .update(portalHandoffTokens)
      .set({
        status: "consumed",
        consumedAt: now,
        claimedByUserId: input.userId,
      })
      .where(
        and(
          eq(portalHandoffTokens.tokenHash, input.tokenHash),
          eq(portalHandoffTokens.status, "pending")
        )
      );

    if (getAffectedRows(consumeResult) === 0) {
      return { ok: false, reason: "already_used" };
    }

    if (!isRestrictedReentry) {
      const memberValues: InsertWorkspaceMember = {
        workspaceId: stored.workspaceId,
        userId: input.userId,
        role,
      };
      await tx
        .insert(workspaceMembers)
        .values(memberValues)
        .onDuplicateKeyUpdate({
          set: {
            // A handoff proves control of this one onboarding link; it must not
            // silently change privileges that were assigned through a separate
            // workspace-membership workflow. New claims receive the onboarding
            // role, while an existing member keeps their current role.
            workspaceId: stored.workspaceId,
          },
        });
    }

    const privacyDefaults: InsertWorkspacePrivacySetting = {
      workspaceId: stored.workspaceId,
      allowKnowledgeIndexing:
        DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowKnowledgeIndexing ? 1 : 0,
      allowUsageAnalytics:
        DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowUsageAnalytics ? 1 : 0,
      imageMemoryRetentionDays:
        DEFAULT_WORKSPACE_PRIVACY_SETTINGS.imageMemoryRetentionDays,
    };
    await tx
      .insert(workspacePrivacySettings)
      .values(privacyDefaults)
      .onDuplicateKeyUpdate({
        set: {
          workspaceId: stored.workspaceId,
        },
      });

    if (!membership) {
      const memberships = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, stored.workspaceId),
            eq(workspaceMembers.userId, input.userId)
          )
        )
        .limit(1);
      membership = memberships[0];
    }

    if (!membership) {
      throw new Error(
        "Workspace membership insert succeeded but read-back failed"
      );
    }

    await tx.insert(auditLog).values({
      workspaceId: stored.workspaceId,
      userId: input.userId,
      event: "portal_handoff.claimed",
      metadata: {
        purpose: stored.purpose,
        source: "messenger_handoff",
        hasMessengerSenderUserKey: Boolean(stored.messengerSenderUserKey),
        membershipRole: membership.role,
      },
    });

    return {
      ok: true,
      workspace,
      membership,
      purpose: stored.purpose,
      messengerSenderUserKey: stored.messengerSenderUserKey,
    };
  });
}

export type PortalHandoffReentryBinding = {
  workspaceId: number;
  userId: number;
};

export async function findUniqueConnectedFacebookWorkspaceId(
  facebookPageId: string
): Promise<number | null> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("find_unique_connected_facebook_workspace");
    throw new Error(
      "Database unavailable: Facebook workspace was not resolved"
    );
  }

  const connections = await db
    .select({ workspaceId: channelConnections.workspaceId })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, "facebook_messenger"),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.externalId, facebookPageId)
      )
    )
    .limit(2);

  return connections.length === 1 ? connections[0].workspaceId : null;
}

export async function findPortalHandoffReentryBinding(input: {
  facebookPageId: string;
  messengerSenderUserKey: string;
}): Promise<PortalHandoffReentryBinding | null> {
  const workspaceId = await findUniqueConnectedFacebookWorkspaceId(
    input.facebookPageId
  );
  if (!workspaceId) return null;

  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("find_portal_handoff_reentry_binding");
    throw new Error(
      "Database unavailable: portal handoff binding was not resolved"
    );
  }

  const claims = await db
    .select({ userId: portalHandoffTokens.claimedByUserId })
    .from(portalHandoffTokens)
    .where(
      and(
        eq(portalHandoffTokens.workspaceId, workspaceId),
        eq(portalHandoffTokens.facebookPageId, input.facebookPageId),
        eq(
          portalHandoffTokens.messengerSenderUserKey,
          input.messengerSenderUserKey
        ),
        eq(portalHandoffTokens.status, "consumed"),
        isNotNull(portalHandoffTokens.claimedByUserId)
      )
    )
    .orderBy(desc(portalHandoffTokens.consumedAt), desc(portalHandoffTokens.id))
    .limit(1);
  const userId = claims[0]?.userId;
  if (!userId) return null;

  const memberships = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  return memberships.length === 1 ? { workspaceId, userId } : null;
}

export async function revokePortalHandoffToken(tokenHash: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("revoke_portal_handoff_token");
    throw new Error(
      "Database unavailable: portal handoff token was not revoked"
    );
  }

  const result = await db
    .update(portalHandoffTokens)
    .set({
      status: "revoked",
      messengerSenderUserKey: null,
      facebookPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
    })
    .where(
      and(
        eq(portalHandoffTokens.tokenHash, tokenHash),
        eq(portalHandoffTokens.status, "pending")
      )
    );

  return getAffectedRows(result) > 0;
}

export async function deletePortalHandoffTokensForMessengerUserKey(
  messengerSenderUserKey: string
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("delete_portal_handoff_tokens_for_messenger_user");
    if (process.env.NODE_ENV !== "production") {
      return 0;
    }
    throw new Error(
      "Database unavailable: portal handoff tokens were not deleted"
    );
  }

  const result = await db
    .delete(portalHandoffTokens)
    .where(
      eq(portalHandoffTokens.messengerSenderUserKey, messengerSenderUserKey)
    );

  return getAffectedRows(result);
}

export async function eraseBillingHandoffIdentity(
  workspaceId: number,
  messengerSenderUserKey: string,
  facebookPageId: string,
  exactScope?: Readonly<{
    channelConnectionId: number;
    maxPrivacyEpoch: number;
  }>
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("erase_billing_handoff_identity");
    if (process.env.NODE_ENV !== "production") return 0;
    throw new Error(
      "Database unavailable: billing handoff identity was not erased"
    );
  }
  const pageId = facebookPageId.trim();
  if (
    !Number.isSafeInteger(workspaceId) ||
    workspaceId <= 0 ||
    !pageId ||
    !messengerSenderUserKey ||
    (exactScope !== undefined &&
      (!Number.isSafeInteger(exactScope.channelConnectionId) ||
        exactScope.channelConnectionId <= 0 ||
        !Number.isSafeInteger(exactScope.maxPrivacyEpoch) ||
        exactScope.maxPrivacyEpoch <= 0))
  ) {
    throw new Error("Exact billing handoff erasure scope is required");
  }
  return db.transaction(async tx => {
    // Migration 0016 introduced the immutable connection/privacy columns as
    // nullable so the 0017 backfill can populate them. During that bounded
    // bridge, exact workspace + Page + user identity is still authoritative
    // for rows where both new scope columns are NULL. Never treat a partially
    // populated or mismatched non-NULL tuple as legacy.
    const exactIntentScope = exactScope
      ? or(
          and(
            eq(
              billingIntents.messengerChannelConnectionId,
              exactScope.channelConnectionId
            ),
            lte(
              billingIntents.messengerPrivacyEpoch,
              exactScope.maxPrivacyEpoch
            )
          ),
          and(
            isNull(billingIntents.messengerChannelConnectionId),
            isNull(billingIntents.messengerPrivacyEpoch)
          )
        )
      : undefined;
    const exactTokenScope = exactScope
      ? or(
          and(
            eq(
              portalHandoffTokens.messengerChannelConnectionId,
              exactScope.channelConnectionId
            ),
            lte(
              portalHandoffTokens.messengerPrivacyEpoch,
              exactScope.maxPrivacyEpoch
            )
          ),
          and(
            isNull(portalHandoffTokens.messengerChannelConnectionId),
            isNull(portalHandoffTokens.messengerPrivacyEpoch)
          )
        )
      : undefined;
    // Payment processing locks the intent before it can enqueue a handoff.
    // Keep the same order here so a concurrent paid snapshot either observes
    // the erased identity or commits its outbox row before we inspect it.
    const intentRows = await tx
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, workspaceId),
          eq(billingIntents.messengerSenderUserKey, messengerSenderUserKey),
          eq(billingIntents.messengerPageId, pageId),
          ...(exactIntentScope ? [exactIntentScope] : [])
        )
      )
      .orderBy(billingIntents.intentId)
      .for("update");
    const intentIds = intentRows.map(row => row.intentId);
    const payloadIntentId = sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.intentId'))`;
    const payloadChannelConnectionId = sql<
      string | null
    >`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerChannelConnectionId'))`;
    const payloadPrivacyEpoch = sql<
      string | null
    >`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerPrivacyEpoch'))`;
    const exactPayloadScope = exactScope
      ? or(
          and(
            sql`CAST(${payloadChannelConnectionId} AS UNSIGNED) = ${exactScope.channelConnectionId}`,
            sql`CAST(${payloadPrivacyEpoch} AS UNSIGNED) <= ${exactScope.maxPrivacyEpoch}`
          ),
          and(
            sql`${payloadChannelConnectionId} IS NULL`,
            sql`${payloadPrivacyEpoch} IS NULL`
          )
        )
      : undefined;
    const payloadIdentityScope = and(
      sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerSenderUserKey')) = ${messengerSenderUserKey}`,
      sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerPageId')) = ${pageId}`,
      ...(exactPayloadScope ? [exactPayloadScope] : [])
    );
    const outboxRows = await tx
      .select({
        id: billingOutbox.id,
        deliveryState: billingOutbox.deliveryState,
        intentId: payloadIntentId,
      })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "send_portal_handoff"),
          intentIds.length
            ? or(payloadIdentityScope, inArray(payloadIntentId, intentIds))
            : payloadIdentityScope
        )
      )
      .orderBy(billingOutbox.id)
      .for("update");
    if (outboxRows.some(row => row.deliveryState === "transport_started")) {
      throw new Error("Billing handoff delivery is in flight; retry erasure");
    }
    for (const row of outboxRows) {
      await tx
        .delete(billingHandoffRecoveryEvents)
        .where(
          and(
            eq(billingHandoffRecoveryEvents.outboxId, row.id),
            eq(billingHandoffRecoveryEvents.workspaceId, workspaceId)
          )
        );
      await tx
        .update(billingOutbox)
        .set({
          status: "failed",
          lockedAt: null,
          leaseToken: null,
          lastErrorCode: "privacy_erased",
          deliveryEpoch: sql`${billingOutbox.deliveryEpoch} + 1`,
          deliveryState: "idle",
          privacyErasedAt: new Date(),
          payload: { intentId: row.intentId, privacyErased: true },
        })
        .where(
          and(
            eq(billingOutbox.id, row.id),
            eq(billingOutbox.workspaceId, workspaceId)
          )
        );
    }
    if (intentIds.length) {
      await tx
        .update(billingIntents)
        .set({
          messengerSenderUserKey: null,
          messengerPageId: null,
          messengerChannelConnectionId: null,
          messengerPrivacyEpoch: null,
        })
        .where(
          and(
            eq(billingIntents.workspaceId, workspaceId),
            inArray(billingIntents.intentId, intentIds),
            eq(billingIntents.messengerSenderUserKey, messengerSenderUserKey),
            eq(billingIntents.messengerPageId, pageId),
            ...(exactIntentScope ? [exactIntentScope] : [])
          )
        );
    }
    await tx
      .delete(portalHandoffTokens)
      .where(
        and(
          eq(portalHandoffTokens.workspaceId, workspaceId),
          eq(
            portalHandoffTokens.messengerSenderUserKey,
            messengerSenderUserKey
          ),
          eq(portalHandoffTokens.facebookPageId, pageId),
          ...(exactTokenScope ? [exactTokenScope] : [])
        )
      );
    return outboxRows.length;
  });
}

export type BillingHandoffDeliveryFence = Readonly<{
  outboxId: number;
  workspaceId: number;
  mode: "test" | "live";
  leaseToken: string;
  deliveryEpoch: number;
}>;

export async function beginBillingHandoffDelivery(input: {
  outboxId: number;
  workspaceId: number;
  mode: "test" | "live";
  leaseToken: string;
  intentId: string;
  messengerSenderUserKey: string;
  messengerPageId: string;
  messengerChannelConnectionId: number;
  messengerPrivacyEpoch: number;
}): Promise<BillingHandoffDeliveryFence> {
  const db = await getDb();
  if (!db)
    throw new Error("Database unavailable: billing delivery was not fenced");
  return db.transaction(async tx => {
    // Privacy subject -> intent -> outbox is the shared order for every
    // identity-bearing handoff path.
    await lockActiveMessengerPrivacyIdentity(tx, {
      workspaceId: input.workspaceId,
      channelConnectionId: input.messengerChannelConnectionId,
      userKey: input.messengerSenderUserKey,
      privacyEpoch: input.messengerPrivacyEpoch,
      pageId: input.messengerPageId,
    });
    const intents = await tx
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.intentId, input.intentId),
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode),
          eq(billingIntents.status, "paid"),
          eq(
            billingIntents.messengerSenderUserKey,
            input.messengerSenderUserKey
          ),
          eq(billingIntents.messengerPageId, input.messengerPageId),
          eq(
            billingIntents.messengerChannelConnectionId,
            input.messengerChannelConnectionId
          ),
          eq(billingIntents.messengerPrivacyEpoch, input.messengerPrivacyEpoch)
        )
      )
      .limit(1)
      .for("update");
    if (!intents[0]) throw new Error("portal_handoff_identity_unavailable");
    const jobs = await tx
      .select({ deliveryEpoch: billingOutbox.deliveryEpoch })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.id, input.outboxId),
          eq(billingOutbox.workspaceId, input.workspaceId),
          eq(billingOutbox.mode, input.mode),
          eq(billingOutbox.status, "processing"),
          eq(billingOutbox.leaseToken, input.leaseToken),
          eq(billingOutbox.deliveryState, "idle"),
          sql`${billingOutbox.privacyErasedAt} IS NULL`
        )
      )
      .limit(1)
      .for("update");
    if (!jobs[0]) throw new Error("portal_handoff_delivery_fence_unavailable");
    const deliveryEpoch = jobs[0].deliveryEpoch + 1;
    await tx
      .update(billingOutbox)
      .set({ deliveryEpoch, deliveryState: "preparing" })
      .where(eq(billingOutbox.id, input.outboxId));
    return { ...input, outboxId: input.outboxId, deliveryEpoch };
  });
}

export async function advanceBillingHandoffDeliveryFence(
  fence: BillingHandoffDeliveryFence,
  state:
    | "preparing"
    | "transport_started"
    | "transport_succeeded"
    | "ambiguous"
    | "idle"
): Promise<boolean> {
  const db = await getDb();
  if (!db)
    throw new Error("Database unavailable: billing delivery fence failed");
  const updateFence = async (
    database: ImageGenDatabase | ImageGenTransaction
  ): Promise<boolean> => {
    const result = await database
      .update(billingOutbox)
      .set({ deliveryState: state })
      .where(
        and(
          eq(billingOutbox.id, fence.outboxId),
          eq(billingOutbox.workspaceId, fence.workspaceId),
          eq(billingOutbox.mode, fence.mode),
          eq(billingOutbox.leaseToken, fence.leaseToken),
          eq(billingOutbox.deliveryEpoch, fence.deliveryEpoch),
          sql`${billingOutbox.privacyErasedAt} IS NULL`
        )
      );
    return getAffectedRows(result) === 1;
  };

  if (state !== "transport_started") {
    return await updateFence(db);
  }

  // Migration 0017 rewrites privacy-bearing handoff payloads. The named lock
  // is held only while a writer makes transport irrevocable; the production
  // migrator holds the same lock across its final preflight and data repair.
  // A writer that encounters the migration fails closed and is retried without
  // starting the external Messenger transport.
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("Database unavailable: billing delivery fence failed");
  }
  const lockConnection = await mysql.createConnection(databaseUrl);
  let lockHeld = false;
  let result = false;
  let operationError: unknown;
  try {
    const [[acquired]] = await lockConnection.query<NamedLockRow[]>(
      "SELECT GET_LOCK(CONCAT('leaderbot:handoff:', LEFT(SHA2(DATABASE(), 256), 40)), 0) AS acquired"
    );
    if (Number(acquired?.acquired) === 1) {
      lockHeld = true;
      // Drizzle's update resolves only after the autocommit is durable, so the
      // migration cannot acquire the lock between the state write and commit.
      result = await updateFence(db);
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  if (lockHeld) {
    try {
      const [[released]] = await lockConnection.query<NamedLockRow[]>(
        "SELECT RELEASE_LOCK(CONCAT('leaderbot:handoff:', LEFT(SHA2(DATABASE(), 256), 40))) AS released"
      );
      if (Number(released?.released) !== 1) {
        cleanupError = new Error(
          "Billing handoff migration fence release failed"
        );
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await lockConnection.end();
  } catch (error) {
    cleanupError ??= error;
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Billing handoff delivery failed and migration fence cleanup failed",
      { cause: operationError }
    );
  }
  if (operationError) {
    throw operationError instanceof Error
      ? operationError
      : new Error("Billing handoff delivery failed", { cause: operationError });
  }
  if (cleanupError) {
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error("Billing handoff migration fence cleanup failed", {
          cause: cleanupError,
        });
  }
  return result;
}

export class ChannelConnectionClaimConflictError extends Error {
  constructor() {
    super("Channel connection is already claimed by another workspace");
    this.name = "ChannelConnectionClaimConflictError";
  }
}

export class ChannelConnectionAuthorizationError extends Error {
  constructor() {
    super("Channel connection authorization failed");
    this.name = "ChannelConnectionAuthorizationError";
  }
}

export class WhatsAppChannelConnectionMigrationRequiredError extends Error {
  constructor() {
    super("WhatsApp binding change requires an explicit migration");
    this.name = "WhatsAppChannelConnectionMigrationRequiredError";
  }
}

function normalizeChannelConnectionEndpoint(
  values: InsertChannelConnection
): Readonly<{
  externalId: string | null;
  providerAccountExternalId: string | null;
}> {
  if (values.status === "disconnected") {
    return Object.freeze({
      externalId: null,
      providerAccountExternalId: null,
    });
  }

  if (values.channel === "facebook_messenger") {
    if (
      values.providerAccountExternalId !== undefined &&
      values.providerAccountExternalId !== null
    ) {
      throw new ConversationIdentityError("invalid_input");
    }
    const endpoint = resolveMessengerEndpoint({ entryId: values.externalId });
    return Object.freeze({
      externalId: endpoint.pageId,
      providerAccountExternalId: null,
    });
  }

  if (values.channel === "whatsapp") {
    const endpoint = resolveWhatsAppEndpoint({
      wabaId: values.providerAccountExternalId,
      phoneNumberId: values.externalId,
    });
    return Object.freeze({
      externalId: endpoint.phoneNumberId,
      providerAccountExternalId: endpoint.wabaId,
    });
  }

  return Object.freeze({
    externalId: values.externalId?.trim() || null,
    providerAccountExternalId: null,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return databaseErrorChainSome(
    error,
    record => record.code === "ER_DUP_ENTRY" || record.errno === 1062
  );
}

function isRetryableDatabaseLockError(error: unknown): boolean {
  return databaseErrorChainSome(
    error,
    record =>
      record.code === "ER_LOCK_DEADLOCK" ||
      record.code === "ER_LOCK_WAIT_TIMEOUT" ||
      record.errno === 1213 ||
      record.errno === 1205
  );
}

function databaseErrorChainSome(
  error: unknown,
  predicate: (record: Record<string, unknown>) => boolean
): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (predicate(record)) return true;
    current = record.cause;
  }
  return false;
}

/**
 * Claims a provider account for one workspace and then writes its credentials.
 *
 * The provider identity has a global unique key (`channel`, `externalId`). Never
 * use an unscoped duplicate-key update here: a collision may belong to another
 * workspace and must fail closed instead of replacing that tenant's token.
 */
export async function upsertChannelConnection(
  values: InsertChannelConnection,
  options: Readonly<{
    auditLog?: InsertAuditLog;
    authorization?: Readonly<{
      actorUserId: number;
      allowedRoles: readonly WorkspaceMember["role"][];
    }>;
    updatePolicy?: "preserve_exact_whatsapp_binding";
  }> = {}
) {
  const { externalId, providerAccountExternalId } =
    normalizeChannelConnectionEndpoint(values);
  const preservesExactWhatsAppBinding =
    options.updatePolicy === "preserve_exact_whatsapp_binding";
  const exactWhatsAppEndpoint =
    preservesExactWhatsAppBinding && externalId && providerAccountExternalId
      ? Object.freeze({ externalId, providerAccountExternalId })
      : null;
  if (
    preservesExactWhatsAppBinding &&
    (values.channel !== "whatsapp" ||
      values.status !== "connected" ||
      !exactWhatsAppEndpoint)
  ) {
    throw new WhatsAppChannelConnectionMigrationRequiredError();
  }
  if (options.auditLog && options.auditLog.workspaceId !== values.workspaceId) {
    throw new Error("Channel connection audit workspace does not match");
  }
  if (
    options.auditLog &&
    options.authorization &&
    options.auditLog.userId !== options.authorization.actorUserId
  ) {
    throw new Error("Channel connection audit actor does not match");
  }
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("upsert_channel_connection");
    throw new Error("Database unavailable: channel connection was not saved");
  }

  const lastCheckedAt = new Date();
  const updateSet = {
    status: values.status,
    externalId,
    providerAccountExternalId,
    displayName: values.displayName ?? null,
    encryptedAccessToken: values.encryptedAccessToken ?? null,
    grantedScopes: values.grantedScopes ?? null,
    lastCheckedAt,
    bindingEpoch: sql`${channelConnections.bindingEpoch} + 1`,
  };

  const writeConnection = () =>
    db.transaction(async tx => {
      if (options.authorization) {
        const authorizedMemberships = await tx
          .select({ role: workspaceMembers.role })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspaceId, values.workspaceId),
              eq(workspaceMembers.userId, options.authorization.actorUserId)
            )
          )
          .limit(2)
          .for("update");
        if (
          authorizedMemberships.length !== 1 ||
          !options.authorization.allowedRoles.includes(
            authorizedMemberships[0].role
          )
        ) {
          throw new ChannelConnectionAuthorizationError();
        }
      }

      if (providerAccountExternalId) {
        const claimedProviderAccount = await tx
          .select({
            id: channelConnections.id,
            workspaceId: channelConnections.workspaceId,
          })
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.channel, values.channel),
              eq(
                channelConnections.providerAccountExternalId,
                providerAccountExternalId
              )
            )
          )
          .limit(1)
          .for("update");
        if (
          claimedProviderAccount[0] &&
          claimedProviderAccount[0].workspaceId !== values.workspaceId
        ) {
          throw new ChannelConnectionClaimConflictError();
        }
      }

      if (externalId) {
        const claimed = await tx
          .select({
            id: channelConnections.id,
            workspaceId: channelConnections.workspaceId,
          })
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.channel, values.channel),
              eq(channelConnections.externalId, externalId)
            )
          )
          .limit(1)
          .for("update");
        if (claimed[0] && claimed[0].workspaceId !== values.workspaceId) {
          throw new ChannelConnectionClaimConflictError();
        }
      }

      const existing = await tx
        .select({
          id: channelConnections.id,
          status: channelConnections.status,
          externalId: channelConnections.externalId,
          providerAccountExternalId:
            channelConnections.providerAccountExternalId,
        })
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.workspaceId, values.workspaceId),
            eq(channelConnections.channel, values.channel)
          )
        )
        .limit(1)
        .for("update");

      if (existing[0]) {
        if (preservesExactWhatsAppBinding) {
          if (!exactWhatsAppEndpoint) {
            throw new WhatsAppChannelConnectionMigrationRequiredError();
          }
          if (
            existing[0].status !== "connected" ||
            existing[0].externalId !== exactWhatsAppEndpoint.externalId ||
            existing[0].providerAccountExternalId !==
              exactWhatsAppEndpoint.providerAccountExternalId
          ) {
            throw new WhatsAppChannelConnectionMigrationRequiredError();
          }
          await tx
            .update(channelConnections)
            .set({
              encryptedAccessToken: values.encryptedAccessToken ?? null,
              grantedScopes: values.grantedScopes ?? null,
              lastCheckedAt,
            })
            .where(
              and(
                eq(channelConnections.id, existing[0].id),
                eq(channelConnections.workspaceId, values.workspaceId),
                eq(channelConnections.channel, "whatsapp"),
                eq(channelConnections.status, "connected"),
                eq(
                  channelConnections.externalId,
                  exactWhatsAppEndpoint.externalId
                ),
                eq(
                  channelConnections.providerAccountExternalId,
                  exactWhatsAppEndpoint.providerAccountExternalId
                )
              )
            );
        } else {
          const providerFenceNow = new Date();
          // Every external provider call is hard-bounded below the 15-minute
          // fence lease. Reconcile expired reservations/attempts while the
          // connection row is locked so a transient ambiguous upload cannot
          // block this Page binding forever, and no new attempt can race the
          // binding-epoch bump.
          await tx
            .update(messengerProviderAttemptFences)
            .set({
              status: "contained",
              completedAt: providerFenceNow,
              leaseUntil: providerFenceNow,
            })
            .where(
              and(
                eq(
                  messengerProviderAttemptFences.channelConnectionId,
                  existing[0].id
                ),
                inArray(messengerProviderAttemptFences.status, [
                  "reserved",
                  "started",
                  "ambiguous",
                ]),
                lte(messengerProviderAttemptFences.leaseUntil, providerFenceNow)
              )
            );
          const activeAttempts = await tx
            .select({ id: messengerProviderAttemptFences.id })
            .from(messengerProviderAttemptFences)
            .where(
              and(
                eq(
                  messengerProviderAttemptFences.channelConnectionId,
                  existing[0].id
                ),
                or(
                  inArray(messengerProviderAttemptFences.status, [
                    "started",
                    "ambiguous",
                  ]),
                  and(
                    eq(messengerProviderAttemptFences.status, "reserved"),
                    gt(messengerProviderAttemptFences.leaseUntil, new Date())
                  )
                )
              )
            )
            .limit(1)
            .for("update");
          if (activeAttempts[0]) {
            throw new Error(
              "Channel connection has an active provider attempt; retry later"
            );
          }
          if (values.channel === "facebook_messenger") {
            const activeAiDeliveries = await tx
              .select({
                reservationId:
                  workspaceEntitlementUsageReservations.reservationId,
              })
              .from(workspaceEntitlementUsageReservations)
              .where(
                and(
                  eq(
                    workspaceEntitlementUsageReservations.channelConnectionId,
                    existing[0].id
                  ),
                  eq(
                    workspaceEntitlementUsageReservations.workspaceId,
                    values.workspaceId
                  ),
                  eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
                  eq(workspaceEntitlementUsageReservations.status, "reserved"),
                  isNotNull(
                    workspaceEntitlementUsageReservations.deliveryStartedAt
                  ),
                  isNull(
                    workspaceEntitlementUsageReservations.deliveryKnownRejectedAt
                  )
                )
              )
              .limit(1)
              .for("update");
            if (activeAiDeliveries[0]) {
              throw new Error(
                "Channel connection has an active AI delivery; retry later"
              );
            }
          }
          await tx
            .update(channelConnections)
            .set(updateSet)
            .where(
              and(
                eq(channelConnections.id, existing[0].id),
                eq(channelConnections.workspaceId, values.workspaceId),
                eq(channelConnections.channel, values.channel)
              )
            );
        }
      } else {
        await tx.insert(channelConnections).values({
          ...values,
          externalId,
          providerAccountExternalId,
          lastCheckedAt,
          bindingEpoch: 1,
        });
      }

      if (options.auditLog) {
        await tx.insert(auditLog).values(options.auditLog);
      }
    });

  const maxWriteAttempts = 3;
  for (let attempt = 1; attempt <= maxWriteAttempts; attempt += 1) {
    try {
      await writeConnection();
      break;
    } catch (error) {
      if (
        error instanceof ChannelConnectionClaimConflictError ||
        error instanceof WhatsAppChannelConnectionMigrationRequiredError
      ) {
        throw error;
      }
      const canRetry = attempt < maxWriteAttempts;
      if (
        canRetry &&
        (isRetryableDatabaseLockError(error) || isDuplicateKeyError(error))
      ) {
        const retryDelayMs = 10 * attempt + Math.floor(Math.random() * 15);
        await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (isDuplicateKeyError(error)) {
        throw new Error(
          "Channel connection update could not be completed after concurrent writes"
        );
      }
      throw error;
    }
  }

  return listChannelConnections(values.workspaceId);
}

export async function disconnectChannelConnection(
  workspaceId: number,
  channel: "facebook_messenger" | "whatsapp" | "web"
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("disconnect_channel_connection");
    throw new Error(
      "Database unavailable: channel connection was not disconnected"
    );
  }

  await db.transaction(async tx => {
    const existing = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.workspaceId, workspaceId),
          eq(channelConnections.channel, channel)
        )
      )
      .limit(1)
      .for("update");

    const lastCheckedAt = new Date();
    if (!existing[0]) {
      await tx.insert(channelConnections).values({
        workspaceId,
        channel,
        status: "disconnected",
        externalId: null,
        providerAccountExternalId: null,
        displayName: null,
        encryptedAccessToken: null,
        grantedScopes: null,
        lastCheckedAt,
      });
      return;
    }

    const providerFenceNow = new Date();
    await tx
      .update(messengerProviderAttemptFences)
      .set({
        status: "contained",
        completedAt: providerFenceNow,
        leaseUntil: providerFenceNow,
      })
      .where(
        and(
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            existing[0].id
          ),
          inArray(messengerProviderAttemptFences.status, [
            "reserved",
            "started",
            "ambiguous",
          ]),
          lte(messengerProviderAttemptFences.leaseUntil, providerFenceNow)
        )
      );
    const activeAttempts = await tx
      .select({ id: messengerProviderAttemptFences.id })
      .from(messengerProviderAttemptFences)
      .where(
        and(
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            existing[0].id
          ),
          or(
            inArray(messengerProviderAttemptFences.status, [
              "started",
              "ambiguous",
            ]),
            and(
              eq(messengerProviderAttemptFences.status, "reserved"),
              gt(messengerProviderAttemptFences.leaseUntil, providerFenceNow)
            )
          )
        )
      )
      .limit(1)
      .for("update");
    if (activeAttempts[0]) {
      throw new Error(
        "Channel connection has an active provider attempt; retry later"
      );
    }
    if (channel === "facebook_messenger") {
      const activeAiDeliveries = await tx
        .select({
          reservationId: workspaceEntitlementUsageReservations.reservationId,
        })
        .from(workspaceEntitlementUsageReservations)
        .where(
          and(
            eq(
              workspaceEntitlementUsageReservations.channelConnectionId,
              existing[0].id
            ),
            eq(workspaceEntitlementUsageReservations.workspaceId, workspaceId),
            eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
            eq(workspaceEntitlementUsageReservations.status, "reserved"),
            isNotNull(workspaceEntitlementUsageReservations.deliveryStartedAt),
            isNull(
              workspaceEntitlementUsageReservations.deliveryKnownRejectedAt
            )
          )
        )
        .limit(1)
        .for("update");
      if (activeAiDeliveries[0]) {
        throw new Error(
          "Channel connection has an active AI delivery; retry later"
        );
      }
    }

    await tx
      .update(channelConnections)
      .set({
        status: "disconnected",
        externalId: null,
        providerAccountExternalId: null,
        displayName: null,
        encryptedAccessToken: null,
        bindingEpoch: sql`${channelConnections.bindingEpoch} + 1`,
        grantedScopes: null,
        lastCheckedAt,
      })
      .where(
        and(
          eq(channelConnections.id, existing[0].id),
          eq(channelConnections.workspaceId, workspaceId),
          eq(channelConnections.channel, channel)
        )
      );
  });

  return listChannelConnections(workspaceId);
}

export async function getWorkspaceUsageSummary(workspaceId: number) {
  const messageRateLimit = getBotTextRateLimitMax();
  const messageRateLimitWindowSeconds = getBotTextRateLimitWindowSeconds();

  const buildSummary = (
    usage?: {
      messageCount?: number | null;
      imageCount?: number | null;
      blockedCount?: number | null;
    },
    paidUsage?: {
      status: "active" | "grace";
      planName: string;
      imagesUsedToday: number;
      imagesUsedInPeriod: number;
      imagesPerDay: number;
      imagesPerPeriod: number;
    }
  ) => {
    const messageCount = usage?.messageCount ?? 0;
    const imageCount = paidUsage?.imagesUsedToday ?? usage?.imageCount ?? 0;
    const imageCountInPeriod = paidUsage?.imagesUsedInPeriod ?? null;
    const blockedCount = usage?.blockedCount ?? 0;
    const imageDailyLimit =
      paidUsage?.imagesPerDay ?? getImageGenerationDailyLimit();
    const imagePeriodLimit = paidUsage?.imagesPerPeriod ?? null;
    const imagesRemainingToday = Math.max(0, imageDailyLimit - imageCount);
    const imagesRemainingInPeriod =
      imagePeriodLimit === null || imageCountInPeriod === null
        ? null
        : Math.max(0, imagePeriodLimit - imageCountInPeriod);
    const isImageLimitReached =
      (imageDailyLimit > 0 && imagesRemainingToday === 0) ||
      (imagePeriodLimit !== null && imagesRemainingInPeriod === 0);

    return {
      workspaceId,
      period: "today" as const,
      plan: {
        name: paidUsage?.planName ?? "Free",
        billingStatus: paidUsage?.status ?? ("free" as const),
      },
      messageCount,
      imageCount,
      imageCountInPeriod,
      blockedCount,
      limits: {
        imagesPerDay: imageDailyLimit,
        imagesPerPeriod: imagePeriodLimit,
        messagesPerWindow: messageRateLimit,
        messageWindowSeconds: messageRateLimitWindowSeconds,
      },
      remaining: {
        imagesToday: imagesRemainingToday,
        imagesInPeriod: imagesRemainingInPeriod,
      },
      upgrade: {
        recommended: isImageLimitReached || blockedCount > 0,
        reason: isImageLimitReached
          ? "image_limit_reached"
          : blockedCount > 0
            ? "blocked_usage"
            : null,
      },
    };
  };

  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_usage_summary");
    return buildSummary();
  }

  const today = getTodayUTC();
  const dailyUsage = await db
    .select()
    .from(workspaceUsageDaily)
    .where(
      and(
        eq(workspaceUsageDaily.workspaceId, workspaceId),
        eq(workspaceUsageDaily.date, today)
      )
    )
    .limit(1);
  const mode = getUsageSummaryMollieMode();
  if (!mode) return buildSummary(dailyUsage[0]);

  const now = new Date();
  const entitlementRows = await db
    .select({
      id: workspaceEntitlements.id,
      status: workspaceEntitlements.status,
      planCode: workspaceEntitlements.planCode,
      quota: workspaceEntitlements.quota,
      sourceIntentId: workspaceEntitlements.sourceIntentId,
      validUntil: workspaceEntitlements.validUntil,
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
    .limit(2);
  if (entitlementRows.length === 0) return buildSummary(dailyUsage[0]);
  const entitlement = entitlementRows[0];
  if (
    entitlementRows.length !== 1 ||
    !entitlement ||
    (entitlement.status !== "active" && entitlement.status !== "grace") ||
    entitlement.planCode !== STARTPILOT_PLAN_CODE ||
    !entitlement.sourceIntentId ||
    !entitlement.validUntil
  ) {
    throw new Error("Workspace paid usage summary is inconsistent");
  }
  const plan = getBillingPlan(STARTPILOT_PLAN_CODE);
  const quota = exactStartpilotUsageQuota(entitlement.quota, plan);
  if (!plan || !quota) {
    throw new Error("Workspace paid usage summary is inconsistent");
  }
  const usageRows = await db
    .select({
      sourceIntentId: workspaceEntitlementUsage.sourceIntentId,
      planCode: workspaceEntitlementUsage.planCode,
      periodStartedAt: workspaceEntitlementUsage.periodStartedAt,
      periodEndsAt: workspaceEntitlementUsage.periodEndsAt,
      imagesUsed: workspaceEntitlementUsage.imagesUsed,
      imageUsageDate: workspaceEntitlementUsage.imageUsageDate,
      imagesUsedToday: workspaceEntitlementUsage.imagesUsedToday,
    })
    .from(workspaceEntitlementUsage)
    .where(
      and(
        eq(workspaceEntitlementUsage.workspaceId, workspaceId),
        eq(workspaceEntitlementUsage.mode, mode),
        eq(workspaceEntitlementUsage.entitlementId, entitlement.id),
        eq(workspaceEntitlementUsage.planCode, STARTPILOT_PLAN_CODE)
      )
    )
    .limit(2);
  const paidUsage = usageRows[0];
  if (
    usageRows.length !== 1 ||
    !paidUsage ||
    paidUsage.sourceIntentId !== entitlement.sourceIntentId ||
    paidUsage.planCode !== STARTPILOT_PLAN_CODE ||
    paidUsage.periodStartedAt.getTime() > now.getTime() ||
    paidUsage.periodEndsAt.getTime() !== entitlement.validUntil.getTime() ||
    paidUsage.periodEndsAt.getTime() <= now.getTime() ||
    !isBoundedUsageCounter(paidUsage.imagesUsed, quota.imagesTotal) ||
    !isBoundedUsageCounter(paidUsage.imagesUsedToday, quota.imagesPerDay)
  ) {
    throw new Error("Workspace paid usage summary is inconsistent");
  }

  return buildSummary(dailyUsage[0], {
    status: entitlement.status,
    planName: plan.publicName,
    imagesUsedToday:
      paidUsage.imageUsageDate === today ? paidUsage.imagesUsedToday : 0,
    imagesUsedInPeriod: paidUsage.imagesUsed,
    imagesPerDay: quota.imagesPerDay,
    imagesPerPeriod: quota.imagesTotal,
  });
}

function getUsageSummaryMollieMode(): "test" | "live" | null {
  const mode = process.env.MOLLIE_MODE?.trim();
  if (!mode) return null;
  if (mode === "test" || mode === "live") return mode;
  throw new Error("MOLLIE_MODE must be test or live for paid usage summary");
}

function exactStartpilotUsageQuota(
  value: unknown,
  plan: ReturnType<typeof getBillingPlan>
): { imagesTotal: number; imagesPerDay: number } | null {
  if (!plan || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const quota = value as Record<string, unknown>;
  const expected = plan.entitlements;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(quota).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index]) ||
    expectedKeys.some(key => quota[key] !== expected[key]) ||
    !Number.isSafeInteger(quota.imagesTotal) ||
    !Number.isSafeInteger(quota.imagesPerDay)
  ) {
    return null;
  }
  return {
    imagesTotal: Number(quota.imagesTotal),
    imagesPerDay: Number(quota.imagesPerDay),
  };
}

function isBoundedUsageCounter(value: number, limit: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= limit;
}

export async function insertAuditLog(values: InsertAuditLog) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("insert_audit_log");
    return null;
  }

  return db.insert(auditLog).values(values);
}

/**
 * Get today's date in UTC format (YYYY-MM-DD)
 */
function getTodayUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Check if a user can generate an image today (has quota remaining)
 */
export async function canUserGenerateImage(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("check_quota");
    return false;
  }

  const today = getTodayUTC();
  const quota = await db
    .select()
    .from(dailyQuota)
    .where(and(eq(dailyQuota.userId, userId), eq(dailyQuota.date, today)))
    .limit(1);

  if (quota.length === 0) {
    return true; // No quota record yet, user can generate
  }

  return quota[0].imagesGenerated < getImageGenerationDailyLimit();
}
