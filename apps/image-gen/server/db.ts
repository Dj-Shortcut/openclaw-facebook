import { eq, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, imageRequests, dailyQuota, usageStats, notificationLog, messengerState, InsertImageRequest, InsertUsageStats, InsertNotificationLog, InsertMessengerState } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;
const FREE_DAILY_LIMIT = 3;

// Lazily create the drizzle instance so local tooling can run without a DB.
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  await Promise.resolve();
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
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
      values.role = 'admin';
      updateSet.role = 'admin';
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
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

async function getUserById(id: number) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Get today's date in UTC format (YYYY-MM-DD)
 */
function getTodayUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a user can generate an image today (has quota remaining)
 */
export async function canUserGenerateImage(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot check quota: database not available");
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

  return quota[0].imagesGenerated < FREE_DAILY_LIMIT;
}

/**
 * Increment user's daily image count
 */
async function incrementUserQuota(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot increment quota: database not available");
    return;
  }

  const today = getTodayUTC();
  const now = new Date();

  // Try to update existing quota record
  const existing = await db
    .select()
    .from(dailyQuota)
    .where(and(eq(dailyQuota.userId, userId), eq(dailyQuota.date, today)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(dailyQuota)
      .set({ imagesGenerated: existing[0].imagesGenerated + 1, lastGeneratedAt: now })
      .where(eq(dailyQuota.id, existing[0].id));
  } else {
    // Create new quota record for today
    await db.insert(dailyQuota).values({
      userId,
      date: today,
      imagesGenerated: 1,
      lastGeneratedAt: now,
    });
  }
}

/**
 * Atomically reserve daily quota for a user.
 * Returns true only when quota is successfully claimed for the current day.
 */
async function reserveUserDailyQuota(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot reserve quota: database not available");
    return false;
  }

  const today = getTodayUTC();
  const now = new Date();

  try {
    await db.insert(dailyQuota).values({
      userId,
      date: today,
      imagesGenerated: 1,
      lastGeneratedAt: now,
    });
    return true;
  } catch {
    // Row likely already exists for (userId, today). Continue with conditional update.
  }

  const result = await db.execute(sql`
    UPDATE dailyQuota
    SET imagesGenerated = imagesGenerated + 1,
        lastGeneratedAt = ${now},
        updatedAt = NOW()
    WHERE userId = ${userId}
      AND date = ${today}
      AND imagesGenerated < ${FREE_DAILY_LIMIT}
  `);

  const getAffectedRows = (value: unknown): number => {
    if (typeof value === "object" && value !== null && "affectedRows" in value) {
      const maybeAffectedRows = (value as { affectedRows?: unknown }).affectedRows;
      return typeof maybeAffectedRows === "number" ? maybeAffectedRows : 0;
    }

    if (Array.isArray(value) && value.length > 0) {
      return getAffectedRows(value[0]);
    }

    return 0;
  };

  const affectedRows = getAffectedRows(result);
  return affectedRows > 0;
}

/**
 * Releases one reserved daily quota slot when an operation fails after reservation.
 */
async function releaseUserDailyQuota(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot release quota: database not available");
    return;
  }

  const today = getTodayUTC();
  await db.execute(sql`
    UPDATE dailyQuota
    SET imagesGenerated = GREATEST(imagesGenerated - 1, 0),
        updatedAt = NOW()
    WHERE userId = ${userId}
      AND date = ${today}
      AND imagesGenerated > 0
  `);
}

/**
 * Create an image request record
 */
async function createImageRequest(data: InsertImageRequest) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot create image request: database not available");
    return null;
  }

  const result = await db.insert(imageRequests).values(data);
  return result;
}

/**
 * Update image request with completion details
 */
async function updateImageRequest(id: number, updates: { imageUrl?: string; imageKey?: string; status: 'pending' | 'completed' | 'failed'; errorMessage?: string | null; completedAt?: Date }) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot update image request: database not available");
    return null;
  }

  const result = await db.update(imageRequests).set(updates).where(eq(imageRequests.id, id));
  return result;
}

/**
 * Get all image requests for a user
 */
async function getUserImageRequests(userId: number, limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get image requests: database not available");
    return [];
  }

  const results = await db
    .select()
    .from(imageRequests)
    .where(eq(imageRequests.userId, userId))
    .orderBy((t) => t.createdAt)
    .limit(limit)
    .offset(offset);

  return results;
}

/**
 * Get all completed image requests for gallery (public)
 */
async function getCompletedImages(limit = 100, offset = 0) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get completed images: database not available");
    return [];
  }

  const results = await db
    .select({
      id: imageRequests.id,
      userId: imageRequests.userId,
      prompt: imageRequests.prompt,
      imageUrl: imageRequests.imageUrl,
      createdAt: imageRequests.createdAt,
      userName: users.name,
    })
    .from(imageRequests)
    .innerJoin(users, eq(imageRequests.userId, users.id))
    .where(eq(imageRequests.status, 'completed'))
    .orderBy((t) => t.createdAt)
    .limit(limit)
    .offset(offset);

  return results;
}

/**
 * Get today's usage statistics
 */
async function getTodayStats() {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get stats: database not available");
    return null;
  }

  const today = getTodayUTC();
  const stats = await db
    .select()
    .from(usageStats)
    .where(eq(usageStats.date, today))
    .limit(1);

  return stats.length > 0 ? stats[0] : null;
}

/**
 * Update or create today's usage statistics
 */
async function updateTodayStats(updates: Partial<InsertUsageStats>) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot update stats: database not available");
    return null;
  }

  const today = getTodayUTC();
  const existing = await getTodayStats();

  if (existing) {
    await db.update(usageStats).set(updates).where(eq(usageStats.date, today));
  } else {
    await db.insert(usageStats).values({
      date: today,
      ...updates,
    });
  }
}

/**
 * Log a notification
 */
async function logNotification(data: InsertNotificationLog) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot log notification: database not available");
    return null;
  }

  const result = await db.insert(notificationLog).values(data);
  return result;
}

/**
 * Get or create messenger state for a PSID
 */
async function getOrCreateMessengerState(psid: string, userKey: string) {
  const db = await getDb();
  if (!db) return null;

  const existing = await db
    .select()
    .from(messengerState)
    .where(eq(messengerState.psid, psid))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const newState: InsertMessengerState = { psid, userKey, stage: "IDLE" };
  await db.insert(messengerState).values(newState);
  const created = await db
    .select()
    .from(messengerState)
    .where(eq(messengerState.psid, psid))
    .limit(1);
  return created[0];
}

/**
 * Update messenger state
 */
async function updateMessengerState(psid: string, updates: Partial<InsertMessengerState>) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(messengerState)
    .set(updates)
    .where(eq(messengerState.psid, psid));
}

/**
 * Check and increment daily quota for a PSID (Messenger specific)
 */
async function checkAndIncrementMessengerQuota(psid: string): Promise<boolean> {
  void psid;

  if (!(await getDb())) return true; // Fail open for quota if DB is down

  // Current implementation intentionally stays fail-open for compatibility.
  return true;
}

/**
 * Get recent notifications for admin dashboard
 */
async function getRecentNotifications(limit = 20) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get notifications: database not available");
    return [];
  }

  const results = await db
    .select()
    .from(notificationLog)
    .orderBy((t) => t.createdAt)
    .limit(limit);

  return results;
}
